// ============================================================
// Strategy Engine
//
// Orchestrates the trading loop:
// 1. Manages trading windows (1 trade per window)
// 2. Asks OpportunityDetector for signals
// 3. Checks RiskManager before any trade
// 4. Routes execution to PaperTradingEngine
// 5. Monitors open trades for exit conditions
//
// This is the central coordinator — it holds no edge logic
// itself, it just wires the pipeline together correctly.
// ============================================================

import { createModuleLogger } from '../logger';
import { OpportunityDetector } from '../opportunity';
import { RiskManager } from '../risk-manager';
import { PaperTradingEngine } from '../paper-trading';
import { ExternalPriceFeed } from '../external-feed';
import { PolymarketDataClient } from '../market-data';
import {
  AppConfig,
  TradingWindow,
  ConnectionStatus,
  Opportunity,
  ExitReason,
} from '../types';
import { getCurrentWindow } from '../utils';

/** Exit condition parameters */
interface ExitParams {
  /** Seconds to hold before timeout exit */
  timeoutSeconds: number;
  /** Profit target as % of entry price */
  profitTargetPct: number;
  /** Stop loss as % of entry price */
  stopLossPct: number;
}

const DEFAULT_EXIT_PARAMS: ExitParams = {
  timeoutSeconds: 240, // 4 minutes (within 5-min window)
  profitTargetPct: 3.0, // 3% profit target
  stopLossPct: 2.0, // 2% stop loss
};

export class StrategyEngine {
  private config: AppConfig;
  private detector: OpportunityDetector;
  private riskManager: RiskManager;
  private paperEngine: PaperTradingEngine;
  private externalFeed: ExternalPriceFeed;
  private marketData: PolymarketDataClient;
  private exitParams: ExitParams;

  private currentWindow: TradingWindow | null = null;
  private evalInterval: ReturnType<typeof setInterval> | null = null;
  private exitCheckInterval: ReturnType<typeof setInterval> | null = null;
  private lastOpportunity: Opportunity | null = null;
  private running = false;

  constructor(
    config: AppConfig,
    detector: OpportunityDetector,
    riskManager: RiskManager,
    paperEngine: PaperTradingEngine,
    externalFeed: ExternalPriceFeed,
    marketData: PolymarketDataClient,
    exitParams?: Partial<ExitParams>
  ) {
    this.config = config;
    this.detector = detector;
    this.riskManager = riskManager;
    this.paperEngine = paperEngine;
    this.externalFeed = externalFeed;
    this.marketData = marketData;
    this.exitParams = { ...DEFAULT_EXIT_PARAMS, ...exitParams };
  }

  /** Start the strategy loop */
  start(): void {
    const log = createModuleLogger('strategy');
    log.info('Strategy engine starting', {
      windowDuration: this.config.timing.windowDurationSeconds,
      exitTimeout: this.exitParams.timeoutSeconds,
      profitTarget: `${this.exitParams.profitTargetPct}%`,
      stopLoss: `${this.exitParams.stopLossPct}%`,
    });

    this.running = true;

    // Evaluate opportunities every 1 second
    this.evalInterval = setInterval(() => this.evaluateTick(), 1000);

    // Check exit conditions every 500ms
    this.exitCheckInterval = setInterval(() => this.checkExits(), 500);
  }

  /** Main evaluation tick — called every second */
  private evaluateTick(): void {
    if (!this.running) return;

    const log = createModuleLogger('strategy');

    // Update window
    const window = getCurrentWindow(this.config.timing.windowDurationSeconds);
    if (!this.currentWindow || this.currentWindow.id !== window.id) {
      // New window started
      if (this.currentWindow) {
        log.info('Window ended', {
          windowId: this.currentWindow.id,
          tradeExecuted: this.currentWindow.tradeExecuted,
        });
      }
      this.currentWindow = window;
      log.info('New window started', { windowId: window.id });
    }

    // Skip if already traded in this window
    if (this.currentWindow.tradeExecuted) return;

    // Evaluate opportunity
    const opp = this.detector.evaluate();
    if (!opp) return;

    this.lastOpportunity = opp;

    // Skip rejected opportunities
    if (opp.rejected) return;

    // Minimum score threshold — lowered to 15 to catch more opportunities
    const MIN_SCORE = 15;
    if (opp.score < MIN_SCORE) {
      log.debug('Opportunity score too low', { score: opp.score, min: MIN_SCORE });
      return;
    }

    // Risk check
    const connections = this.getConnections();
    const riskCheck = this.riskManager.checkTradeAllowed({
      stake: opp.suggestedStake,
      connections,
      liquidityUsd: opp.liquidityUsd,
    });

    if (!riskCheck.allowed) {
      log.info('Trade blocked by risk manager', {
        reason: riskCheck.reason,
        score: opp.score,
      });
      return;
    }

    // Execute paper trade
    const trade = this.paperEngine.openTrade({
      marketId: opp.marketId,
      outcome: opp.outcome,
      side: opp.side,
      price: opp.suggestedEntryPrice,
      stake: opp.suggestedStake,
      windowId: this.currentWindow.id,
      reason: {
        score: opp.score,
        externalMovementPct: opp.externalMovementPct,
        persistenceConfirmed: opp.persistenceConfirmed,
        spreadBps: opp.spreadBps,
        liquidityUsd: opp.liquidityUsd,
        summary: opp.reasons.join(' | '),
      },
    });

    if (trade) {
      this.currentWindow.tradeExecuted = true;
      this.currentWindow.tradeId = trade.id;
      this.riskManager.recordTradeOpened();

      log.info('TRADE EXECUTED', {
        tradeId: trade.id,
        outcome: trade.outcome,
        price: trade.entryPrice,
        stake: trade.stake,
        score: opp.score,
        windowId: this.currentWindow.id,
      });
    }
  }

  /** Check exit conditions for open trades */
  private checkExits(): void {
    if (!this.running) return;

    const log = createModuleLogger('strategy');
    const openTrades = this.paperEngine.getOpenTrades();
    const now = Date.now();

    for (const trade of openTrades) {
      const book = this.marketData.getCurrentBook();
      if (!book) continue;

      const currentPrice = book.midPrice;
      const holdTime = (now - trade.entryTimestamp) / 1000;
      const priceDelta = currentPrice - trade.entryPrice;
      const pricePct = (priceDelta / trade.entryPrice) * 100;

      let exitReason: ExitReason | null = null;

      // 1. Timeout exit
      if (holdTime >= this.exitParams.timeoutSeconds) {
        exitReason = {
          type: 'timeout',
          summary: `Timeout after ${holdTime.toFixed(0)}s`,
        };
      }

      // 2. Profit target
      if (pricePct >= this.exitParams.profitTargetPct) {
        exitReason = {
          type: 'target',
          summary: `Profit target hit: ${pricePct.toFixed(2)}%`,
        };
      }

      // 3. Stop loss
      if (pricePct <= -this.exitParams.stopLossPct) {
        exitReason = {
          type: 'stop_loss',
          summary: `Stop loss hit: ${pricePct.toFixed(2)}%`,
        };
      }

      if (exitReason) {
        const closed = this.paperEngine.closeTrade(trade.id, currentPrice, exitReason);
        if (closed && closed.pnl !== null) {
          this.riskManager.recordTradeClosed(closed.pnl);
          log.info('TRADE CLOSED', {
            tradeId: closed.id,
            entryPrice: closed.entryPrice,
            exitPrice: closed.exitPrice,
            pnl: closed.pnl,
            reason: exitReason.summary,
          });
        }
      }
    }
  }

  private getConnections(): ConnectionStatus[] {
    return [
      this.externalFeed.getConnectionStatus(),
      this.marketData.getConnectionStatus(),
    ];
  }

  /** Get current window for dashboard */
  getCurrentWindow(): TradingWindow | null {
    return this.currentWindow;
  }

  /** Get last detected opportunity for dashboard */
  getLastOpportunity(): Opportunity | null {
    return this.lastOpportunity;
  }

  /** Stop the strategy */
  stop(): void {
    const log = createModuleLogger('strategy');
    log.info('Strategy engine stopping');
    this.running = false;
    if (this.evalInterval) {
      clearInterval(this.evalInterval);
      this.evalInterval = null;
    }
    if (this.exitCheckInterval) {
      clearInterval(this.exitCheckInterval);
      this.exitCheckInterval = null;
    }
  }
}
