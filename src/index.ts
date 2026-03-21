// ============================================================
// Polymarket Trading Bot — Main Bootstrap
//
// Wires all modules together and starts the system:
// 1. Config → Logger → Paper Engine → External Feed →
//    Market Data → Risk Manager → Opportunity Detector →
//    Strategy → Metrics → Dashboard
// 2. Enforces PAPER mode, blocks LIVE
// 3. Graceful shutdown on SIGINT/SIGTERM
// ============================================================

import { loadConfig } from './config';
import { initLogger, createModuleLogger } from './logger';
import { PaperTradingEngine } from './paper-trading';
import { ExternalPriceFeed } from './external-feed';
import { PolymarketDataClient } from './market-data';
import { RiskManager } from './risk-manager';
import { OpportunityDetector } from './opportunity';
import { StrategyEngine } from './strategy';
import { MetricsCollector } from './metrics';
import { Dashboard } from './dashboard';
import { TradingMode } from './types';

async function main(): Promise<void> {
  // --- 1. Load config ---
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

  // --- 4. Safety gate ---
  if (config.tradingMode === TradingMode.LIVE) {
    log.error(
      'LIVE mode is disabled in this version. ' +
      'Set TRADING_MODE=PAPER in .env. ' +
      'Live trading requires additional safety checks not yet implemented.'
    );
    process.exit(1);
  }

  log.info('Running in PAPER TRADE mode — no real money at risk');

  // --- 5. Initialize modules ---
  const paperEngine = new PaperTradingEngine(config);
  log.info('Paper trading engine ready');

  const externalFeed = new ExternalPriceFeed(config);
  const marketData = new PolymarketDataClient(config);

  // Couple simulated book to external BTC price so it tracks real movements
  marketData.setExternalPriceGetter(() => externalFeed.getCurrentPrice());
  const riskManager = new RiskManager(config);

  const detector = new OpportunityDetector(config, externalFeed, marketData);
  log.info('Opportunity detector ready');

  const strategy = new StrategyEngine(
    config,
    detector,
    riskManager,
    paperEngine,
    externalFeed,
    marketData
  );
  log.info('Strategy engine ready');

  const metrics = new MetricsCollector({
    config,
    paperEngine,
    riskManager,
    externalFeed,
    marketData,
    strategy,
  });

  const dashboard = new Dashboard(config, metrics, externalFeed);

  // --- 6. Graceful shutdown ---
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;

    log.info(`Received ${signal}, shutting down gracefully...`);

    dashboard.stop();
    strategy.stop();
    externalFeed.stop();
    marketData.stop();

    const finalState = paperEngine.getPortfolioState();
    log.info('='.repeat(60));
    log.info('FINAL PORTFOLIO STATE');
    log.info(`Balance: $${finalState.balance.toFixed(2)}`);
    log.info(`Total PnL: $${finalState.totalPnl.toFixed(2)}`);
    log.info(`Trades: ${finalState.totalTrades} (W: ${finalState.winCount} / L: ${finalState.lossCount})`);
    if (finalState.totalTrades > 0) {
      log.info(`Win Rate: ${((finalState.winCount / finalState.totalTrades) * 100).toFixed(1)}%`);
    }
    log.info('='.repeat(60));

    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // --- 7. Start data feeds ---
  log.info('Starting data feeds...');

  externalFeed.on('connected', () => {
    log.info('External feed connected — starting strategy');
    // Wait a few seconds for price buffer to fill before starting strategy
    setTimeout(() => {
      strategy.start();
      log.info('Strategy engine started');
    }, 5000);
  });

  externalFeed.on('fatal', (err: Error) => {
    log.error('External feed fatal error — halting', { error: err.message });
    riskManager.halt('External feed connection lost');
  });

  externalFeed.on('stale', () => {
    log.warn('External feed stale — risk manager notified');
  });

  externalFeed.start();
  marketData.start(2000);

  // --- 8. Start dashboard ---
  if (config.dashboard.enabled) {
    // Give feeds time to connect before dashboard starts
    setTimeout(() => {
      dashboard.start();
      log.info('Dashboard started');
    }, 3000);
  }

  // Keep process alive
  await new Promise<void>(() => {});
}

// --- Entry point ---
main().catch((err) => {
  console.error('FATAL: Unhandled error during startup:', err);
  process.exit(1);
});
