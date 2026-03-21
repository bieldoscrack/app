// ============================================================
// Metrics Collector
//
// Aggregates runtime metrics for dashboard and logging.
// Pure data aggregation — no side effects.
// ============================================================

import { PaperTradingEngine } from '../paper-trading';
import { RiskManager } from '../risk-manager';
import { ExternalPriceFeed } from '../external-feed';
import { PolymarketDataClient } from '../market-data';
import { StrategyEngine } from '../strategy';
import {
  AppConfig,
  DashboardState,
  ConnectionStatus,
} from '../types';

export class MetricsCollector {
  private config: AppConfig;
  private paperEngine: PaperTradingEngine;
  private riskManager: RiskManager;
  private externalFeed: ExternalPriceFeed;
  private marketData: PolymarketDataClient;
  private strategy: StrategyEngine;
  private startTimestamp: number;

  constructor(params: {
    config: AppConfig;
    paperEngine: PaperTradingEngine;
    riskManager: RiskManager;
    externalFeed: ExternalPriceFeed;
    marketData: PolymarketDataClient;
    strategy: StrategyEngine;
  }) {
    this.config = params.config;
    this.paperEngine = params.paperEngine;
    this.riskManager = params.riskManager;
    this.externalFeed = params.externalFeed;
    this.marketData = params.marketData;
    this.strategy = params.strategy;
    this.startTimestamp = Date.now();
  }

  /** Collect all metrics into a single dashboard state snapshot */
  collect(): DashboardState {
    const portfolio = this.paperEngine.getPortfolioState();
    const risk = this.riskManager.getState();
    const connections: ConnectionStatus[] = [
      this.externalFeed.getConnectionStatus(),
      this.marketData.getConnectionStatus(),
    ];

    const recentTrades = [...portfolio.closedTrades]
      .sort((a, b) => (b.exitTimestamp ?? 0) - (a.exitTimestamp ?? 0))
      .slice(0, 10);

    return {
      mode: this.config.tradingMode,
      uptime: Date.now() - this.startTimestamp,
      portfolio,
      risk,
      connections,
      currentWindow: this.strategy.getCurrentWindow(),
      lastOpportunity: this.strategy.getLastOpportunity(),
      recentTrades: [...portfolio.openTrades, ...recentTrades],
    };
  }

  /** Get win rate as percentage */
  getWinRate(): number {
    const portfolio = this.paperEngine.getPortfolioState();
    if (portfolio.totalTrades === 0) return 0;
    return (portfolio.winCount / portfolio.totalTrades) * 100;
  }

  /** Get average PnL per trade */
  getAvgPnl(): number {
    const portfolio = this.paperEngine.getPortfolioState();
    if (portfolio.totalTrades === 0) return 0;
    return portfolio.totalPnl / portfolio.totalTrades;
  }

  /** Get uptime in seconds */
  getUptimeSeconds(): number {
    return (Date.now() - this.startTimestamp) / 1000;
  }
}
