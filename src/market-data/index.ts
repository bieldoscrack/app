// ============================================================
// Polymarket Market Data Client
//
// Fetches order book data from the Polymarket CLOB API.
// Uses REST polling (CLOB API provides REST endpoints).
// Parses order book into structured format with spread/mid.
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
  private baselineExternalPrice: number | null = null;

  constructor(config: AppConfig) {
    super();
    this.config = config;
  }

  /** Set a function to get the external price (for coupling simulated book to BTC) */
  setExternalPriceGetter(getter: () => number | null): void {
    this.externalPriceGetter = getter;
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
   * Simulated order book for paper trading when no market ID is set.
   *
   * COUPLED TO EXTERNAL FEED: The simulated midPrice tracks the external
   * BTC price proportionally. When BTC moves +0.1%, the simulated market
   * also moves ~+0.1% (with a small delay and noise). This ensures the
   * bot's signal detection actually correlates with market movement.
   *
   * Without this coupling, the bot would be trading random noise.
   */
  private startSimulatedBook(intervalMs: number): void {
    const log = createModuleLogger('market-data');
    log.info('Using SIMULATED order book (coupled to external feed)');

    this.connected = true;
    this.emit('connected');

    let midPrice = 0.50; // start at 50 cents

    this.pollInterval = setInterval(() => {
      // --- Coupled movement: follow external price changes ---
      let externalDrift = 0;
      if (this.externalPriceGetter) {
        const extPrice = this.externalPriceGetter();
        if (extPrice) {
          if (this.baselineExternalPrice === null) {
            this.baselineExternalPrice = extPrice;
          }
          // Calculate external price change as percentage
          const extChangePct = (extPrice - this.baselineExternalPrice) / this.baselineExternalPrice;
          // Apply 90% of external movement — high correlation for active markets
          externalDrift = extChangePct * 0.90;
          // Update baseline slowly to prevent drift accumulation
          this.baselineExternalPrice = this.baselineExternalPrice * 0.999 + extPrice * 0.001;
        }
      }

      // Small random noise: ±0.02% per tick (minimal)
      const noise = (Math.random() - 0.5) * 0.0004;

      // Base price (0.50) + external drift + noise
      midPrice = 0.50 + externalDrift + noise;
      midPrice = Math.max(0.05, Math.min(0.95, midPrice));

      const spread = 0.01; // 1 cent spread (realistic for active Polymarket markets)
      const bestBid = Math.round((midPrice - spread / 2) * 100) / 100;
      const bestAsk = Math.round((midPrice + spread / 2) * 100) / 100;

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
