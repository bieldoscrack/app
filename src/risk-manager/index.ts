// ============================================================
// Risk Manager
//
// Enforces hard limits on trading activity.
// Every trade request must pass through here before execution.
// Tracks: trades/hour, consecutive losses, daily drawdown,
//         feed health, liquidity conditions.
// ============================================================

import { createModuleLogger } from '../logger';
import { AppConfig, RiskState, ConnectionStatus } from '../types';

export class RiskManager {
  private config: AppConfig;
  private tradesThisHour: { timestamp: number }[] = [];
  private consecutiveLosses = 0;
  private dailyPnl = 0;
  private peakDailyPnl = 0;
  private dailyDrawdown = 0;
  private isHalted = false;
  private haltReason: string | null = null;
  private dayStartTimestamp: number;

  constructor(config: AppConfig) {
    this.config = config;
    this.dayStartTimestamp = this.getStartOfDay();
  }

  /**
   * Check if a new trade is allowed. Returns { allowed, reason }.
   * This is the single gate — if it returns false, do NOT trade.
   */
  checkTradeAllowed(params: {
    stake: number;
    connections: ConnectionStatus[];
    liquidityUsd: number;
  }): { allowed: boolean; reason: string } {
    const log = createModuleLogger('risk-manager');

    // Reset daily counters if new day
    this.maybeResetDay();

    // 1. Check if halted
    if (this.isHalted) {
      return { allowed: false, reason: `HALTED: ${this.haltReason}` };
    }

    // 2. Check stake limit
    if (params.stake > this.config.risk.maxStakePerTrade) {
      return {
        allowed: false,
        reason: `Stake $${params.stake} exceeds max $${this.config.risk.maxStakePerTrade}`,
      };
    }

    // 3. Check trades per hour
    this.pruneHourlyTrades();
    if (this.tradesThisHour.length >= this.config.risk.maxTradesPerHour) {
      return {
        allowed: false,
        reason: `Max trades/hour reached (${this.config.risk.maxTradesPerHour})`,
      };
    }

    // 4. Check consecutive losses
    if (this.consecutiveLosses >= this.config.risk.maxConsecutiveLosses) {
      this.halt(`${this.consecutiveLosses} consecutive losses`);
      return {
        allowed: false,
        reason: `Consecutive loss limit reached (${this.consecutiveLosses})`,
      };
    }

    // 5. Check daily drawdown
    if (this.dailyDrawdown >= this.config.risk.maxDailyDrawdown) {
      this.halt(`Daily drawdown $${this.dailyDrawdown.toFixed(2)} exceeds limit $${this.config.risk.maxDailyDrawdown}`);
      return {
        allowed: false,
        reason: `Daily drawdown limit reached ($${this.dailyDrawdown.toFixed(2)})`,
      };
    }

    // 6. Check feed connectivity
    const disconnectedFeeds = params.connections.filter((c) => !c.connected);
    if (disconnectedFeeds.length > 0) {
      const names = disconnectedFeeds.map((c) => c.source).join(', ');
      return {
        allowed: false,
        reason: `Disconnected feeds: ${names}`,
      };
    }

    // 7. Check for stale feeds (no data in 30s)
    const now = Date.now();
    const staleFeeds = params.connections.filter(
      (c) => c.connected && c.lastMessageTimestamp && now - c.lastMessageTimestamp > 30_000
    );
    if (staleFeeds.length > 0) {
      const names = staleFeeds.map((c) => c.source).join(', ');
      return {
        allowed: false,
        reason: `Stale feeds (>30s no data): ${names}`,
      };
    }

    // 8. Check minimum liquidity ($15 minimum — was $50, too strict for thin Polymarket books)
    const minLiquidity = 15;
    if (params.liquidityUsd < minLiquidity) {
      return {
        allowed: false,
        reason: `Insufficient liquidity: $${params.liquidityUsd.toFixed(2)} < $${minLiquidity}`,
      };
    }

    log.debug('Trade allowed by risk manager', {
      stake: params.stake,
      tradesThisHour: this.tradesThisHour.length,
      consecutiveLosses: this.consecutiveLosses,
      dailyDrawdown: this.dailyDrawdown,
    });

    return { allowed: true, reason: 'OK' };
  }

  /** Record that a trade was executed */
  recordTradeOpened(): void {
    this.tradesThisHour.push({ timestamp: Date.now() });
  }

  /** Record the result of a closed trade */
  recordTradeClosed(pnl: number): void {
    const log = createModuleLogger('risk-manager');

    this.dailyPnl += pnl;

    if (pnl > 0) {
      this.consecutiveLosses = 0;
      if (this.dailyPnl > this.peakDailyPnl) {
        this.peakDailyPnl = this.dailyPnl;
      }
    } else {
      this.consecutiveLosses++;
    }

    // Drawdown from peak
    this.dailyDrawdown = Math.max(0, this.peakDailyPnl - this.dailyPnl);

    log.info('Risk state updated after trade close', {
      pnl,
      dailyPnl: this.dailyPnl,
      consecutiveLosses: this.consecutiveLosses,
      dailyDrawdown: this.dailyDrawdown,
    });
  }

  /** Force halt trading */
  halt(reason: string): void {
    const log = createModuleLogger('risk-manager');
    this.isHalted = true;
    this.haltReason = reason;
    log.warn('RISK HALT ACTIVATED', { reason });
  }

  /** Resume trading after manual review */
  resume(): void {
    const log = createModuleLogger('risk-manager');
    log.info('Risk halt cleared — resuming');
    this.isHalted = false;
    this.haltReason = null;
    this.consecutiveLosses = 0;
  }

  /** Get current risk state for dashboard */
  getState(): RiskState {
    this.pruneHourlyTrades();
    return {
      tradesThisHour: this.tradesThisHour.length,
      consecutiveLosses: this.consecutiveLosses,
      dailyPnl: Math.round(this.dailyPnl * 100) / 100,
      dailyDrawdown: Math.round(this.dailyDrawdown * 100) / 100,
      isHalted: this.isHalted,
      haltReason: this.haltReason,
      lastResetTimestamp: this.dayStartTimestamp,
    };
  }

  /** Remove trades older than 1 hour from the counter */
  private pruneHourlyTrades(): void {
    const cutoff = Date.now() - 3600_000;
    this.tradesThisHour = this.tradesThisHour.filter((t) => t.timestamp > cutoff);
  }

  /** Reset daily counters at midnight UTC */
  private maybeResetDay(): void {
    const todayStart = this.getStartOfDay();
    if (todayStart > this.dayStartTimestamp) {
      const log = createModuleLogger('risk-manager');
      log.info('New day — resetting daily risk counters', {
        previousDayPnl: this.dailyPnl,
      });
      this.dailyPnl = 0;
      this.peakDailyPnl = 0;
      this.dailyDrawdown = 0;
      this.dayStartTimestamp = todayStart;
      // Do NOT auto-clear halt — that requires manual review
    }
  }

  private getStartOfDay(): number {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).getTime();
  }
}
