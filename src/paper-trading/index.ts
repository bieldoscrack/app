// ============================================================
// Paper Trading Engine v2
//
// Fixed for binary market PnL:
// - shares = stake / entryPrice
// - PnL = (shares * exitPrice) - stake - fees
//
// Now tracks: shares, fees, order type (maker/taker)
// ============================================================

import { createModuleLogger } from '../logger';
import { calculateFeeUsd } from '../fees';
import {
  AppConfig,
  Trade,
  TradeSide,
  TradeStatus,
  MarketOutcome,
  TradingMode,
  OrderType,
  EntryReason,
  ExitReason,
  PortfolioState,
} from '../types';
import * as winston from 'winston';

function getLog(): winston.Logger {
  return createModuleLogger('paper-trading');
}

export class PaperTradingEngine {
  private config: AppConfig;
  private balance: number;
  private startingBalance: number;
  private openTrades: Map<string, Trade> = new Map();
  private closedTrades: Trade[] = [];
  private tradeCounter = 0;
  private totalFeesPaid = 0;

  constructor(config: AppConfig) {
    this.config = config;
    this.startingBalance = config.paper.startingBalance;
    this.balance = this.startingBalance;
    getLog().info('Paper trading engine initialized', {
      startingBalance: this.balance,
      marketType: config.fees.marketType,
      preferMaker: config.fees.preferMaker,
    });
  }

  /**
   * Simulate opening a trade.
   * Binary market: shares = stake / price
   * Maker orders: 0 fee. Taker orders: dynamic fee.
   */
  openTrade(params: {
    marketId: string;
    outcome: MarketOutcome;
    side: TradeSide;
    price: number;
    stake: number;
    windowId: string;
    orderType: OrderType;
    reason: EntryReason;
  }): Trade | null {
    // Calculate fee on entry
    const entryFee = calculateFeeUsd(
      params.stake,
      params.price,
      this.config.fees.marketType,
      params.orderType
    );

    const totalCost = params.stake + entryFee;

    if (totalCost > this.balance) {
      getLog().warn('Insufficient paper balance for trade', {
        requested: totalCost,
        available: this.balance,
        fee: entryFee,
      });
      return null;
    }

    this.tradeCounter++;
    const id = `paper-${Date.now()}-${this.tradeCounter}`;

    // Binary market: shares = stake / price
    const shares = params.stake / params.price;

    const trade: Trade = {
      id,
      marketId: params.marketId,
      outcome: params.outcome,
      side: params.side,
      status: TradeStatus.OPEN,
      mode: TradingMode.PAPER,
      orderType: params.orderType,
      entryPrice: params.price,
      entryTimestamp: Date.now(),
      entryReason: params.reason,
      stake: params.stake,
      shares,
      exitPrice: null,
      exitTimestamp: null,
      exitReason: null,
      pnl: null,
      feePaid: entryFee,
      windowId: params.windowId,
    };

    this.balance -= totalCost;
    this.totalFeesPaid += entryFee;
    this.openTrades.set(id, trade);

    getLog().info('Paper trade OPENED', {
      id: trade.id,
      outcome: trade.outcome,
      side: trade.side,
      orderType: trade.orderType,
      price: trade.entryPrice,
      stake: trade.stake,
      shares: trade.shares.toFixed(2),
      fee: entryFee,
      balance: this.balance,
    });

    return trade;
  }

  /**
   * Simulate closing a trade.
   *
   * Binary market PnL (correct formula):
   * - BUY: PnL = (shares * exitPrice) - stake
   * - At settlement: exitPrice = 1.00 (win) or 0.00 (lose)
   * - Mid-trade: exitPrice = current book price
   */
  closeTrade(tradeId: string, exitPrice: number, reason: ExitReason): Trade | null {
    const trade = this.openTrades.get(tradeId);
    if (!trade) {
      getLog().warn('Trade not found for close', { tradeId });
      return null;
    }

    // Calculate exit fee (only for taker exits)
    const exitOrderType = this.config.fees.preferMaker ? OrderType.MAKER : OrderType.TAKER;
    const exitFee = calculateFeeUsd(
      trade.shares * exitPrice, // value at exit
      exitPrice,
      this.config.fees.marketType,
      exitOrderType
    );

    // Binary market PnL:
    // Revenue = shares * exitPrice
    // Cost = stake (already deducted) + entry fee (already deducted) + exit fee
    // PnL = revenue - stake - exit fee
    const revenue = trade.shares * exitPrice;
    const pnl = revenue - trade.stake - exitFee;

    trade.exitPrice = exitPrice;
    trade.exitTimestamp = Date.now();
    trade.exitReason = reason;
    trade.pnl = Math.round(pnl * 100) / 100;
    trade.feePaid += exitFee;
    trade.status = TradeStatus.CLOSED;

    // Return revenue minus exit fee to balance
    this.balance += revenue - exitFee;
    this.balance = Math.round(this.balance * 100) / 100;
    this.totalFeesPaid += exitFee;

    this.openTrades.delete(tradeId);
    this.closedTrades.push(trade);

    getLog().info('Paper trade CLOSED', {
      id: trade.id,
      entryPrice: trade.entryPrice,
      exitPrice: trade.exitPrice,
      shares: trade.shares.toFixed(2),
      pnl: trade.pnl,
      totalFee: trade.feePaid,
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
      totalFeesPaid: Math.round(this.totalFeesPaid * 100) / 100,
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
