// ============================================================
// Opportunity Detector
//
// Analyzes external price movement + Polymarket book state
// to produce a scored opportunity (0-100).
//
// Filters applied in order:
// 1. External movement magnitude (minimum threshold)
// 2. Movement persistence (confirmed over N seconds)
// 3. Spread filter (max acceptable spread)
// 4. Liquidity filter (minimum depth near mid)
// 5. Entry price filter (avoid buying near extremes)
//
// This is NOT a guarantee of edge. It's a structured way to
// filter noise and score conditions. Real edge requires
// backtesting with historical data — which this system
// supports via comprehensive logging.
// ============================================================

import { createModuleLogger } from '../logger';
import { ExternalPriceFeed } from '../external-feed';
import { PolymarketDataClient } from '../market-data';
import {
  Opportunity,
  MarketOutcome,
  TradeSide,
  AppConfig,
} from '../types';

/** Tunable thresholds — all documented, no magic numbers */
interface DetectorParams {
  /** Minimum external price movement to consider (%) */
  minMovementPct: number;
  /** Seconds to wait for persistence confirmation */
  persistenceWindowSec: number;
  /** Minimum % movement that must persist */
  persistenceMinPct: number;
  /** Maximum spread in basis points (100 bps = 1 cent on a $1 market) */
  maxSpreadBps: number;
  /** Minimum liquidity within 3 cents of mid (in USDC) */
  minLiquidityUsd: number;
  /** Max entry price for YES outcome (avoid buying near 0.95+) */
  maxEntryPriceYes: number;
  /** Min entry price for NO outcome (avoid buying near 0.05-) */
  minEntryPriceNo: number;
}

const DEFAULT_PARAMS: DetectorParams = {
  minMovementPct: 0.03,       // ~$21 BTC move in 10s — filters noise but still catchable
  persistenceWindowSec: 3,    // 3s persistence window
  persistenceMinPct: 0.015,   // Movement must persist at least 0.015%
  maxSpreadBps: 600,          // 6 cent spread max
  minLiquidityUsd: 20,        // Reasonable minimum
  maxEntryPriceYes: 0.95,     // Avoid extreme prices
  minEntryPriceNo: 0.05,      // Avoid extreme prices
};

export class OpportunityDetector {
  private config: AppConfig;
  private params: DetectorParams;
  private externalFeed: ExternalPriceFeed;
  private marketData: PolymarketDataClient;
  private lastDetectedAt = 0;
  private cooldownMs = 5000;
  private lastMovementLogAt = 0;

  constructor(
    config: AppConfig,
    externalFeed: ExternalPriceFeed,
    marketData: PolymarketDataClient,
    params?: Partial<DetectorParams>
  ) {
    this.config = config;
    this.externalFeed = externalFeed;
    this.marketData = marketData;
    this.params = { ...DEFAULT_PARAMS, ...params };
  }

  /**
   * Calculate rolling volatility over recent price history.
   * Returns annualized-style vol but for our purposes we just
   * use it as a relative measure (higher = more volatile).
   */
  private calculateVolatility(): number {
    const prices = this.externalFeed.getRecentPrices(30); // last 30s
    if (prices.length < 10) return 0;

    // Calculate returns
    const returns: number[] = [];
    for (let i = 1; i < prices.length; i++) {
      const ret = (prices[i].price - prices[i - 1].price) / prices[i - 1].price;
      returns.push(ret);
    }

    // Standard deviation of returns
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / returns.length;
    return Math.sqrt(variance) * 100; // as percentage
  }

  /**
   * Detect choppy (ranging) market by counting direction changes.
   * More reversals = choppier = worse for trend-following.
   */
  private getChopScore(): number {
    const prices = this.externalFeed.getRecentPrices(30);
    if (prices.length < 5) return 0;

    let directionChanges = 0;
    let lastDirection = 0;

    for (let i = 1; i < prices.length; i++) {
      const diff = prices[i].price - prices[i - 1].price;
      if (diff === 0) continue;
      const direction = diff > 0 ? 1 : -1;
      if (lastDirection !== 0 && direction !== lastDirection) {
        directionChanges++;
      }
      lastDirection = direction;
    }

    // Normalize: direction changes per sample (0 = trending, 1 = max chop)
    return directionChanges / Math.max(1, prices.length - 1);
  }

  /**
   * Calculate acceleration: is the movement speeding up or slowing down?
   * Compares recent rate of change vs older rate of change.
   * Positive = accelerating in trade direction. Negative = decelerating.
   */
  private getAcceleration(movementDirection: number): number {
    const now = this.externalFeed.getCurrentPrice();
    const p3s = this.externalFeed.getPriceSecondsAgo(3);
    const p6s = this.externalFeed.getPriceSecondsAgo(6);
    const p10s = this.externalFeed.getPriceSecondsAgo(10);

    if (!now || !p3s || !p6s || !p10s) return 0;

    // Rate of change: recent 3s vs older 3s (6s→3s)
    const recentRate = ((now - p3s) / p3s) * 100; // last 3s
    const olderRate = ((p6s - p10s) / p10s) * 100; // 10s→6s ago

    // Both rates in the direction of the movement
    const recentDirectional = recentRate * movementDirection;
    const olderDirectional = olderRate * movementDirection;

    // Acceleration = recent rate - older rate (positive = speeding up)
    return recentDirectional - olderDirectional;
  }

  evaluate(): Opportunity | null {
    const log = createModuleLogger('opportunity');
    const now = Date.now();

    if (now - this.lastDetectedAt < this.cooldownMs) {
      return null;
    }

    const currentPrice = this.externalFeed.getCurrentPrice();
    const book = this.marketData.getCurrentBook();

    if (!currentPrice || !book) return null;

    // --- 1. External movement detection ---
    const priceNSecsAgo = this.externalFeed.getPriceSecondsAgo(10);
    if (!priceNSecsAgo) return null;

    const movementPct = ((currentPrice - priceNSecsAgo) / priceNSecsAgo) * 100;
    const absMovement = Math.abs(movementPct);
    const movementDirection = movementPct > 0 ? 1 : -1;

    // --- VOLATILITY-ADJUSTED THRESHOLD ---
    // In high volatility, require larger moves to filter noise
    const vol = this.calculateVolatility();
    const volMultiplier = vol > 0 ? Math.max(1.0, Math.min(3.0, vol / 0.005)) : 1.0;
    const dynamicThreshold = this.params.minMovementPct * volMultiplier;

    const reasons: string[] = [];
    const rejectionReasons: string[] = [];
    let rejected = false;

    if (absMovement < dynamicThreshold) {
      if (now - this.lastMovementLogAt > 30000) {
        this.lastMovementLogAt = now;
        log.debug('Movement below dynamic threshold', {
          movement: `${movementPct.toFixed(4)}%`,
          threshold: `${dynamicThreshold.toFixed(4)}%`,
          volatility: `${vol.toFixed(5)}%`,
          volMultiplier: volMultiplier.toFixed(2),
        });
      }
      return null;
    }

    reasons.push(`Move: ${movementPct > 0 ? '+' : ''}${movementPct.toFixed(3)}% (thr: ${dynamicThreshold.toFixed(3)}%)`);

    // --- 2. ANTI-CHOP FILTER ---
    const chopScore = this.getChopScore();
    if (chopScore > 0.6) {
      // Market is too choppy — more than 60% of ticks are reversals
      return null;
    }
    reasons.push(`Chop: ${(chopScore * 100).toFixed(0)}%`);

    // --- 3. ACCELERATION CHECK ---
    const acceleration = this.getAcceleration(movementDirection);
    const isAccelerating = acceleration > 0;
    reasons.push(`Accel: ${acceleration > 0 ? '+' : ''}${acceleration.toFixed(4)}% ${isAccelerating ? '↑' : '↓'}`);

    // --- 4. Multi-timeframe momentum confirmation ---
    const price3sAgo = this.externalFeed.getPriceSecondsAgo(3);
    const price20sAgo = this.externalFeed.getPriceSecondsAgo(20);
    let persistenceConfirmed = false;
    let momentumScore = 0;

    if (price3sAgo) {
      const move3s = ((currentPrice - price3sAgo) / price3sAgo) * 100;
      if (Math.sign(move3s) === Math.sign(movementPct) && Math.abs(move3s) >= this.params.persistenceMinPct) {
        momentumScore++;
        persistenceConfirmed = true;
      }
    }

    momentumScore++; // 10s already passed

    if (price20sAgo) {
      const move20s = ((currentPrice - price20sAgo) / price20sAgo) * 100;
      if (Math.sign(move20s) === Math.sign(movementPct) && Math.abs(move20s) >= this.params.minMovementPct) {
        momentumScore++;
      }
    }

    reasons.push(`Momentum: ${momentumScore}/3`);

    // Require at least 2/3 timeframes aligned
    if (momentumScore < 2) {
      return null;
    }

    // --- 5. Determine direction ---
    const outcome = movementPct > 0 ? MarketOutcome.YES : MarketOutcome.NO;
    const side = TradeSide.BUY;
    const suggestedEntryPrice = outcome === MarketOutcome.YES
      ? book.bestAsk
      : (1 - book.bestBid);

    // --- 6. Spread filter ---
    const spreadBps = book.spread * 10000;
    if (spreadBps > this.params.maxSpreadBps) {
      rejectionReasons.push(`Spread: ${spreadBps.toFixed(0)} bps > ${this.params.maxSpreadBps}`);
      rejected = true;
    } else {
      reasons.push(`Spread: ${spreadBps.toFixed(0)} bps`);
    }

    // --- 7. Liquidity filter ---
    const liquidity = this.marketData.getLiquidityWithinCents(3);
    const relevantLiquidity = outcome === MarketOutcome.YES
      ? liquidity.askLiquidity
      : liquidity.bidLiquidity;

    if (relevantLiquidity < this.params.minLiquidityUsd) {
      rejectionReasons.push(`Liquidity: $${relevantLiquidity.toFixed(0)} < $${this.params.minLiquidityUsd}`);
      rejected = true;
    } else {
      reasons.push(`Liq: $${relevantLiquidity.toFixed(0)}`);
    }

    // --- 8. Entry price filter ---
    if (outcome === MarketOutcome.YES && suggestedEntryPrice > this.params.maxEntryPriceYes) {
      rejectionReasons.push(`YES price ${suggestedEntryPrice.toFixed(3)} > ${this.params.maxEntryPriceYes}`);
      rejected = true;
    }
    if (outcome === MarketOutcome.NO && suggestedEntryPrice < this.params.minEntryPriceNo) {
      rejectionReasons.push(`NO price ${suggestedEntryPrice.toFixed(3)} < ${this.params.minEntryPriceNo}`);
      rejected = true;
    }

    // --- 9. SCORING (0-100) ---
    // movement(25) + momentum(20) + acceleration(15) + chop(10) + spread(10) + liquidity(10) + price(10)
    let score = 0;

    // Movement: stronger move = higher score. Scale by how much it exceeds threshold
    const movementExcess = absMovement / dynamicThreshold; // 1.0 = just at threshold
    score += Math.min(25, (movementExcess - 1) * 25 + 10); // 10-25

    // Momentum: 2/3 = 10pts, 3/3 = 20pts
    score += momentumScore === 3 ? 20 : 10;

    // Acceleration: positive = 15pts, neutral = 5pts, decelerating = 0
    if (isAccelerating) {
      score += 15;
    } else if (acceleration > -0.005) {
      score += 5; // barely decelerating is OK
    }

    // Chop: lower = better. 0% chop = 10, 60% chop = 0
    score += Math.max(0, 10 * (1 - chopScore / 0.6));

    // Spread
    score += Math.max(0, 10 * (1 - spreadBps / this.params.maxSpreadBps));

    // Liquidity
    score += Math.min(10, (relevantLiquidity / (this.params.minLiquidityUsd * 2)) * 10);

    // Price distance from 0.50 (closer = better)
    const priceDistance = Math.abs(suggestedEntryPrice - 0.5);
    score += Math.max(0, 10 * (1 - priceDistance / 0.5));

    score = Math.round(Math.min(100, Math.max(0, score)));

    // Suggested stake: proportional to score
    const maxStake = this.config.risk.maxStakePerTrade;
    const suggestedStake = Math.max(1, Math.round(maxStake * (score / 100) * 100) / 100);

    const opportunity: Opportunity = {
      timestamp: now,
      marketId: this.config.polymarket.marketId || 'simulated',
      outcome,
      side,
      score,
      externalMovementPct: movementPct,
      persistenceConfirmed,
      spreadBps,
      liquidityUsd: relevantLiquidity,
      suggestedStake,
      suggestedEntryPrice,
      reasons,
      rejected,
      rejectionReasons,
    };

    this.lastDetectedAt = now;

    if (rejected) {
      log.debug('Opportunity REJECTED', {
        score,
        movement: movementPct.toFixed(3),
        rejections: rejectionReasons,
      });
    } else {
      log.info('Opportunity DETECTED', {
        score,
        outcome,
        movement: movementPct.toFixed(3),
        acceleration: acceleration.toFixed(4),
        chop: `${(chopScore * 100).toFixed(0)}%`,
        vol: vol.toFixed(5),
      });
    }

    return opportunity;
  }
}
