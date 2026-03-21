// ============================================================
// Opportunity Detector v4 — Last-Second Maker Edge
//
// Strategy shift (2026 meta):
// - Wait until T-15s to T-3s before window end
// - At that point, ~85% of BTC direction is determined
// - Calculate fair probability using random walk model
// - Place MAKER limit order at 0.85-0.95 on the winning side
// - Zero taker fees + maker rebates = pure edge
//
// The edge:
// 1. Chainlink oracle updates every 10-30s (lag vs Binance)
// 2. Polymarket book lags behind fair probability
// 3. Late in the window, uncertainty is LOW = high conviction
// 4. Maker order = no fees, reduces effective spread to 0
// ============================================================

import { createModuleLogger } from '../logger';
import { ExternalPriceFeed } from '../external-feed';
import { PolymarketDataClient } from '../market-data';
import {
  Opportunity,
  MarketOutcome,
  TradeSide,
  OrderType,
  AppConfig,
} from '../types';

/** Tunable thresholds */
interface DetectorParams {
  /** Minimum probability edge to trade (fraction, e.g. 0.05 = 5%) */
  minProbabilityEdge: number;
  /** Minimum fair probability to consider a side (e.g. 0.60 = 60%) */
  minFairProbability: number;
  /** Maximum spread in basis points */
  maxSpreadBps: number;
  /** Minimum liquidity within 3 cents of mid (USDC) */
  minLiquidityUsd: number;
  /** Maker limit price: place order at this fraction of fair prob */
  makerPriceDiscount: number;
  /** Max chop score (0-1, lower = less choppy = better) */
  maxChopScore: number;
}

const DEFAULT_PARAMS: DetectorParams = {
  minProbabilityEdge: 0.08,   // Need at least 8% edge (better risk/reward)
  minFairProbability: 0.60,   // Fair prob must be > 60% on our side
  maxSpreadBps: 800,
  minLiquidityUsd: 15,
  makerPriceDiscount: 0.88,   // Place maker order at 88% of fair prob (more discount = better R/R)
  maxChopScore: 0.55,
};

/**
 * Normal CDF approximation (Abramowitz & Stegun).
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
  private cooldownMs = 2000;

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
   */
  private estimateVolPerSecond(): number {
    const prices = this.externalFeed.getRecentPrices(30);
    if (prices.length < 20) return 0;

    const buckets: Map<number, number> = new Map();
    for (const entry of prices) {
      const sec = Math.floor(entry.timestamp / 1000);
      buckets.set(sec, entry.price);
    }

    const secondPrices = Array.from(buckets.entries())
      .sort((a, b) => a[0] - b[0])
      .map(e => e[1]);

    if (secondPrices.length < 5) return 0;

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
   * P(UP at expiry) = Φ(currentReturn / (σ * √timeRemaining))
   *
   * Late in the window with a strong move → very high conviction.
   */
  calculateFairProbability(): {
    fairProbUp: number;
    zScore: number;
    volPerSec: number;
    timeRemainingS: number;
    btcReturn: number;
  } | null {
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

    return { fairProbUp, zScore, volPerSec, timeRemainingS, btcReturn };
  }

  /**
   * Get BTC % move over the last N seconds. Returns null if not enough data.
   */
  private getRecentMovePercent(seconds: number): number | null {
    const now = this.externalFeed.getCurrentPrice();
    const ago = this.externalFeed.getPriceSecondsAgo(seconds);
    if (!now || !ago) return null;
    return ((now - ago) / ago) * 100;
  }

  /**
   * Anti-chop: count direction changes in last 30s.
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

  /**
   * Evaluate for last-second maker opportunity.
   *
   * Only fires during the entry window (T-15s to T-3s by default).
   * Calculates fair probability and places maker order if edge is sufficient.
   */
  evaluate(): Opportunity | null {
    const log = createModuleLogger('opportunity');
    const now = Date.now();

    if (now - this.lastDetectedAt < this.cooldownMs) return null;

    // --- 1. Check timing: are we in the entry window? ---
    if (!this.windowEndMs) return null;
    const timeRemainingS = (this.windowEndMs - now) / 1000;

    const entryStart = this.config.timing.entryWindowStartS;
    const entryEnd = this.config.timing.entryWindowEndS;

    if (timeRemainingS > entryStart || timeRemainingS < entryEnd) {
      return null; // Not in entry window yet, or too late
    }

    const currentPrice = this.externalFeed.getCurrentPrice();
    const book = this.marketData.getCurrentBook();
    if (!currentPrice || !book) return null;

    const reasons: string[] = [];
    const rejectionReasons: string[] = [];
    let rejected = false;

    // --- 2. Calculate fair probability ---
    const prob = this.calculateFairProbability();
    if (!prob) return null;

    const { fairProbUp, zScore, timeRemainingS: tRemain, btcReturn } = prob;

    // Determine which side has the edge
    const fairProbDown = 1 - fairProbUp;
    const isUpFavored = fairProbUp >= fairProbDown;
    const fairProb = isUpFavored ? fairProbUp : fairProbDown;
    const outcome = isUpFavored ? MarketOutcome.YES : MarketOutcome.NO;

    reasons.push(`T-${tRemain.toFixed(0)}s | BTC: ${(btcReturn * 100).toFixed(3)}%`);
    reasons.push(`Fair: ${(fairProbUp * 100).toFixed(1)}% UP | z: ${zScore.toFixed(2)}`);

    // --- 3. Check minimum probability threshold ---
    if (fairProb < this.params.minFairProbability) {
      rejectionReasons.push(`Fair prob ${(fairProb * 100).toFixed(1)}% < ${(this.params.minFairProbability * 100).toFixed(0)}% min`);
      rejected = true;
    }

    // --- 4. Calculate edge vs book ---
    // Book price for our side
    const bookPrice = outcome === MarketOutcome.YES
      ? book.bestAsk  // cost to buy YES as taker
      : (1 - book.bestBid);  // cost to buy NO as taker

    const probabilityEdge = fairProb - bookPrice;
    reasons.push(`Edge: ${(probabilityEdge * 100).toFixed(1)}% (fair ${(fairProb * 100).toFixed(1)}% vs book ${(bookPrice * 100).toFixed(1)}%)`);

    if (probabilityEdge < this.params.minProbabilityEdge) {
      rejectionReasons.push(`Edge ${(probabilityEdge * 100).toFixed(1)}% < ${(this.params.minProbabilityEdge * 100).toFixed(0)}% min`);
      rejected = true;
    }

    // --- 4b. Mean reversion filter ---
    // If BTC moved too much too fast, it's likely to revert before settlement
    const btcMoveAbs = Math.abs(btcReturn) * 100; // in percent
    const recentMove3s = this.getRecentMovePercent(3);
    // Reject if: large move that's already decelerating (potential reversal)
    if (btcMoveAbs > 0.15 && recentMove3s !== null) {
      const isDecelerating = isUpFavored
        ? recentMove3s < -0.01  // BTC was up but last 3s it's dropping
        : recentMove3s > 0.01;  // BTC was down but last 3s it's rising
      if (isDecelerating) {
        rejectionReasons.push(`Mean reversion: BTC ${btcMoveAbs.toFixed(2)}% but last 3s ${recentMove3s > 0 ? '+' : ''}${recentMove3s.toFixed(3)}%`);
        rejected = true;
      }
    }

    // --- 5. Anti-chop filter ---
    const chopScore = this.getChopScore();
    if (chopScore > this.params.maxChopScore) {
      rejectionReasons.push(`Chop: ${(chopScore * 100).toFixed(0)}% > ${(this.params.maxChopScore * 100).toFixed(0)}%`);
      rejected = true;
    }
    reasons.push(`Chop: ${(chopScore * 100).toFixed(0)}%`);

    // --- 6. Spread filter ---
    const spreadBps = book.spread * 10000;
    if (spreadBps > this.params.maxSpreadBps) {
      rejectionReasons.push(`Spread: ${spreadBps.toFixed(0)}bps > ${this.params.maxSpreadBps}`);
      rejected = true;
    }

    // --- 7. Liquidity filter ---
    const liquidity = this.marketData.getLiquidityWithinCents(3);
    const relevantLiquidity = outcome === MarketOutcome.YES
      ? liquidity.askLiquidity : liquidity.bidLiquidity;

    if (relevantLiquidity < this.params.minLiquidityUsd) {
      rejectionReasons.push(`Liq: $${relevantLiquidity.toFixed(0)} < $${this.params.minLiquidityUsd}`);
      rejected = true;
    }

    // --- 8. Determine order type and entry price ---
    const orderType = this.config.fees.preferMaker ? OrderType.MAKER : OrderType.TAKER;
    let suggestedEntryPrice: number;

    if (orderType === OrderType.MAKER) {
      // Maker: place limit order at a discount to fair value
      // e.g., fair = 80%, we bid at 80% * 0.92 = 73.6 cents
      // This gives us better fill price and 0 fees + rebates
      suggestedEntryPrice = Math.round(fairProb * this.params.makerPriceDiscount * 1000) / 1000;
      // Clamp to reasonable range
      suggestedEntryPrice = Math.max(0.05, Math.min(0.95, suggestedEntryPrice));
      reasons.push(`Maker @ ${suggestedEntryPrice.toFixed(3)} (${((1 - this.params.makerPriceDiscount) * 100).toFixed(0)}% discount)`);
    } else {
      // Taker: buy at best ask
      suggestedEntryPrice = outcome === MarketOutcome.YES
        ? book.bestAsk
        : (1 - book.bestBid);
      reasons.push(`Taker @ ${suggestedEntryPrice.toFixed(3)}`);
    }

    // --- 9. Price bounds check ---
    if (suggestedEntryPrice > 0.85) {
      rejectionReasons.push(`Entry price ${suggestedEntryPrice.toFixed(3)} > 0.85 (bad R/R)`);
      rejected = true;
    }
    if (suggestedEntryPrice < 0.05) {
      rejectionReasons.push(`Entry price ${suggestedEntryPrice.toFixed(3)} too low`);
      rejected = true;
    }

    // --- 10. SCORING (0-100) ---
    let score = 0;

    // Probability conviction: 0-35 points (how sure is the direction)
    // fairProb of 0.90 → 30pts, 0.70 → 15pts, 0.60 → 7.5pts
    score += Math.min(35, (fairProb - 0.50) * 75);

    // Probability edge vs book: 0-25 points
    score += Math.min(25, Math.max(0, probabilityEdge * 100 * 2.5));

    // Time position: 0-15 points (later in window = more certain)
    // T-3s = 15pts, T-10s = 5pts, T-15s = 0pts
    const timeScore = Math.max(0, 15 * (1 - (tRemain - entryEnd) / (entryStart - entryEnd)));
    score += timeScore;

    // Chop quality: 0-10 (lower chop = better)
    score += Math.max(0, 10 * (1 - chopScore / this.params.maxChopScore));

    // Spread quality: 0-8
    score += Math.max(0, 8 * (1 - spreadBps / this.params.maxSpreadBps));

    // Z-score strength: 0-7 (how strong is the statistical signal)
    score += Math.min(7, Math.abs(zScore) * 2);

    score = Math.round(Math.min(100, Math.max(0, score)));

    // --- 11. Stake calculation ---
    const maxStake = this.config.risk.maxStakePerTrade;
    const suggestedStake = Math.max(1, Math.round(maxStake * (score / 100) * 100) / 100);

    // --- 12. BTC movement for logging ---
    const priceNSecsAgo = this.externalFeed.getPriceSecondsAgo(10);
    const movementPct = priceNSecsAgo
      ? ((currentPrice - priceNSecsAgo) / priceNSecsAgo) * 100
      : 0;

    const opportunity: Opportunity = {
      timestamp: now,
      marketId: this.config.polymarket.marketId || 'simulated',
      outcome,
      side: TradeSide.BUY,
      orderType,
      score,
      externalMovementPct: movementPct,
      persistenceConfirmed: Math.abs(zScore) > 1.0,
      spreadBps,
      liquidityUsd: relevantLiquidity,
      suggestedStake,
      suggestedEntryPrice,
      fairProbability: fairProb,
      probabilityEdge,
      timeRemainingS: tRemain,
      reasons,
      rejected,
      rejectionReasons,
    };

    this.lastDetectedAt = now;

    if (rejected) {
      log.debug('Opportunity REJECTED', {
        score,
        outcome,
        fairProb: `${(fairProb * 100).toFixed(1)}%`,
        edge: `${(probabilityEdge * 100).toFixed(1)}%`,
        timeRemaining: `${tRemain.toFixed(0)}s`,
        rejections: rejectionReasons,
      });
    } else {
      log.info('OPPORTUNITY DETECTED', {
        score,
        outcome,
        fairProb: `${(fairProb * 100).toFixed(1)}%`,
        edge: `${(probabilityEdge * 100).toFixed(1)}%`,
        entryPrice: suggestedEntryPrice,
        orderType,
        timeRemaining: `${tRemain.toFixed(0)}s`,
      });
    }

    return opportunity;
  }
}
