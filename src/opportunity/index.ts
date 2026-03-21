// ============================================================
// Opportunity Detector v3 — Probability-Based Edge
//
// Core insight: BTC Up/Down 5min markets resolve based on
// whether BTC is UP or DOWN at the end of a 5-minute window.
// The REAL edge is calculating the fair probability of UP/DOWN
// and comparing it to the current book price.
//
// When fair_prob(UP) = 70% but book prices YES at 55%,
// there's a 15% edge. THAT is a real trade.
//
// The old momentum approach was wrong — tiny BTC moves (0.03%)
// don't overcome spread costs. Probability-based entry only
// trades when the edge is mathematically clear.
//
// Filters: probability edge > spread cost + minimum threshold,
// momentum confirmation, anti-chop, acceleration.
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

/** Tunable thresholds */
interface DetectorParams {
  /** Minimum external price movement to consider (%) */
  minMovementPct: number;
  /** Minimum % movement that must persist (3s) */
  persistenceMinPct: number;
  /** Maximum spread in basis points */
  maxSpreadBps: number;
  /** Minimum liquidity within 3 cents of mid (USDC) */
  minLiquidityUsd: number;
  /** Max entry price for YES */
  maxEntryPriceYes: number;
  /** Min entry price for NO */
  minEntryPriceNo: number;
  /** Minimum probability edge after spread cost to trade (fraction, e.g. 0.03 = 3%) */
  minEdgeAfterCost: number;
}

const DEFAULT_PARAMS: DetectorParams = {
  minMovementPct: 0.03,
  persistenceMinPct: 0.015,
  maxSpreadBps: 600,
  minLiquidityUsd: 20,
  maxEntryPriceYes: 0.95,
  minEntryPriceNo: 0.05,
  minEdgeAfterCost: 0.03, // Need at least 3% edge after spread costs
};

/**
 * Normal CDF approximation (Abramowitz & Stegun).
 * Accurate to ~1.5e-7. Good enough for trading.
 */
function normalCDF(x: number): number {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1.0 / (1.0 + p * ax);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax / 2);
  return 0.5 * (1.0 + sign * y);
}

export class OpportunityDetector {
  private config: AppConfig;
  private params: DetectorParams;
  private externalFeed: ExternalPriceFeed;
  private marketData: PolymarketDataClient;
  private lastDetectedAt = 0;
  private cooldownMs = 3000; // 3s cooldown — we're more selective now
  private lastMovementLogAt = 0;

  /** Window context for probability calculation */
  private windowRefPrice: number | null = null;
  private windowEndMs: number | null = null;

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

  /** Called by strategy engine when a new window starts */
  setWindowContext(refPrice: number, windowEndMs: number): void {
    this.windowRefPrice = refPrice;
    this.windowEndMs = windowEndMs;
  }

  /**
   * Estimate per-second volatility from recent price data.
   * Groups prices into 1-second buckets, calculates return std dev.
   */
  private estimateVolPerSecond(): number {
    const prices = this.externalFeed.getRecentPrices(30);
    if (prices.length < 20) return 0;

    // Group by second, take last price of each second
    const buckets: Map<number, number> = new Map();
    for (const entry of prices) {
      const sec = Math.floor(entry.timestamp / 1000);
      buckets.set(sec, entry.price);
    }

    const secondPrices = Array.from(buckets.entries())
      .sort((a, b) => a[0] - b[0])
      .map(e => e[1]);

    if (secondPrices.length < 5) return 0;

    // Per-second returns
    const returns: number[] = [];
    for (let i = 1; i < secondPrices.length; i++) {
      returns.push((secondPrices[i] - secondPrices[i - 1]) / secondPrices[i - 1]);
    }

    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / returns.length;
    return Math.sqrt(variance);
  }

  /**
   * Calculate the FAIR probability that BTC will be UP at window end.
   * Uses the current BTC position vs reference and remaining time.
   *
   * Model: BTC follows random walk with estimated volatility.
   * P(UP at expiry) = Φ(currentReturn / (σ * √timeRemaining))
   */
  private calculateFairProbability(): { fairProbUp: number; zScore: number; volPerSec: number } | null {
    if (!this.windowRefPrice || !this.windowEndMs) return null;

    const currentPrice = this.externalFeed.getCurrentPrice();
    if (!currentPrice) return null;

    const btcReturn = (currentPrice - this.windowRefPrice) / this.windowRefPrice;
    const timeRemainingS = Math.max(1, (this.windowEndMs - Date.now()) / 1000);

    const volPerSec = this.estimateVolPerSecond();
    if (volPerSec <= 0) return null;

    const expectedFurtherVol = volPerSec * Math.sqrt(timeRemainingS);
    if (expectedFurtherVol <= 0) return null;

    const zScore = btcReturn / expectedFurtherVol;
    const fairProbUp = normalCDF(zScore);

    return { fairProbUp, zScore, volPerSec };
  }

  /**
   * Anti-chop: count direction changes in last 30s.
   * High chop = trending is unreliable.
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
    return directionChanges / Math.max(1, prices.length - 1);
  }

  evaluate(): Opportunity | null {
    const log = createModuleLogger('opportunity');
    const now = Date.now();

    if (now - this.lastDetectedAt < this.cooldownMs) return null;

    const currentPrice = this.externalFeed.getCurrentPrice();
    const book = this.marketData.getCurrentBook();
    if (!currentPrice || !book) return null;

    // --- 1. Basic movement check (gate) ---
    const priceNSecsAgo = this.externalFeed.getPriceSecondsAgo(10);
    if (!priceNSecsAgo) return null;

    const movementPct = ((currentPrice - priceNSecsAgo) / priceNSecsAgo) * 100;
    const absMovement = Math.abs(movementPct);

    if (absMovement < this.params.minMovementPct) {
      if (now - this.lastMovementLogAt > 30000) {
        this.lastMovementLogAt = now;
        log.debug('Movement below threshold', {
          movement: `${movementPct.toFixed(4)}%`,
          threshold: `${this.params.minMovementPct}%`,
        });
      }
      return null;
    }

    const reasons: string[] = [];
    const rejectionReasons: string[] = [];
    let rejected = false;

    reasons.push(`Move: ${movementPct > 0 ? '+' : ''}${movementPct.toFixed(3)}% 10s`);

    // --- 2. Anti-chop filter ---
    const chopScore = this.getChopScore();
    if (chopScore > 0.6) return null;
    reasons.push(`Chop: ${(chopScore * 100).toFixed(0)}%`);

    // --- 3. Momentum confirmation (2/3 timeframes) ---
    const price3sAgo = this.externalFeed.getPriceSecondsAgo(3);
    const price20sAgo = this.externalFeed.getPriceSecondsAgo(20);
    let momentumScore = 1; // 10s already passed
    let persistenceConfirmed = false;

    if (price3sAgo) {
      const move3s = ((currentPrice - price3sAgo) / price3sAgo) * 100;
      if (Math.sign(move3s) === Math.sign(movementPct) && Math.abs(move3s) >= this.params.persistenceMinPct) {
        momentumScore++;
        persistenceConfirmed = true;
      }
    }
    if (price20sAgo) {
      const move20s = ((currentPrice - price20sAgo) / price20sAgo) * 100;
      if (Math.sign(move20s) === Math.sign(movementPct) && Math.abs(move20s) >= this.params.minMovementPct) {
        momentumScore++;
      }
    }

    if (momentumScore < 2) return null;
    reasons.push(`Mom: ${momentumScore}/3`);

    // --- 4. Determine direction ---
    const outcome = movementPct > 0 ? MarketOutcome.YES : MarketOutcome.NO;
    const side = TradeSide.BUY;
    const suggestedEntryPrice = outcome === MarketOutcome.YES
      ? book.bestAsk
      : (1 - book.bestBid);

    // --- 5. Spread filter ---
    const spreadBps = book.spread * 10000;
    if (spreadBps > this.params.maxSpreadBps) {
      rejectionReasons.push(`Spread: ${spreadBps.toFixed(0)}bps > ${this.params.maxSpreadBps}`);
      rejected = true;
    }

    // --- 6. Liquidity filter ---
    const liquidity = this.marketData.getLiquidityWithinCents(3);
    const relevantLiquidity = outcome === MarketOutcome.YES
      ? liquidity.askLiquidity : liquidity.bidLiquidity;

    if (relevantLiquidity < this.params.minLiquidityUsd) {
      rejectionReasons.push(`Liq: $${relevantLiquidity.toFixed(0)} < $${this.params.minLiquidityUsd}`);
      rejected = true;
    }

    // --- 7. Entry price filter ---
    if (outcome === MarketOutcome.YES && suggestedEntryPrice > this.params.maxEntryPriceYes) {
      rejectionReasons.push(`YES price ${suggestedEntryPrice.toFixed(3)} > ${this.params.maxEntryPriceYes}`);
      rejected = true;
    }
    if (outcome === MarketOutcome.NO && suggestedEntryPrice < this.params.minEntryPriceNo) {
      rejectionReasons.push(`NO price ${suggestedEntryPrice.toFixed(3)} < ${this.params.minEntryPriceNo}`);
      rejected = true;
    }

    // --- 8. PROBABILITY-BASED EDGE (the core edge) ---
    const prob = this.calculateFairProbability();
    let probabilityEdge = 0;
    let fairProbDisplay = 'N/A';

    if (prob) {
      const { fairProbUp, zScore } = prob;
      fairProbDisplay = `${(fairProbUp * 100).toFixed(1)}%`;

      // Calculate edge: difference between fair probability and book price
      if (outcome === MarketOutcome.YES) {
        // We're buying YES — edge = fairProbUp - what we pay
        probabilityEdge = fairProbUp - suggestedEntryPrice;
      } else {
        // We're buying NO — edge = fairProbDown - what we pay
        probabilityEdge = (1 - fairProbUp) - suggestedEntryPrice;
      }

      // Spread cost as fraction of entry
      const spreadCostFraction = book.spread * 0.75; // approximate round-trip cost

      const netEdge = probabilityEdge - spreadCostFraction;

      reasons.push(`Fair: ${fairProbDisplay} | z: ${zScore.toFixed(2)} | Edge: ${(probabilityEdge * 100).toFixed(1)}% | Net: ${(netEdge * 100).toFixed(1)}%`);

      // Reject if insufficient edge after costs
      if (netEdge < this.params.minEdgeAfterCost) {
        rejectionReasons.push(`Edge too small: ${(netEdge * 100).toFixed(1)}% < ${(this.params.minEdgeAfterCost * 100).toFixed(0)}%`);
        rejected = true;
      }
    } else {
      // No probability data — still allow momentum-based trades but penalize score
      reasons.push('No prob data (momentum only)');
    }

    // --- 9. SCORING (0-100) ---
    let score = 0;

    // Probability edge: 0-40 points (dominant factor)
    if (probabilityEdge > 0) {
      score += Math.min(40, probabilityEdge * 100 * 4); // 10% edge = 40pts
    }

    // Movement strength: 0-15 points
    const volAdjustedMove = absMovement / Math.max(0.03, this.params.minMovementPct);
    score += Math.min(15, (volAdjustedMove - 1) * 10 + 5);

    // Momentum: 2/3 = 8pts, 3/3 = 15pts
    score += momentumScore === 3 ? 15 : 8;

    // Chop quality: 0-10 (lower chop = better)
    score += Math.max(0, 10 * (1 - chopScore / 0.6));

    // Spread quality: 0-10
    score += Math.max(0, 10 * (1 - spreadBps / this.params.maxSpreadBps));

    // Price position: 0-10 (closer to 0.50 = better)
    const priceDistance = Math.abs(suggestedEntryPrice - 0.5);
    score += Math.max(0, 10 * (1 - priceDistance / 0.5));

    score = Math.round(Math.min(100, Math.max(0, score)));

    // Stake: proportional to score
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
        fairProb: fairProbDisplay,
        edge: `${(probabilityEdge * 100).toFixed(1)}%`,
        rejections: rejectionReasons,
      });
    } else {
      log.info('Opportunity DETECTED', {
        score,
        outcome,
        movement: movementPct.toFixed(3),
        fairProb: fairProbDisplay,
        edge: `${(probabilityEdge * 100).toFixed(1)}%`,
        spread: spreadBps.toFixed(0),
      });
    }

    return opportunity;
  }
}
