// ============================================================
// External Price Feed — Binance WebSocket
//
// Connects to Binance's public trade stream for real-time price.
// Maintains a rolling price buffer for movement detection.
// Handles reconnection with exponential backoff.
// ============================================================

import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { createModuleLogger } from '../logger';
import { AppConfig, ConnectionStatus, ExternalPriceTick } from '../types';

/** Rolling price buffer entry */
interface PriceEntry {
  price: number;
  timestamp: number;
}

export class ExternalPriceFeed extends EventEmitter {
  private ws: WebSocket | null = null;
  private config: AppConfig;
  private connected = false;
  private reconnectCount = 0;
  private maxReconnectAttempts = 50;
  private reconnectDelayMs = 1000;
  private lastMessageTs: number | null = null;
  private latencyMs: number | null = null;
  private priceBuffer: PriceEntry[] = [];
  private bufferMaxAge = 60_000; // keep 60s of prices
  private currentPrice: number | null = null;
  private shouldReconnect = true;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private staleCheckInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config: AppConfig) {
    super();
    this.config = config;
  }

  /** Start the WebSocket connection */
  start(): void {
    const log = createModuleLogger('external-feed');
    const symbol = this.config.externalFeed.symbol.toLowerCase();
    const url = `${this.config.externalFeed.binanceWsUrl}/${symbol}@trade`;

    log.info('Connecting to Binance WebSocket', { url, symbol });
    this.shouldReconnect = true;
    this.connect(url);

    // Check for stale data every 10s
    this.staleCheckInterval = setInterval(() => {
      if (this.lastMessageTs && Date.now() - this.lastMessageTs > 15_000) {
        log.warn('External feed stale — no data for 15s', {
          lastMessage: this.lastMessageTs,
        });
        this.emit('stale');
      }
    }, 10_000);
  }

  private connect(url: string): void {
    const log = createModuleLogger('external-feed');

    try {
      this.ws = new WebSocket(url);
    } catch (err) {
      log.error('Failed to create WebSocket', { error: String(err) });
      this.scheduleReconnect(url);
      return;
    }

    this.ws.on('open', () => {
      log.info('Binance WebSocket connected', {
        reconnectCount: this.reconnectCount,
      });
      this.connected = true;
      this.reconnectDelayMs = 1000; // reset backoff
      this.emit('connected');

      // Ping every 30s to keep alive
      this.pingInterval = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.ping();
        }
      }, 30_000);
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      try {
        const parsed = JSON.parse(data.toString());
        const now = Date.now();

        // Binance trade stream format: { "p": "price", "T": timestamp, "s": "SYMBOL" }
        const price = parseFloat(parsed.p);
        const eventTime = parsed.T || now;

        if (isNaN(price) || price <= 0) return;

        this.currentPrice = price;
        this.lastMessageTs = now;
        this.latencyMs = now - eventTime;

        // Add to rolling buffer
        this.priceBuffer.push({ price, timestamp: now });
        this.pruneBuffer(now);

        const tick: ExternalPriceTick = {
          symbol: this.config.externalFeed.symbol,
          price,
          timestamp: now,
          source: 'binance',
        };

        this.emit('tick', tick);
      } catch {
        // Silently ignore malformed messages
      }
    });

    this.ws.on('error', (err: Error) => {
      log.error('Binance WebSocket error', { error: err.message });
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      log.warn('Binance WebSocket closed', {
        code,
        reason: reason.toString(),
      });
      this.connected = false;
      this.clearPingInterval();
      this.emit('disconnected');

      if (this.shouldReconnect) {
        this.scheduleReconnect(url);
      }
    });
  }

  private scheduleReconnect(url: string): void {
    const log = createModuleLogger('external-feed');

    if (this.reconnectCount >= this.maxReconnectAttempts) {
      log.error('Max reconnect attempts reached — giving up', {
        attempts: this.reconnectCount,
      });
      this.emit('fatal', new Error('Max reconnect attempts exceeded'));
      return;
    }

    this.reconnectCount++;
    const delay = Math.min(this.reconnectDelayMs * 2, 30_000);
    this.reconnectDelayMs = delay;

    log.info('Reconnecting in', {
      delayMs: delay,
      attempt: this.reconnectCount,
    });

    setTimeout(() => this.connect(url), delay);
  }

  private clearPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private pruneBuffer(now: number): void {
    const cutoff = now - this.bufferMaxAge;
    while (this.priceBuffer.length > 0 && this.priceBuffer[0].timestamp < cutoff) {
      this.priceBuffer.shift();
    }
  }

  /** Get the current price (null if no data yet) */
  getCurrentPrice(): number | null {
    return this.currentPrice;
  }

  /** Get price from N seconds ago (for movement detection) */
  getPriceSecondsAgo(seconds: number): number | null {
    const targetTs = Date.now() - seconds * 1000;
    // Find the closest entry to target timestamp
    let closest: PriceEntry | null = null;
    let closestDist = Infinity;

    for (const entry of this.priceBuffer) {
      const dist = Math.abs(entry.timestamp - targetTs);
      if (dist < closestDist) {
        closestDist = dist;
        closest = entry;
      }
    }

    // Only return if within 2s tolerance
    if (closest && closestDist < 2000) {
      return closest.price;
    }
    return null;
  }

  /** Get recent price entries for analysis */
  getRecentPrices(lastNSeconds: number): PriceEntry[] {
    const cutoff = Date.now() - lastNSeconds * 1000;
    return this.priceBuffer.filter((e) => e.timestamp >= cutoff);
  }

  /** Get connection status */
  getConnectionStatus(): ConnectionStatus {
    return {
      source: 'binance',
      connected: this.connected,
      lastMessageTimestamp: this.lastMessageTs,
      reconnectCount: this.reconnectCount,
      latencyMs: this.latencyMs,
    };
  }

  /** Graceful shutdown */
  stop(): void {
    const log = createModuleLogger('external-feed');
    log.info('Stopping external price feed');
    this.shouldReconnect = false;
    this.clearPingInterval();
    if (this.staleCheckInterval) {
      clearInterval(this.staleCheckInterval);
      this.staleCheckInterval = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }
}
