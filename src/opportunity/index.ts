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
  private cooldownMs = 5000; // min 5s between detections — avoid overtrading
  private lastMovementLogAt = 0; // throttle movement debug logs

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
   * Evaluate current conditions and return an Opportunity
   * (which may be rejected if filters don't pass).
   */
  evaluate(): Opportunity | null {
    const log = createModuleLogger('opportunity');
    const now = Date.now();

    // Cooldown
    if (now - this.lastDetectedAt < this.cooldownMs) {
      return null;
    }

    const currentPrice = this.externalFeed.getCurrentPrice();
    const book = this.marketData.getCurrentBook();

    if (!currentPrice || !book) {
      return null; // Not enough data yet
    }

    // --- 1. External movement detection ---
    const priceNSecsAgo = this.externalFeed.getPriceSecondsAgo(10);
    if (!priceNSecsAgo) return null;

    const movementPct = ((currentPrice - priceNSecsAgo) / priceNSecsAgo) * 100;
    const absMovement = Math.abs(movementPct);

    const reasons: string[] = [];
    const rejectionReasons: string[] = [];
    let rejected = false;

    // Filter 1: Minimum movement
    if (absMovement < this.params.minMovementPct) {
      // Log every 30s so user can see what movements are happening
      if (now - this.lastMovementLogAt > 30000) {
        this.lastMovementLogAt = now;
        log.debug('Movement below threshold', {
          movement: `${movementPct.toFixed(4)}%`,
          threshold: `${this.params.minMovementPct}%`,
          price: currentPrice,
        });
      }
      return null;
    }

    reasons.push(`External move: ${movementPct > 0 ? '+' : ''}${movementPct.toFixed(3)}% in 10s`);

    // --- 2. Multi-timeframe momentum confirmation ---
    // Check movement direction consistency across 3s, 10s, and 20s
    const price3sAgo = this.externalFeed.getPriceSecondsAgo(3);
    const price20sAgo = this.externalFeed.getPriceSecondsAgo(20);
    let persistenceConfirmed = false;
    let momentumScore = 0;

    // 3s momentum (short-term confirmation)
    if (price3sAgo) {
      const move3s = ((currentPrice - price3sAgo) / price3sAgo) * 100;
      if (Math.sign(move3s) === Math.sign(movementPct) && Math.abs(move3s) >= this.params.persistenceMinPct) {
        momentumScore++;
        persistenceConfirmed = true;
      }
    }

    // 10s momentum (already checked as main movement)
    momentumScore++; // main movement already passed threshold

    // 20s momentum (longer-term trend)
    if (price20sAgo) {
      const move20s = ((currentPrice - price20sAgo) / price20sAgo) * 100;
      if (Math.sign(move20s) === Math.sign(movementPct) && Math.abs(move20s) >= this.params.minMovementPct) {
        momentumScore++;
      }
    }

    reasons.push(`Momentum: ${momentumScore}/3 timeframes aligned`);

    // Require at least 2/3 timeframes aligned
    if (momentumScore < 2) {
      return null; // Not enough momentum confirmation
    }

    // --- 3. Determine direction ---
    // Price UP externally → market should price YES higher → BUY YES
    // Price DOWN externally → market should price YES lower → BUY NO (or SELL YES)
    const outcome = movementPct > 0 ? MarketOutcome.YES : MarketOutcome.NO;
    const side = TradeSide.BUY;
    const suggestedEntryPrice = outcome === MarketOutcome.YES
      ? book.bestAsk
      : (1 - book.bestBid); // NO price is (1 - YES bid)

    // --- 4. Spread filter ---
    const spreadBps = book.spread * 10000; // convert to basis points
    if (spreadBps > this.params.maxSpreadBps) {
      rejectionReasons.push(`Spread too wide: ${spreadBps.toFixed(0)} bps (max ${this.params.maxSpreadBps})`);
      rejected = true;
    } else {
      reasons.push(`Spread OK: ${spreadBps.toFixed(0)} bps`);
    }

    // --- 5. Liquidity filter ---
    const liquidity = this.marketData.getLiquidityWithinCents(3);
    const relevantLiquidity = outcome === MarketOutcome.YES
      ? liquidity.askLiquidity
      : liquidity.bidLiquidity;

    if (relevantLiquidity < this.params.minLiquidityUsd) {
      rejectionReasons.push(
        `Low liquidity: $${relevantLiquidity.toFixed(2)} (min $${this.params.minLiquidityUsd})`
      );
      rejected = true;
    } else {
      reasons.push(`Liquidity OK: $${relevantLiquidity.toFixed(2)}`);
    }

    // --- 6. Entry price filter ---
    if (outcome === MarketOutcome.YES && suggestedEntryPrice > this.params.maxEntryPriceYes) {
      rejectionReasons.push(
        `YES price too high: ${suggestedEntryPrice.toFixed(3)} (max ${this.params.maxEntryPriceYes})`
      );
      rejected = true;
    }
    if (outcome === MarketOutcome.NO && suggestedEntryPrice < this.params.minEntryPriceNo) {
      rejectionReasons.push(
        `NO price too low: ${suggestedEntryPrice.toFixed(3)} (min ${this.params.minEntryPriceNo})`
      );
      rejected = true;
    }

    // --- 7. Score calculation ---
    // Weighted: movement (30), momentum (25), spread (15), liquidity (15), price (15)
    let score = 0;

    // Movement score: linear from minMovement to 3x min = 0-30
    const movementScore = Math.min(30, (absMovement / (this.params.minMovementPct * 3)) * 30);
    score += movementScore;

    // Momentum score: 2/3 = 12pts, 3/3 = 25pts (big bonus for full alignment)
    const momentumPts = momentumScore === 3 ? 25 : 12;
    score += momentumPts;

    // Spread score: narrow = good. 0 spread = 15, max spread = 0
    const spreadScore = Math.max(0, 15 * (1 - spreadBps / this.params.maxSpreadBps));
    score += spreadScore;

    // Liquidity score: more = better, capped at 2x min = 15
    const liqScore = Math.min(15, (relevantLiquidity / (this.params.minLiquidityUsd * 2)) * 15);
    score += liqScore;

    // Price score: mid-range = best (15), extremes = 0
    const priceDistance = Math.abs(suggestedEntryPrice - 0.5);
    const priceScore = Math.max(0, 15 * (1 - priceDistance / 0.5));
    score += priceScore;

    score = Math.round(score);

    // Suggested stake: proportional to score, capped by config
    const maxStake = this.config.risk.maxStakePerTrade;
    const suggestedStake = Math.round(maxStake * (score / 100) * 100) / 100;

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
      suggestedStake: Math.max(1, suggestedStake), // minimum $1
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
        spread: spreadBps.toFixed(0),
        liquidity: relevantLiquidity,
        stake: suggestedStake,
      });
    }

    return opportunity;
  }
}
