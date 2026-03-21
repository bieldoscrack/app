// ============================================================
// Strategy Engine v2 — Last-Second Maker Strategy
//
// Key changes from v1:
// 1. Only enters trades in the last 15-3 seconds of each window
// 2. Prefers MAKER orders (0 fee + rebates)
// 3. Exits at window end (settlement) or earlier on reversal
// 4. Faster evaluation (every 500ms in entry window)
// 5. Correct binary market PnL via paper engine v2
//
// Flow:
// 1. Wait for entry window (T-15s to T-3s)
// 2. Calculate fair probability via BTC random walk model
// 3. If edge > 5%, place maker order on high-probability side
// 4. Hold until window settles or exit early on momentum reversal
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
  MarketOutcome,
} from '../types';
import { getCurrentWindow } from '../utils';

export class StrategyEngine {
  private config: AppConfig;
  private detector: OpportunityDetector;
  private riskManager: RiskManager;
  private paperEngine: PaperTradingEngine;
  private externalFeed: ExternalPriceFeed;
  private marketData: PolymarketDataClient;

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
  ) {
    this.config = config;
    this.detector = detector;
    this.riskManager = riskManager;
    this.paperEngine = paperEngine;
    this.externalFeed = externalFeed;
    this.marketData = marketData;
  }

  /** Start the strategy loop */
  start(): void {
    const log = createModuleLogger('strategy');
    log.info('Strategy engine v2 starting (last-second maker)', {
      windowDuration: this.config.timing.windowDurationSeconds,
      entryWindowStart: `T-${this.config.timing.entryWindowStartS}s`,
      entryWindowEnd: `T-${this.config.timing.entryWindowEndS}s`,
      preferMaker: this.config.fees.preferMaker,
      marketType: this.config.fees.marketType,
    });

    this.running = true;

    // Evaluate opportunities every 500ms (fast enough for last-second trades)
    this.evalInterval = setInterval(() => this.evaluateTick(), 500);

    // Check exit conditions every 500ms
    this.exitCheckInterval = setInterval(() => this.checkExits(), 500);
  }

  /** Main evaluation tick */
  private evaluateTick(): void {
    if (!this.running) return;

    const log = createModuleLogger('strategy');

    // Update window
    const window = getCurrentWindow(this.config.timing.windowDurationSeconds);
    if (!this.currentWindow || this.currentWindow.id !== window.id) {
      if (this.currentWindow) {
        // Settle all open trades from the ending window BEFORE transitioning
        this.settleOpenTrades(this.currentWindow);
        log.info('Window ended', {
          windowId: this.currentWindow.id,
          tradeExecuted: this.currentWindow.tradeExecuted,
        });
      }
      this.currentWindow = window;

      // Record reference BTC price at window start
      const btcPrice = this.externalFeed.getCurrentPrice();
      if (btcPrice) {
        this.detector.setWindowContext(btcPrice, window.endTimestamp);
        this.marketData.setWindowContext(btcPrice, window.endTimestamp);
        log.info('New window started', {
          windowId: window.id,
          referenceBtc: btcPrice,
          entryWindowAt: `T-${this.config.timing.entryWindowStartS}s`,
        });
      }
    }

    // Skip if already traded in this window
    if (this.currentWindow.tradeExecuted) return;

    // The detector handles timing internally (only fires in entry window)
    const opp = this.detector.evaluate();
    if (!opp) return;

    this.lastOpportunity = opp;

    if (opp.rejected) return;

    // Minimum score threshold (lowered for paper trading to gather more data)
    const MIN_SCORE = 30;
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
      orderType: opp.orderType,
      reason: {
        score: opp.score,
        externalMovementPct: opp.externalMovementPct,
        persistenceConfirmed: opp.persistenceConfirmed,
        spreadBps: opp.spreadBps,
        liquidityUsd: opp.liquidityUsd,
        fairProbability: opp.fairProbability,
        probabilityEdge: opp.probabilityEdge,
        timeRemainingS: opp.timeRemainingS,
        orderType: opp.orderType,
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
        shares: trade.shares.toFixed(2),
        orderType: trade.orderType,
        score: opp.score,
        fairProb: `${(opp.fairProbability * 100).toFixed(1)}%`,
        edge: `${(opp.probabilityEdge * 100).toFixed(1)}%`,
        timeRemaining: `${opp.timeRemainingS.toFixed(0)}s`,
      });
    }
  }

  /**
   * Settle all open trades when a window ends.
   * Called during window transition to ensure trades are closed
   * before the currentWindow reference changes.
   */
  private settleOpenTrades(endedWindow: TradingWindow): void {
    const log = createModuleLogger('strategy');
    const openTrades = this.paperEngine.getOpenTrades();

    for (const trade of openTrades) {
      // Determine settlement: BTC up or down vs reference
      const prob = this.detector.calculateFairProbability();
      const book = this.marketData.getCurrentBook();

      let settlementPrice: number;
      if (prob) {
        const btcUp = prob.btcReturn >= 0;
        if (trade.outcome === MarketOutcome.YES) {
          settlementPrice = btcUp ? 1.00 : 0.00;
        } else {
          settlementPrice = btcUp ? 0.00 : 1.00;
        }
      } else if (book) {
        settlementPrice = trade.outcome === MarketOutcome.YES
          ? book.bestBid
          : (1 - book.bestAsk);
      } else {
        // No data available, settle at entry (no PnL)
        settlementPrice = trade.entryPrice;
      }

      const exitReason: ExitReason = {
        type: 'window_end',
        summary: `Window settled: ${settlementPrice >= 0.5 ? 'WIN' : 'LOSS'} @ ${settlementPrice.toFixed(2)}`,
      };

      const closed = this.paperEngine.closeTrade(trade.id, settlementPrice, exitReason);
      if (closed && closed.pnl !== null) {
        this.riskManager.recordTradeClosed(closed.pnl);
        log.info('TRADE SETTLED', {
          tradeId: closed.id,
          outcome: closed.outcome,
          entryPrice: closed.entryPrice,
          settlementPrice,
          pnl: closed.pnl,
          feePaid: closed.feePaid,
          windowId: endedWindow.id,
        });
      }
    }
  }

  /**
   * Check exit conditions for open trades.
   *
   * v2 exit strategy:
   * 1. Window end settlement is now handled by settleOpenTrades() during window transition
   * 2. Strong momentum reversal → early cut
   * 3. Stop loss → if price drops significantly
   */
  private checkExits(): void {
    if (!this.running) return;

    const log = createModuleLogger('strategy');
    const openTrades = this.paperEngine.getOpenTrades();
    const now = Date.now();

    for (const trade of openTrades) {
      const book = this.marketData.getCurrentBook();
      if (!book) continue;

      // --- Early exit: momentum reversal while in loss ---
      const holdTime = (now - trade.entryTimestamp) / 1000;

      if (holdTime > 3) {
        const btcNow = this.externalFeed.getCurrentPrice();
        const btc3sAgo = this.externalFeed.getPriceSecondsAgo(3);

        if (btcNow && btc3sAgo) {
          const btcMove3s = ((btcNow - btc3sAgo) / btc3sAgo) * 100;

          // Check if momentum reversed against our position
          const isReversal = trade.outcome === MarketOutcome.YES
            ? btcMove3s < -0.04  // BTC dropping vs YES bet
            : btcMove3s > 0.04;  // BTC rising vs NO bet

          // Get current exit price
          let exitPrice: number;
          if (trade.outcome === MarketOutcome.YES) {
            exitPrice = book.bestBid;
          } else {
            exitPrice = 1 - book.bestAsk;
          }

          const pricePct = ((exitPrice - trade.entryPrice) / trade.entryPrice) * 100;

          if (isReversal && pricePct < -2) {
            const exitReason: ExitReason = {
              type: 'stop_loss',
              summary: `Momentum reversal: BTC ${btcMove3s > 0 ? '+' : ''}${btcMove3s.toFixed(3)}% vs ${trade.outcome} (PnL: ${pricePct.toFixed(1)}%)`,
            };

            const closed = this.paperEngine.closeTrade(trade.id, exitPrice, exitReason);
            if (closed && closed.pnl !== null) {
              this.riskManager.recordTradeClosed(closed.pnl);
              log.info('TRADE EARLY EXIT', {
                tradeId: closed.id,
                outcome: closed.outcome,
                pnl: closed.pnl,
                reason: exitReason.summary,
              });
            }
          }
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
