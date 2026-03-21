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
  MarketOutcome,
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
  /** Enable trailing stop: once in profit, trail at this % below peak */
  trailingStopPct: number;
}

const DEFAULT_EXIT_PARAMS: ExitParams = {
  timeoutSeconds: 270, // 4.5 minutes (within 5-min window)
  profitTargetPct: 1.0, // 1.0% profit target — achievable with 0.5 cent spread
  stopLossPct: 1.5, // 1.5% stop loss — tighter risk control
  trailingStopPct: 0.4, // Trail 0.4% below peak profit
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
  /** Track peak price per trade for trailing stop */
  private tradePeakPrices: Map<string, number> = new Map();

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

      // Record reference BTC price at window start
      const btcPrice = this.externalFeed.getCurrentPrice();
      if (btcPrice) {
        this.detector.setWindowContext(btcPrice, window.endTimestamp);
        this.marketData.setWindowContext(btcPrice, window.endTimestamp);
        log.info('New window started', {
          windowId: window.id,
          referenceBtc: btcPrice,
        });
      } else {
        log.info('New window started (no BTC price yet)', { windowId: window.id });
      }
    }

    // Skip if already traded in this window
    if (this.currentWindow.tradeExecuted) return;

    // Evaluate opportunity
    const opp = this.detector.evaluate();
    if (!opp) return;

    this.lastOpportunity = opp;

    // Skip rejected opportunities
    if (opp.rejected) return;

    // Minimum score threshold — probability edge is the primary gatekeeper now
    const MIN_SCORE = 45;
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

  /** Check exit conditions for open trades (with trailing stop + momentum reversal) */
  private checkExits(): void {
    if (!this.running) return;

    const log = createModuleLogger('strategy');
    const openTrades = this.paperEngine.getOpenTrades();
    const now = Date.now();

    for (const trade of openTrades) {
      const book = this.marketData.getCurrentBook();
      if (!book) continue;

      // --- CORRECT exit price based on outcome ---
      // YES BUY: sell YES = get bestBid (with small improvement for sim)
      // NO BUY: sell NO = 1 - bestAsk (inverted book side)
      let exitPrice: number;
      if (trade.outcome === MarketOutcome.YES) {
        // Selling YES: realistic fill between bid and mid
        exitPrice = book.bestBid + (book.spread * 0.25);
      } else {
        // Selling NO: NO exit price = 1 - YES bestAsk (with improvement)
        exitPrice = 1 - book.bestAsk + (book.spread * 0.25);
      }

      const holdTime = (now - trade.entryTimestamp) / 1000;
      const priceDelta = exitPrice - trade.entryPrice;
      const pricePct = (priceDelta / trade.entryPrice) * 100;

      // Update peak price for trailing stop
      const peakPrice = this.tradePeakPrices.get(trade.id) ?? trade.entryPrice;
      if (exitPrice > peakPrice) {
        this.tradePeakPrices.set(trade.id, exitPrice);
      }
      const currentPeak = this.tradePeakPrices.get(trade.id) ?? trade.entryPrice;
      const peakPct = ((currentPeak - trade.entryPrice) / trade.entryPrice) * 100;
      const dropFromPeak = ((currentPeak - exitPrice) / currentPeak) * 100;

      let exitReason: ExitReason | null = null;

      // 1. Profit target
      if (pricePct >= this.exitParams.profitTargetPct) {
        exitReason = {
          type: 'target',
          summary: `Profit target hit: ${pricePct.toFixed(2)}%`,
        };
      }

      // 2. Trailing stop: activate once in profit > 0.3%
      if (!exitReason && peakPct > 0.3 && dropFromPeak >= this.exitParams.trailingStopPct) {
        exitReason = {
          type: 'target',
          summary: `Trailing stop: peak ${peakPct.toFixed(2)}%, dropped ${dropFromPeak.toFixed(2)}%`,
        };
      }

      // 3. Momentum reversal exit — if BTC reversed direction vs our trade
      if (!exitReason && holdTime > 5) {
        const btcNow = this.externalFeed.getCurrentPrice();
        const btc5sAgo = this.externalFeed.getPriceSecondsAgo(5);
        if (btcNow && btc5sAgo) {
          const btcMove5s = ((btcNow - btc5sAgo) / btc5sAgo) * 100;
          // YES trade expects BTC up → if BTC dropping, that's reversal
          // NO trade expects BTC down → if BTC rising, that's reversal
          const isReversal = trade.outcome === MarketOutcome.YES
            ? btcMove5s < -0.035 // BTC dropped 0.035% in last 5s
            : btcMove5s > 0.035;  // BTC rose 0.035% in last 5s

          if (isReversal && pricePct < 0) {
            // Momentum reversed AND we're in the red — cut losses early
            exitReason = {
              type: 'stop_loss',
              summary: `Momentum reversal: BTC ${btcMove5s > 0 ? '+' : ''}${btcMove5s.toFixed(3)}% vs ${trade.outcome} (PnL: ${pricePct.toFixed(2)}%)`,
            };
          }
        }
      }

      // 4. Stop loss
      if (!exitReason && pricePct <= -this.exitParams.stopLossPct) {
        exitReason = {
          type: 'stop_loss',
          summary: `Stop loss hit: ${pricePct.toFixed(2)}%`,
        };
      }

      // 5. Timeout exit
      if (!exitReason && holdTime >= this.exitParams.timeoutSeconds) {
        exitReason = {
          type: 'timeout',
          summary: `Timeout after ${holdTime.toFixed(0)}s (PnL: ${pricePct.toFixed(2)}%)`,
        };
      }

      if (exitReason) {
        const closed = this.paperEngine.closeTrade(trade.id, exitPrice, exitReason);
        if (closed && closed.pnl !== null) {
          // Simulate Polymarket fee: ~2% on winning trades
          if (closed.pnl > 0) {
            const fee = closed.pnl * 0.02;
            closed.pnl = Math.round((closed.pnl - fee) * 100) / 100;
          }
          this.riskManager.recordTradeClosed(closed.pnl);
          this.tradePeakPrices.delete(trade.id);
          log.info('TRADE CLOSED', {
            tradeId: closed.id,
            outcome: closed.outcome,
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
