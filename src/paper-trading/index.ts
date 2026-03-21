// ============================================================
// Paper Trading Engine
// Simulates trade execution without touching real markets.
// Tracks positions, PnL, and provides realistic-ish fills.
// ============================================================

import { createModuleLogger } from '../logger';
import {
  AppConfig,
  Trade,
  TradeSide,
  TradeStatus,
  MarketOutcome,
  TradingMode,
  EntryReason,
  ExitReason,
  PortfolioState,
} from '../types';
import * as winston from 'winston';

function getLog(): winston.Logger {
  return createModuleLogger('paper-trading');
}

export class PaperTradingEngine {
  private balance: number;
  private startingBalance: number;
  private openTrades: Map<string, Trade> = new Map();
  private closedTrades: Trade[] = [];
  private tradeCounter = 0;

  constructor(config: AppConfig) {
    this.startingBalance = config.paper.startingBalance;
    this.balance = this.startingBalance;
    getLog().info('Paper trading engine initialized', {
      startingBalance: this.balance,
    });
  }

  /**
   * Simulate opening a trade. Deducts stake from balance.
   * Returns the trade record or null if insufficient balance.
   */
  openTrade(params: {
    marketId: string;
    outcome: MarketOutcome;
    side: TradeSide;
    price: number;
    stake: number;
    windowId: string;
    reason: EntryReason;
  }): Trade | null {
    if (params.stake > this.balance) {
      getLog().warn('Insufficient paper balance for trade', {
        requested: params.stake,
        available: this.balance,
      });
      return null;
    }

    this.tradeCounter++;
    const id = `paper-${Date.now()}-${this.tradeCounter}`;

    const trade: Trade = {
      id,
      marketId: params.marketId,
      outcome: params.outcome,
      side: params.side,
      status: TradeStatus.OPEN,
      mode: TradingMode.PAPER,
      entryPrice: params.price,
      entryTimestamp: Date.now(),
      entryReason: params.reason,
      stake: params.stake,
      exitPrice: null,
      exitTimestamp: null,
      exitReason: null,
      pnl: null,
      windowId: params.windowId,
    };

    this.balance -= params.stake;
    this.openTrades.set(id, trade);

    getLog().info('Paper trade OPENED', {
      id: trade.id,
      outcome: trade.outcome,
      side: trade.side,
      price: trade.entryPrice,
      stake: trade.stake,
      balance: this.balance,
      reason: trade.entryReason.summary,
    });

    return trade;
  }

  /**
   * Simulate closing a trade. Credits balance with result.
   */
  closeTrade(tradeId: string, exitPrice: number, reason: ExitReason): Trade | null {
    const trade = this.openTrades.get(tradeId);
    if (!trade) {
      getLog().warn('Trade not found for close', { tradeId });
      return null;
    }

    // PnL calculation for binary markets:
    // BUY at entryPrice, exit at exitPrice
    // PnL = stake * (exitPrice - entryPrice) / entryPrice
    // Simplified: if you bought YES at 0.60 and it goes to 0.70,
    // you gain proportionally on your stake.
    const priceDelta = exitPrice - trade.entryPrice;
    const pnl = trade.side === TradeSide.BUY
      ? trade.stake * (priceDelta / trade.entryPrice)
      : trade.stake * (-priceDelta / trade.entryPrice);

    trade.exitPrice = exitPrice;
    trade.exitTimestamp = Date.now();
    trade.exitReason = reason;
    trade.pnl = Math.round(pnl * 100) / 100; // round to cents
    trade.status = TradeStatus.CLOSED;

    // Return stake + pnl to balance
    this.balance += trade.stake + trade.pnl;
    this.balance = Math.round(this.balance * 100) / 100;

    this.openTrades.delete(tradeId);
    this.closedTrades.push(trade);

    getLog().info('Paper trade CLOSED', {
      id: trade.id,
      entryPrice: trade.entryPrice,
      exitPrice: trade.exitPrice,
      pnl: trade.pnl,
      reason: reason.summary,
      balance: this.balance,
    });

    return trade;
  }

  /** Get current portfolio state */
  getPortfolioState(): PortfolioState {
    const wins = this.closedTrades.filter((t) => t.pnl !== null && t.pnl > 0);
    const losses = this.closedTrades.filter((t) => t.pnl !== null && t.pnl <= 0);
    const totalPnl = this.closedTrades.reduce((sum, t) => sum + (t.pnl ?? 0), 0);

    return {
      balance: this.balance,
      startingBalance: this.startingBalance,
      openTrades: Array.from(this.openTrades.values()),
      closedTrades: this.closedTrades,
      totalPnl: Math.round(totalPnl * 100) / 100,
      winCount: wins.length,
      lossCount: losses.length,
      totalTrades: this.closedTrades.length,
    };
  }

  /** Get a specific open trade */
  getOpenTrade(tradeId: string): Trade | undefined {
    return this.openTrades.get(tradeId);
  }

  /** Get all open trades */
  getOpenTrades(): Trade[] {
    return Array.from(this.openTrades.values());
  }

  /** Get current balance */
  getBalance(): number {
    return this.balance;
  }
}
