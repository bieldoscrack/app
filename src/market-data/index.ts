// ============================================================
// Polymarket Market Data Client
//
// Fetches order book data from the Polymarket CLOB API.
// Uses REST polling (CLOB API provides REST endpoints).
// Parses order book into structured format with spread/mid.
//
// SIMULATED BOOK v3 — Probability-Convergent Model:
// Instead of directly coupling to BTC price, the simulated book
// converges toward the FAIR PROBABILITY of UP/DOWN at window end.
// This models how real market makers adjust orders: they calculate
// fair value and move their quotes toward it, but with latency.
// The lag in convergence IS the edge we exploit.
//
// API Reference: https://docs.polymarket.com/
// ============================================================

import { EventEmitter } from 'events';
import { createModuleLogger } from '../logger';
import { AppConfig, ConnectionStatus, OrderBook, OrderBookLevel } from '../types';

/** Raw response shape from CLOB /book endpoint */
interface ClobBookResponse {
  market: string;
  asset_id: string;
  timestamp: string;
  bids: Array<{ price: string; size: string }>;
  asks: Array<{ price: string; size: string }>;
}

/**
 * Normal CDF approximation (Abramowitz & Stegun).
 * Used to calculate fair probability of UP/DOWN outcome.
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

export class PolymarketDataClient extends EventEmitter {
  private config: AppConfig;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private connected = false;
  private lastFetchTs: number | null = null;
  private latencyMs: number | null = null;
  private consecutiveErrors = 0;
  private currentBook: OrderBook | null = null;
  private shouldPoll = true;
  private externalPriceGetter: (() => number | null) | null = null;

  /** Price history for volatility estimation */
  private priceHistory: Array<{price: number, ts: number}> = [];

  /** Window context for fair probability calculation */
  private windowRefPrice: number | null = null;
  private windowEndMs: number | null = null;
  private lastWindowEndMs: number | null = null;

  /**
   * EMA convergence rate: controls how fast the book adjusts to fair value.
   * alpha = 0.20 → half-life ~6.5s at 2s poll interval.
   * Real Polymarket books adjust in ~5-15s, so this is realistic.
   */
  private readonly bookAlpha = 0.20;

  constructor(config: AppConfig) {
    super();
    this.config = config;
  }

  /** Set a function to get the external price (for coupling simulated book to BTC) */
  setExternalPriceGetter(getter: () => number | null): void {
    this.externalPriceGetter = getter;
  }

  /** Set window context for fair probability calculation */
  setWindowContext(refPrice: number, endMs: number): void {
    this.windowRefPrice = refPrice;
    this.windowEndMs = endMs;
  }

  /** Start polling the order book */
  start(pollIntervalMs = 2000): void {
    const log = createModuleLogger('market-data');
    log.info('Starting Polymarket data client', {
      clobUrl: this.config.polymarket.clobUrl,
      marketId: this.config.polymarket.marketId || '(not set)',
      pollIntervalMs,
    });

    this.shouldPoll = true;

    if (!this.config.polymarket.marketId) {
      log.warn(
        'No POLYMARKET_MARKET_ID set — market data will use simulated book. ' +
        'Set the market ID in .env to get real data.'
      );
      this.startSimulatedBook(pollIntervalMs);
      return;
    }

    this.pollInterval = setInterval(() => this.fetchBook(), pollIntervalMs);
    // Initial fetch
    this.fetchBook();
  }

  /** Fetch order book from CLOB API */
  private async fetchBook(): Promise<void> {
    const log = createModuleLogger('market-data');
    if (!this.shouldPoll) return;

    const url = `${this.config.polymarket.clobUrl}/book?token_id=${this.config.polymarket.marketId}`;
    const startTs = Date.now();

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = (await response.json()) as ClobBookResponse;
      this.latencyMs = Date.now() - startTs;
      this.lastFetchTs = Date.now();
      this.consecutiveErrors = 0;

      if (!this.connected) {
        this.connected = true;
        this.emit('connected');
        log.info('Polymarket CLOB API connected', { latencyMs: this.latencyMs });
      }

      const book = this.parseBook(data);
      this.currentBook = book;
      this.emit('book', book);
    } catch (err) {
      this.consecutiveErrors++;
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error('Failed to fetch order book', {
        error: errMsg,
        consecutiveErrors: this.consecutiveErrors,
      });

      if (this.consecutiveErrors >= 10) {
        log.error('Too many consecutive errors — marking disconnected');
        this.connected = false;
        this.emit('disconnected');
      }
    }
  }

  /** Parse raw CLOB response into our OrderBook type */
  private parseBook(data: ClobBookResponse): OrderBook {
    const bids: OrderBookLevel[] = (data.bids || [])
      .map((b) => ({ price: parseFloat(b.price), size: parseFloat(b.size) }))
      .filter((b) => !isNaN(b.price) && !isNaN(b.size))
      .sort((a, b) => b.price - a.price); // highest bid first

    const asks: OrderBookLevel[] = (data.asks || [])
      .map((a) => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
      .filter((a) => !isNaN(a.price) && !isNaN(a.size))
      .sort((a, b) => a.price - b.price); // lowest ask first

    const bestBid = bids.length > 0 ? bids[0].price : 0;
    const bestAsk = asks.length > 0 ? asks[0].price : 1;
    const spread = bestAsk - bestBid;
    const midPrice = (bestBid + bestAsk) / 2;

    return {
      marketId: this.config.polymarket.marketId,
      timestamp: Date.now(),
      bids,
      asks,
      bestBid,
      bestAsk,
      spread,
      midPrice,
    };
  }

  /**
   * Estimate per-second BTC volatility from recent price history.
   * Groups prices into 1-second buckets, computes std dev of returns.
   */
  private estimateVolPerSecond(): number {
    if (this.priceHistory.length < 20) return 0;

    const buckets: Map<number, number> = new Map();
    for (const entry of this.priceHistory) {
      const sec = Math.floor(entry.ts / 1000);
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
   * Calculate fair probability of BTC UP at window end.
   *
   * Model: BTC ≈ random walk with estimated per-second volatility.
   * P(UP at expiry) = Φ(currentReturn / (σ * √timeRemaining))
   *
   * Returns 0.50 when insufficient data or no window context.
   */
  private calculateFairProbability(): number {
    if (!this.windowRefPrice || !this.windowEndMs) return 0.50;

    const currentPrice = this.externalPriceGetter?.() ?? null;
    if (!currentPrice) return 0.50;

    const btcReturn = (currentPrice - this.windowRefPrice) / this.windowRefPrice;
    const timeRemainingS = Math.max(1, (this.windowEndMs - Date.now()) / 1000);

    const volPerSec = this.estimateVolPerSecond();
    if (volPerSec <= 0) return 0.50;

    const expectedFurtherVol = volPerSec * Math.sqrt(timeRemainingS);
    if (expectedFurtherVol <= 0) return 0.50;

    const zScore = btcReturn / expectedFurtherVol;
    return normalCDF(zScore);
  }

  /**
   * Simulated order book v3 — Probability-Convergent Model.
   *
   * Instead of direct BTC coupling, the book converges toward the
   * FAIR PROBABILITY of UP/DOWN using exponential moving average.
   *
   * This models real market behavior:
   * 1. BTC moves → fair probability shifts
   * 2. Market makers recalculate → adjust quotes (takes 5-15s)
   * 3. Book gradually converges to new fair value
   *
   * The LAG in convergence is the edge:
   * - Our detector calculates fair prob from CURRENT BTC (real-time)
   * - The book reflects fair prob from ~7s ago (EMA lag)
   * - When the difference > spread cost → profitable trade
   */
  private startSimulatedBook(intervalMs: number): void {
    const log = createModuleLogger('market-data');
    log.info('Using SIMULATED order book v3 (probability-convergent)');

    this.connected = true;
    this.emit('connected');

    let midPrice = 0.50; // start at 50/50

    this.pollInterval = setInterval(() => {
      // --- 1. Record BTC price for volatility estimation ---
      if (this.externalPriceGetter) {
        const extPrice = this.externalPriceGetter();
        if (extPrice) {
          const now = Date.now();
          this.priceHistory.push({ price: extPrice, ts: now });
          // Keep 60s of history for robust vol estimation
          while (this.priceHistory.length > 0 && this.priceHistory[0].ts < now - 60000) {
            this.priceHistory.shift();
          }
        }
      }

      // --- 2. Handle window transitions (snap to 0.50 on new window) ---
      if (this.windowEndMs !== this.lastWindowEndMs) {
        if (this.lastWindowEndMs !== null) {
          midPrice = 0.50; // New window → reset to 50/50
          log.debug('Window changed — book reset to 0.50');
        }
        this.lastWindowEndMs = this.windowEndMs;
      }

      // --- 3. Calculate fair probability and converge ---
      const fairProb = this.calculateFairProbability();

      // EMA convergence: book moves toward fair value each tick
      // alpha=0.20 → half-life ~6.5s → book is ~87% adjusted after 20s
      midPrice = midPrice * (1 - this.bookAlpha) + fairProb * this.bookAlpha;

      // Minimal noise (not perfectly deterministic)
      const noise = (Math.random() - 0.5) * 0.001;
      midPrice = Math.max(0.05, Math.min(0.95, midPrice + noise));

      // --- 4. Build order book with 0.5 cent spread ---
      const spread = 0.005;
      const bestBid = Math.round((midPrice - spread / 2) * 1000) / 1000;
      const bestAsk = Math.round((midPrice + spread / 2) * 1000) / 1000;

      // Generate depth levels
      const bids: OrderBookLevel[] = [];
      const asks: OrderBookLevel[] = [];
      for (let i = 0; i < 5; i++) {
        bids.push({
          price: Math.round((bestBid - i * 0.01) * 100) / 100,
          size: Math.round((50 + Math.random() * 200) * 100) / 100,
        });
        asks.push({
          price: Math.round((bestAsk + i * 0.01) * 100) / 100,
          size: Math.round((50 + Math.random() * 200) * 100) / 100,
        });
      }

      const book: OrderBook = {
        marketId: 'simulated',
        timestamp: Date.now(),
        bids,
        asks,
        bestBid,
        bestAsk,
        spread: bestAsk - bestBid,
        midPrice,
      };

      this.currentBook = book;
      this.lastFetchTs = Date.now();
      this.latencyMs = 0;
      this.emit('book', book);
    }, intervalMs);
  }

  /** Get current order book */
  getCurrentBook(): OrderBook | null {
    return this.currentBook;
  }

  /** Calculate available liquidity within N cents of mid */
  getLiquidityWithinCents(cents: number): { bidLiquidity: number; askLiquidity: number } {
    if (!this.currentBook) return { bidLiquidity: 0, askLiquidity: 0 };

    const threshold = cents / 100;
    const midPrice = this.currentBook.midPrice;

    // For binary markets, size is already in USDC notional
    const bidLiquidity = this.currentBook.bids
      .filter((b) => b.price >= midPrice - threshold)
      .reduce((sum, b) => sum + b.size, 0);

    const askLiquidity = this.currentBook.asks
      .filter((a) => a.price <= midPrice + threshold)
      .reduce((sum, a) => sum + a.size, 0);

    return {
      bidLiquidity: Math.round(bidLiquidity * 100) / 100,
      askLiquidity: Math.round(askLiquidity * 100) / 100,
    };
  }

  /** Get connection status */
  getConnectionStatus(): ConnectionStatus {
    return {
      source: 'polymarket',
      connected: this.connected,
      lastMessageTimestamp: this.lastFetchTs,
      reconnectCount: 0,
      latencyMs: this.latencyMs,
    };
  }

  /** Stop polling */
  stop(): void {
    const log = createModuleLogger('market-data');
    log.info('Stopping Polymarket data client');
    this.shouldPoll = false;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.connected = false;
  }
}
