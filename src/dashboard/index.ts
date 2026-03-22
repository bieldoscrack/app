// ============================================================
// Terminal Dashboard v2 - HACKER EDITION
//
// Updated for last-second maker strategy:
// - Shows entry window countdown
// - Shows fair probability and edge
// - Shows fees paid and order type
// - Shows settlement results
// - Hacker aesthetic with Anonymous mask
// ============================================================

import { createModuleLogger } from '../logger';
import { MetricsCollector } from '../metrics';
import { ExternalPriceFeed } from '../external-feed';
import { AppConfig, TradeStatus } from '../types';
import { formatUsd, formatUptime } from '../utils';

export class Dashboard {
  private config: AppConfig;
  private metrics: MetricsCollector;
  private externalFeed: ExternalPriceFeed;
  private refreshInterval: ReturnType<typeof setInterval> | null = null;
  private startTimestamp: number;
  private frameCount: number = 0;

  constructor(config: AppConfig, metrics: MetricsCollector, externalFeed: ExternalPriceFeed) {
    this.config = config;
    this.metrics = metrics;
    this.externalFeed = externalFeed;
    this.startTimestamp = Date.now();
  }

  start(): void {
    const log = createModuleLogger('dashboard');
    log.info('Dashboard starting', { refreshMs: this.config.dashboard.refreshMs });

    this.refreshInterval = setInterval(() => {
      this.render();
    }, this.config.dashboard.refreshMs);

    this.render();
  }

  private render(): void {
    this.frameCount++;
    const state = this.metrics.collect();
    const extPrice = this.externalFeed.getCurrentPrice();
    const lines: string[] = [];

    lines.push('\x1b[2J\x1b[H');

    // Matrix-style top border
    const matrixChars = '01';
    let topBorder = '';
    for (let i = 0; i < 90; i++) {
      topBorder += matrixChars[Math.floor(Math.random() * 2)];
    }
    lines.push(this.colorize(`  ${topBorder}`, 'dark_green'));
    lines.push(this.colorize('  ╔' + '═'.repeat(88) + '╗', 'cyan'));

    // DEV BIEL - Bigger ASCII Art
    lines.push(this.colorize('  ║' + ' '.repeat(88) + '║', 'cyan'));
    const devBielArt = [
      '  ██████╗  ███████╗██╗   ██╗    ██████╗ ██╗███████╗██╗         ',
      '  ██╔══██╗ ██╔════╝██║   ██║    ██╔══██╗██║██╔════╝██║         ',
      '  ██║  ██║ █████╗  ██║   ██║    ██████╔╝██║█████╗  ██║         ',
      '  ██║  ██║ ██╔══╝  ╚██╗ ██╔╝    ██╔══██╗██║██╔══╝  ██║         ',
      '  ██████╔╝ ███████╗ ╚████╔╝     ██████╔╝██║███████╗███████╗    ',
      '  ╚═════╝  ╚══════╝  ╚═══╝      ╚═════╝ ╚═╝╚══════╝╚══════╝    ',
    ];
    for (const artLine of devBielArt) {
      lines.push(this.colorize('  ║', 'cyan') + this.colorize(artLine.padEnd(88), 'green') + this.colorize('║', 'cyan'));
    }

    // Anonymous Mask ASCII Art
    lines.push(this.colorize('  ║' + ' '.repeat(88) + '║', 'cyan'));
    const maskArt = [
      '                          ██████████████                          ',
      '                      ████░░░░░░░░░░░░░░████                      ',
      '                    ██░░░░░░░░░░░░░░░░░░░░░░██                    ',
      '                  ██░░░░░░░░░░░░░░░░░░░░░░░░░░██                  ',
      '                ██░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░██                ',
      '                ██░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░██                ',
      '                ██░░░░██████░░░░░░░░██████░░░░░░██                ',
      '                ██░░░░██▓▓██░░░░░░░░██▓▓██░░░░░░██                ',
      '                ██░░░░██████░░░░░░░░██████░░░░░░██                ',
      '                ██░░░░░░░░░░░░████░░░░░░░░░░░░░░██                ',
      '                ██░░░░░░░░░░░░████░░░░░░░░░░░░░░██                ',
      '                  ██░░░░░░░░░░░░░░░░░░░░░░░░░░██                  ',
      '                    ██░░██░░░░░░░░░░░░██░░░░██                    ',
      '                      ██░░████████████░░░░██                      ',
      '                        ████░░░░░░░░████████                      ',
      '                            ████████                              ',
    ];
    for (const artLine of maskArt) {
      lines.push(this.colorize('  ║', 'cyan') + this.colorize(artLine.padEnd(88), 'green') + this.colorize('║', 'cyan'));
    }

    lines.push(this.colorize('  ║' + ' '.repeat(88) + '║', 'cyan'));
    lines.push(this.colorize('  ╠' + '═'.repeat(88) + '╣', 'cyan'));

    // Bot Info Line
    const modeColor = state.mode === 'PAPER' ? 'yellow' : 'red';
    const botInfo =
      `  POLYMARKET BOT v2  │  ${this.colorize(state.mode, modeColor)}  │  ` +
      `${this.config.fees.marketType} ${this.config.fees.preferMaker ? 'MAKER' : 'TAKER'}  │  ` +
      `Up: ${formatUptime(this.startTimestamp)}  │  ` +
      `${new Date().toISOString().replace('T', ' ').substring(0, 19)}`;
    lines.push(this.colorize('  ║ ', 'cyan') + botInfo.padEnd(87) + this.colorize(' ║', 'cyan'));
    lines.push(this.colorize('  ╠' + '═'.repeat(88) + '╣', 'cyan'));

    // Portfolio Section
    lines.push(this.sectionLine('PORTFOLIO', 'white_bold'));
    const pnlColor = state.portfolio.totalPnl >= 0 ? 'green' : 'red';
    const balColor = state.portfolio.balance >= state.portfolio.startingBalance ? 'green' : 'red';
    lines.push(this.contentLine(
      `  Balance: ${this.colorize(formatUsd(state.portfolio.balance), balColor)}  │  ` +
      `Starting: ${formatUsd(state.portfolio.startingBalance)}  │  ` +
      `PnL: ${this.colorize(formatUsd(state.portfolio.totalPnl), pnlColor)}  │  ` +
      `Fees: ${this.colorize(formatUsd(state.portfolio.totalFeesPaid), 'yellow')}`
    ));

    const winRate = state.portfolio.totalTrades > 0
      ? ((state.portfolio.winCount / state.portfolio.totalTrades) * 100).toFixed(1)
      : '0.0';
    const winRateColor = parseFloat(winRate) >= 60 ? 'green' : parseFloat(winRate) >= 40 ? 'yellow' : 'red';
    lines.push(this.contentLine(
      `  Trades: ${state.portfolio.totalTrades}  │  ` +
      `Wins: ${this.colorize(String(state.portfolio.winCount), 'green')}  │  ` +
      `Losses: ${this.colorize(String(state.portfolio.lossCount), 'red')}  │  ` +
      `Win Rate: ${this.colorize(winRate + '%', winRateColor)}  │  ` +
      `Open: ${state.portfolio.openTrades.length}`
    ));

    // ROI calculation
    const roi = state.portfolio.startingBalance > 0
      ? ((state.portfolio.totalPnl / state.portfolio.startingBalance) * 100).toFixed(2)
      : '0.00';
    const roiColor = parseFloat(roi) >= 0 ? 'green' : 'red';
    const avgPnl = state.portfolio.totalTrades > 0
      ? formatUsd(state.portfolio.totalPnl / state.portfolio.totalTrades)
      : '$0.00';
    lines.push(this.contentLine(
      `  ROI: ${this.colorize(roi + '%', roiColor)}  │  ` +
      `Avg PnL/Trade: ${this.colorize(avgPnl, pnlColor)}  │  ` +
      `Session: ${formatUptime(this.startTimestamp)}`
    ));

    lines.push(this.colorize('  ╠' + '─'.repeat(88) + '╣', 'dark_green'));

    // External Price
    lines.push(this.sectionLine('EXTERNAL PRICE', 'white_bold'));
    const priceStr = extPrice ? formatUsd(extPrice) : 'waiting...';
    lines.push(this.contentLine(
      `  ${this.colorize(this.config.externalFeed.symbol, 'cyan')}: ${this.colorize(priceStr, 'yellow')}`
    ));

    lines.push(this.colorize('  ╠' + '─'.repeat(88) + '╣', 'dark_green'));

    // Risk State
    lines.push(this.sectionLine('RISK MANAGEMENT', 'white_bold'));
    const haltText = state.risk.isHalted
      ? this.colorize(`HALTED: ${state.risk.haltReason}`, 'red')
      : this.colorize('OPERATIONAL', 'green');
    lines.push(this.contentLine(
      `  Status: ${haltText}  │  ` +
      `Trades/hr: ${state.risk.tradesThisHour}  │  ` +
      `Consec. Losses: ${this.colorize(String(state.risk.consecutiveLosses), state.risk.consecutiveLosses > 2 ? 'red' : 'green')}`
    ));
    lines.push(this.contentLine(
      `  Daily PnL: ${this.colorize(formatUsd(state.risk.dailyPnl), state.risk.dailyPnl >= 0 ? 'green' : 'red')}  │  ` +
      `Drawdown: ${this.colorize(formatUsd(state.risk.dailyDrawdown), 'yellow')}/${formatUsd(this.config.risk.maxDailyDrawdown)}  │  ` +
      `Max Drawdown: ${formatUsd(this.config.risk.maxDailyDrawdown)}`
    ));

    lines.push(this.colorize('  ╠' + '─'.repeat(88) + '╣', 'dark_green'));

    // Connections
    lines.push(this.sectionLine('CONNECTIONS', 'white_bold'));
    for (const conn of state.connections) {
      const connIcon = conn.connected
        ? this.colorize('[ONLINE]', 'green')
        : this.colorize('[OFFLINE]', 'red');
      const latency = conn.latencyMs !== null ? `${conn.latencyMs}ms` : '-';
      const latColor = conn.latencyMs !== null && conn.latencyMs < 500 ? 'green' : conn.latencyMs !== null && conn.latencyMs < 2000 ? 'yellow' : 'red';
      const lastMsg = conn.lastMessageTimestamp
        ? `${((Date.now() - conn.lastMessageTimestamp) / 1000).toFixed(0)}s ago`
        : 'never';
      lines.push(this.contentLine(
        `  ${connIcon} ${conn.source.padEnd(12)}  │  ` +
        `Latency: ${this.colorize(latency.padEnd(8), conn.latencyMs !== null ? latColor : 'dim')}  │  ` +
        `Last msg: ${lastMsg}  │  ` +
        `Reconnects: ${conn.reconnectCount}`
      ));
    }

    lines.push(this.colorize('  ╠' + '─'.repeat(88) + '╣', 'dark_green'));

    // Current Window with Entry Window Countdown
    lines.push(this.sectionLine('WINDOW', 'white_bold'));
    if (state.currentWindow) {
      const remaining = Math.max(0, (state.currentWindow.endTimestamp - Date.now()) / 1000);
      const traded = state.currentWindow.tradeExecuted
        ? this.colorize('YES', 'yellow')
        : this.colorize('NO', 'dim');

      const entryStart = this.config.timing.entryWindowStartS;
      const entryEnd = this.config.timing.entryWindowEndS;
      let entryStatus: string;

      if (remaining > entryStart) {
        const untilEntry = (remaining - entryStart).toFixed(0);
        entryStatus = this.colorize(`WAITING (entry in ${untilEntry}s)`, 'dim');
      } else if (remaining >= entryEnd) {
        entryStatus = this.colorize(`>>> ENTRY WINDOW OPEN <<<`, 'green');
      } else {
        entryStatus = this.colorize(`CLOSED`, 'red');
      }

      // Progress bar for window
      const totalTime = 300; // 5 min window
      const elapsed = totalTime - remaining;
      const progress = Math.min(1, elapsed / totalTime);
      const barLen = 20;
      const filled = Math.round(progress * barLen);
      const bar = this.colorize('█'.repeat(filled), 'green') + this.colorize('░'.repeat(barLen - filled), 'dim');

      lines.push(this.contentLine(
        `  ID: ${state.currentWindow.id.substring(7)}  │  ` +
        `T-${remaining.toFixed(0)}s  │  ` +
        `Traded: ${traded}  │  ` +
        entryStatus
      ));
      lines.push(this.contentLine(
        `  Progress: [${bar}] ${(progress * 100).toFixed(0)}%`
      ));
    } else {
      lines.push(this.contentLine('  Waiting for first window...'));
    }

    lines.push(this.colorize('  ╠' + '─'.repeat(88) + '╣', 'dark_green'));

    // Last Signal
    lines.push(this.sectionLine('LAST SIGNAL', 'white_bold'));
    if (state.lastOpportunity) {
      const opp = state.lastOpportunity;
      const age = ((Date.now() - opp.timestamp) / 1000).toFixed(0);
      const status = opp.rejected
        ? this.colorize('REJECTED', 'red')
        : this.colorize(`SCORE: ${opp.score}`, opp.score >= 50 ? 'green' : 'yellow');
      lines.push(this.contentLine(
        `  ${status}  │  ` +
        `${opp.outcome} ${opp.orderType}  │  ` +
        `Fair: ${(opp.fairProbability * 100).toFixed(1)}%  │  ` +
        `Edge: ${this.colorize((opp.probabilityEdge * 100).toFixed(1) + '%', opp.probabilityEdge > 0.1 ? 'green' : 'yellow')}  │  ` +
        `T-${opp.timeRemainingS.toFixed(0)}s  │  ` +
        `${age}s ago`
      ));
      if (opp.rejected && opp.rejectionReasons.length > 0) {
        lines.push(this.contentLine(`  ${this.colorize('> Reason:', 'red')} ${opp.rejectionReasons[0]}`));
      }
    } else {
      lines.push(this.contentLine('  Scanning for opportunities...'));
    }

    lines.push(this.colorize('  ╠' + '─'.repeat(88) + '╣', 'dark_green'));

    // Recent Trades
    lines.push(this.sectionLine('RECENT TRADES', 'white_bold'));
    lines.push(this.contentLine(
      '  ' +
      this.colorize('ID', 'cyan').padEnd(24) +
      this.colorize('Side', 'cyan').padEnd(20) +
      this.colorize('Type', 'cyan').padEnd(17) +
      this.colorize('Entry', 'cyan').padEnd(18) +
      this.colorize('Exit', 'cyan').padEnd(18) +
      this.colorize('PnL', 'cyan').padEnd(20) +
      this.colorize('Reason', 'cyan')
    ));
    lines.push(this.contentLine('  ' + '─'.repeat(84)));

    const trades = state.recentTrades.slice(0, 8);
    if (trades.length === 0) {
      lines.push(this.contentLine('  Waiting for trades...'));
    }
    for (const trade of trades) {
      const pnl = trade.pnl !== null ? formatUsd(trade.pnl) : 'open';
      const pnlC = trade.status === TradeStatus.OPEN
        ? this.colorize(pnl, 'yellow')
        : (trade.pnl !== null && trade.pnl >= 0)
          ? this.colorize(pnl, 'green')
          : this.colorize(pnl, 'red');
      const exitP = trade.exitPrice !== null ? trade.exitPrice.toFixed(3) : '-';
      const reason = trade.exitReason?.summary ?? `Score: ${trade.entryReason.score}`;
      const typeStr = trade.orderType === 'MAKER' ? 'MKR' : 'TKR';
      lines.push(this.contentLine(
        '  ' +
        trade.id.substring(0, 13).padEnd(14) +
        `${trade.outcome} ${trade.side}`.padEnd(10) +
        typeStr.padEnd(7) +
        trade.entryPrice.toFixed(3).padEnd(8) +
        exitP.padEnd(8) +
        pnlC.padEnd(22) +
        reason.substring(0, 28)
      ));
    }

    // Bottom border
    lines.push(this.colorize('  ╠' + '═'.repeat(88) + '╣', 'cyan'));

    // Strategy info
    const stratInfo = `  Strategy: Last-Second Maker (T-${this.config.timing.entryWindowStartS}s to T-${this.config.timing.entryWindowEndS}s)  │  Press Ctrl+C to stop`;
    lines.push(this.colorize('  ║ ', 'cyan') + this.colorize(stratInfo, 'cyan').padEnd(87) + this.colorize('  ║', 'cyan'));
    lines.push(this.colorize('  ╚' + '═'.repeat(88) + '╝', 'cyan'));

    // Matrix-style bottom border
    let bottomBorder = '';
    for (let i = 0; i < 90; i++) {
      bottomBorder += matrixChars[Math.floor(Math.random() * 2)];
    }
    lines.push(this.colorize(`  ${bottomBorder}`, 'dark_green'));

    process.stdout.write(lines.join('\n') + '\n');
  }

  private sectionLine(title: string, color: string): string {
    const icon = '>';
    return this.colorize('  ║ ', 'cyan') +
      this.colorize(`${icon} ${title}`, color) +
      ' '.repeat(Math.max(0, 85 - title.length - 2)) +
      this.colorize(' ║', 'cyan');
  }

  private contentLine(content: string): string {
    return this.colorize('  ║', 'cyan') + content;
  }

  private colorize(text: string, color: string): string {
    const colors: Record<string, string> = {
      red: '\x1b[31m',
      green: '\x1b[32m',
      yellow: '\x1b[33m',
      cyan: '\x1b[36m',
      white_bold: '\x1b[1;37m',
      dim: '\x1b[2m',
      dark_green: '\x1b[2;32m',
      reset: '\x1b[0m',
    };
    const code = colors[color] || '';
    return `${code}${text}\x1b[0m`;
  }

  stop(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
  }
}
