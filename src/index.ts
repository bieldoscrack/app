// ============================================================
// Polymarket Trading Bot — Main Bootstrap
//
// This is the entry point. It:
// 1. Loads and validates configuration
// 2. Initializes the logger
// 3. Enforces PAPER mode by default
// 4. Initializes core modules
// 5. Starts the main loop (placeholder for now)
// ============================================================

import { loadConfig } from './config';
import { initLogger, createModuleLogger } from './logger';
import { PaperTradingEngine } from './paper-trading';
import { TradingMode } from './types';

async function main(): Promise<void> {
  // --- 1. Load config (fails fast on bad env) ---
  const config = loadConfig();

  // --- 2. Initialize logger ---
  initLogger(config);
  const log = createModuleLogger('main');

  // --- 3. Banner ---
  log.info('='.repeat(60));
  log.info('Polymarket Trading Bot — Starting');
  log.info(`Mode: ${config.tradingMode}`);
  log.info(`Symbol: ${config.externalFeed.symbol}`);
  log.info(`Window: ${config.timing.windowDurationSeconds}s`);
  log.info(`Max stake/trade: $${config.risk.maxStakePerTrade}`);
  log.info(`Max trades/hour: ${config.risk.maxTradesPerHour}`);
  log.info('='.repeat(60));

  // --- 4. Safety gate: block LIVE mode unless explicitly confirmed ---
  if (config.tradingMode === TradingMode.LIVE) {
    log.error(
      'LIVE mode is disabled in this version. ' +
      'Set TRADING_MODE=PAPER in .env. ' +
      'Live trading requires additional safety checks not yet implemented.'
    );
    process.exit(1);
  }

  log.info('Running in PAPER TRADE mode — no real money at risk');

  // --- 5. Initialize paper trading engine ---
  const paperEngine = new PaperTradingEngine(config);
  const portfolio = paperEngine.getPortfolioState();
  log.info('Paper trading engine ready', {
    balance: portfolio.balance,
    startingBalance: portfolio.startingBalance,
  });

  // --- 6. Graceful shutdown handler ---
  const shutdown = (signal: string) => {
    log.info(`Received ${signal}, shutting down gracefully...`);
    const finalState = paperEngine.getPortfolioState();
    log.info('Final portfolio state', {
      balance: finalState.balance,
      totalPnl: finalState.totalPnl,
      totalTrades: finalState.totalTrades,
      winCount: finalState.winCount,
      lossCount: finalState.lossCount,
    });
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // --- 7. Main loop placeholder ---
  log.info('Foundation initialized. Modules pending: market-data, external-feed, opportunity, strategy, execution, risk-manager, dashboard');
  log.info('Bot is idle — awaiting module implementation (Etapas 3-7)');

  // Keep process alive
  await new Promise<void>(() => {
    // Intentionally never resolves — process stays alive until signal
  });
}

// --- Entry point ---
main().catch((err) => {
  console.error('FATAL: Unhandled error during startup:', err);
  process.exit(1);
});
