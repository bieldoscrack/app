// ============================================================
// Terminal Dashboard
//
// Renders a live-updating terminal UI with:
// - Portfolio summary (balance, PnL, win rate)
// - Risk state (trades/hr, drawdown, halt status)
// - Connection status (feeds, latency)
// - Current window and last opportunity
// - Recent trade history
//
// Uses plain ANSI escape codes — no external UI libraries.
// ============================================================

import { createModuleLogger } from '../logger';
import { MetricsCollector } from '../metrics';
import { ExternalPriceFeed } from '../external-feed';
import { AppConfig, TradeStatus } from '../types';
import { formatUsd, formatPct, formatUptime } from '../utils';

export class Dashboard {
  private config: AppConfig;
  private metrics: MetricsCollector;
  private externalFeed: ExternalPriceFeed;
  private refreshInterval: ReturnType<typeof setInterval> | null = null;
  private startTimestamp: number;

  constructor(config: AppConfig, metrics: MetricsCollector, externalFeed: ExternalPriceFeed) {
    this.config = config;
    this.metrics = metrics;
    this.externalFeed = externalFeed;
    this.startTimestamp = Date.now();
  }

  /** Start rendering the dashboard */
  start(): void {
    const log = createModuleLogger('dashboard');
    log.info('Dashboard starting', { refreshMs: this.config.dashboard.refreshMs });

    this.refreshInterval = setInterval(() => {
      this.render();
    }, this.config.dashboard.refreshMs);

    // Initial render
    this.render();
  }

  private render(): void {
    const state = this.metrics.collect();
    const extPrice = this.externalFeed.getCurrentPrice();
    const lines: string[] = [];

    // Clear screen
    lines.push('\x1b[2J\x1b[H');

    // Header
    lines.push(this.colorize('═'.repeat(70), 'cyan'));
    const modeColor = state.mode === 'PAPER' ? 'yellow' : 'red';
    lines.push(
      `  POLYMARKET BOT  │  Mode: ${this.colorize(state.mode, modeColor)}  │  ` +
      `Uptime: ${formatUptime(this.startTimestamp)}  │  ` +
      `${new Date().toISOString().replace('T', ' ').substring(0, 19)}`
    );
    lines.push(this.colorize('═'.repeat(70), 'cyan'));

    // Portfolio
    lines.push('');
    lines.push(this.colorize('  PORTFOLIO', 'white_bold'));
    const pnlColor = state.portfolio.totalPnl >= 0 ? 'green' : 'red';
    const balColor = state.portfolio.balance >= state.portfolio.startingBalance ? 'green' : 'red';
    lines.push(
      `  Balance: ${this.colorize(formatUsd(state.portfolio.balance), balColor)}  │  ` +
      `Starting: ${formatUsd(state.portfolio.startingBalance)}  │  ` +
      `PnL: ${this.colorize(formatUsd(state.portfolio.totalPnl), pnlColor)}`
    );

    const winRate = state.portfolio.totalTrades > 0
      ? ((state.portfolio.winCount / state.portfolio.totalTrades) * 100).toFixed(1)
      : '0.0';
    lines.push(
      `  Trades: ${state.portfolio.totalTrades}  │  ` +
      `Wins: ${this.colorize(String(state.portfolio.winCount), 'green')}  │  ` +
      `Losses: ${this.colorize(String(state.portfolio.lossCount), 'red')}  │  ` +
      `Win Rate: ${winRate}%  │  ` +
      `Open: ${state.portfolio.openTrades.length}`
    );

    // External Price
    lines.push('');
    lines.push(this.colorize('  EXTERNAL PRICE', 'white_bold'));
    lines.push(
      `  ${this.config.externalFeed.symbol}: ${extPrice ? formatUsd(extPrice) : 'waiting...'}`
    );

    // Risk State
    lines.push('');
    lines.push(this.colorize('  RISK', 'white_bold'));
    const haltText = state.risk.isHalted
      ? this.colorize(`HALTED: ${state.risk.haltReason}`, 'red')
      : this.colorize('OK', 'green');
    lines.push(
      `  Status: ${haltText}  │  ` +
      `Trades/hr: ${state.risk.tradesThisHour}/${this.config.risk.maxTradesPerHour}  │  ` +
      `Consec. Losses: ${state.risk.consecutiveLosses}/${this.config.risk.maxConsecutiveLosses}`
    );
    lines.push(
      `  Daily PnL: ${this.colorize(formatUsd(state.risk.dailyPnl), state.risk.dailyPnl >= 0 ? 'green' : 'red')}  │  ` +
      `Drawdown: ${this.colorize(formatUsd(state.risk.dailyDrawdown), 'yellow')}/${formatUsd(this.config.risk.maxDailyDrawdown)}`
    );

    // Connections
    lines.push('');
    lines.push(this.colorize('  CONNECTIONS', 'white_bold'));
    for (const conn of state.connections) {
      const connStatus = conn.connected
        ? this.colorize('●', 'green')
        : this.colorize('○', 'red');
      const latency = conn.latencyMs !== null ? `${conn.latencyMs}ms` : '-';
      const lastMsg = conn.lastMessageTimestamp
        ? `${((Date.now() - conn.lastMessageTimestamp) / 1000).toFixed(0)}s ago`
        : 'never';
      lines.push(
        `  ${connStatus} ${conn.source.padEnd(12)}  │  ` +
        `Latency: ${latency.padEnd(8)}  │  ` +
        `Last msg: ${lastMsg}  │  ` +
        `Reconnects: ${conn.reconnectCount}`
      );
    }

    // Current Window
    lines.push('');
    lines.push(this.colorize('  WINDOW', 'white_bold'));
    if (state.currentWindow) {
      const remaining = Math.max(0, (state.currentWindow.endTimestamp - Date.now()) / 1000);
      const traded = state.currentWindow.tradeExecuted
        ? this.colorize('YES', 'yellow')
        : this.colorize('NO', 'dim');
      lines.push(
        `  ID: ${state.currentWindow.id.substring(7)}  │  ` +
        `Remaining: ${remaining.toFixed(0)}s  │  ` +
        `Traded: ${traded}`
      );
    } else {
      lines.push('  Waiting for first window...');
    }

    // Last Opportunity
    lines.push('');
    lines.push(this.colorize('  LAST SIGNAL', 'white_bold'));
    if (state.lastOpportunity) {
      const opp = state.lastOpportunity;
      const age = ((Date.now() - opp.timestamp) / 1000).toFixed(0);
      const status = opp.rejected
        ? this.colorize('REJECTED', 'red')
        : this.colorize(`SCORE: ${opp.score}`, opp.score >= 50 ? 'green' : 'yellow');
      lines.push(
        `  ${status}  │  ` +
        `${opp.outcome} ${opp.side}  │  ` +
        `Move: ${formatPct(opp.externalMovementPct)}  │  ` +
        `Spread: ${opp.spreadBps.toFixed(0)}bps  │  ` +
        `${age}s ago`
      );
      if (opp.rejected && opp.rejectionReasons.length > 0) {
        lines.push(`  Reason: ${opp.rejectionReasons[0]}`);
      }
    } else {
      lines.push('  No signals yet...');
    }

    // Recent Trades
    lines.push('');
    lines.push(this.colorize('  RECENT TRADES', 'white_bold'));
    lines.push(
      '  ' +
      'ID'.padEnd(14) +
      'Side'.padEnd(8) +
      'Entry'.padEnd(8) +
      'Exit'.padEnd(8) +
      'PnL'.padEnd(10) +
      'Reason'
    );
    lines.push('  ' + '-'.repeat(64));

    const trades = state.recentTrades.slice(0, 8);
    if (trades.length === 0) {
      lines.push('  No trades yet...');
    }
    for (const trade of trades) {
      const pnl = trade.pnl !== null ? formatUsd(trade.pnl) : 'open';
      const pnlC = trade.status === TradeStatus.OPEN
        ? this.colorize(pnl, 'yellow')
        : (trade.pnl !== null && trade.pnl >= 0)
          ? this.colorize(pnl, 'green')
          : this.colorize(pnl, 'red');
      const exitP = trade.exitPrice !== null ? trade.exitPrice.toFixed(3) : '-';
      const reason = trade.exitReason?.summary ?? trade.entryReason.summary.substring(0, 20);
      lines.push(
        '  ' +
        trade.id.substring(0, 13).padEnd(14) +
        `${trade.outcome} ${trade.side}`.padEnd(8) +
        trade.entryPrice.toFixed(3).padEnd(8) +
        exitP.padEnd(8) +
        pnlC.padEnd(22) + // extra padding for ANSI escape codes
        reason.substring(0, 24)
      );
    }

    lines.push('');
    lines.push(this.colorize('═'.repeat(70), 'cyan'));
    lines.push('  Press Ctrl+C to stop');

    process.stdout.write(lines.join('\n') + '\n');
  }

  private colorize(text: string, color: string): string {
    const colors: Record<string, string> = {
      red: '\x1b[31m',
      green: '\x1b[32m',
      yellow: '\x1b[33m',
      cyan: '\x1b[36m',
      white_bold: '\x1b[1;37m',
      dim: '\x1b[2m',
      reset: '\x1b[0m',
    };
    const code = colors[color] || '';
    return `${code}${text}\x1b[0m`;
  }

  /** Stop the dashboard */
  stop(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
  }
}
