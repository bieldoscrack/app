// ============================================================
// Configuration loader with strict validation via Zod.
// Updated: last-second strategy params, dynamic fees, maker mode.
// ============================================================

import * as dotenv from 'dotenv';
import * as path from 'path';
import { z } from 'zod';
import { AppConfig, TradingMode } from '../types';

// Load .env from project root
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

// --- Zod schema: strict, explicit, no silent defaults for critical fields ---

const envSchema = z.object({
  // Trading mode — defaults to PAPER, the only safe default
  TRADING_MODE: z
    .enum(['PAPER', 'LIVE'])
    .default('PAPER'),

  // Polymarket API — only required in LIVE mode
  POLYMARKET_API_KEY: z.string().default(''),
  POLYMARKET_API_SECRET: z.string().default(''),
  POLYMARKET_API_PASSPHRASE: z.string().default(''),
  POLYMARKET_CLOB_URL: z
    .string()
    .url()
    .default('https://clob.polymarket.com'),
  POLYMARKET_MARKET_ID: z.string().default(''),

  // External feed
  BINANCE_WS_URL: z
    .string()
    .default('wss://stream.binance.com:9443/ws'),
  EXTERNAL_SYMBOL: z.string().default('BTCUSDT'),

  // Risk limits
  MAX_STAKE_PER_TRADE: z.coerce.number().positive().default(2),
  MAX_TRADES_PER_HOUR: z.coerce.number().int().positive().default(9999),
  MAX_DAILY_DRAWDOWN: z.coerce.number().positive().default(50),
  MAX_CONSECUTIVE_LOSSES: z.coerce.number().int().positive().default(9999),

  // Paper trading
  PAPER_STARTING_BALANCE: z.coerce.number().positive().default(50),

  // Timing
  WINDOW_DURATION_SECONDS: z.coerce.number().int().positive().default(300),
  // Last-second entry window: start looking N seconds before window end
  ENTRY_WINDOW_START_S: z.coerce.number().positive().default(60),
  // Stop entering N seconds before window end (safety buffer for execution)
  ENTRY_WINDOW_END_S: z.coerce.number().nonnegative().default(3),

  // Fee configuration
  // Market type: '5m', '15m', '1h'
  MARKET_TYPE: z.enum(['5m', '15m', '1h']).default('5m'),
  // Prefer maker orders (0 fee + rebates) vs taker (pays fee)
  PREFER_MAKER: z
    .string()
    .default('true')
    .transform((v) => v.toLowerCase() === 'true'),

  // Logging
  LOG_LEVEL: z
    .enum(['debug', 'info', 'warn', 'error'])
    .default('info'),
  LOG_TO_FILE: z
    .string()
    .default('true')
    .transform((v) => v.toLowerCase() === 'true'),
  LOG_DIR: z.string().default('./logs'),

  // Dashboard
  DASHBOARD_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v.toLowerCase() === 'true'),
  DASHBOARD_REFRESH_MS: z.coerce.number().int().positive().default(1000),
});

/**
 * Validate that LIVE mode has all required API credentials.
 */
function validateLiveMode(env: z.infer<typeof envSchema>): void {
  if (env.TRADING_MODE !== 'LIVE') return;

  const missing: string[] = [];
  if (!env.POLYMARKET_API_KEY) missing.push('POLYMARKET_API_KEY');
  if (!env.POLYMARKET_API_SECRET) missing.push('POLYMARKET_API_SECRET');
  if (!env.POLYMARKET_API_PASSPHRASE) missing.push('POLYMARKET_API_PASSPHRASE');
  if (!env.POLYMARKET_MARKET_ID) missing.push('POLYMARKET_MARKET_ID');

  if (missing.length > 0) {
    throw new Error(
      `LIVE mode requires these env vars: ${missing.join(', ')}. ` +
      `Set TRADING_MODE=PAPER to run in simulation.`
    );
  }
}

/**
 * Load and validate configuration. Throws on any invalid state.
 */
export function loadConfig(): AppConfig {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const errors = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${errors}`);
  }

  const env = result.data;
  validateLiveMode(env);

  const config: AppConfig = {
    tradingMode: env.TRADING_MODE as TradingMode,

    polymarket: {
      apiKey: env.POLYMARKET_API_KEY,
      apiSecret: env.POLYMARKET_API_SECRET,
      apiPassphrase: env.POLYMARKET_API_PASSPHRASE,
      clobUrl: env.POLYMARKET_CLOB_URL,
      marketId: env.POLYMARKET_MARKET_ID,
    },

    externalFeed: {
      binanceWsUrl: env.BINANCE_WS_URL,
      symbol: env.EXTERNAL_SYMBOL,
    },

    risk: {
      maxStakePerTrade: env.MAX_STAKE_PER_TRADE,
      maxTradesPerHour: env.MAX_TRADES_PER_HOUR,
      maxDailyDrawdown: env.MAX_DAILY_DRAWDOWN,
      maxConsecutiveLosses: env.MAX_CONSECUTIVE_LOSSES,
    },

    paper: {
      startingBalance: env.PAPER_STARTING_BALANCE,
    },

    timing: {
      windowDurationSeconds: env.WINDOW_DURATION_SECONDS,
      entryWindowStartS: env.ENTRY_WINDOW_START_S,
      entryWindowEndS: env.ENTRY_WINDOW_END_S,
    },

    fees: {
      marketType: env.MARKET_TYPE,
      preferMaker: env.PREFER_MAKER,
    },

    logging: {
      level: env.LOG_LEVEL,
      toFile: env.LOG_TO_FILE,
      dir: env.LOG_DIR,
    },

    dashboard: {
      enabled: env.DASHBOARD_ENABLED,
      refreshMs: env.DASHBOARD_REFRESH_MS,
    },
  };

  return config;
}
