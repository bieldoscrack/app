// ============================================================
// Structured logger using Winston.
// Every trade decision, connection event, and error is logged
// with timestamp, level, module, and structured data.
// ============================================================

import * as winston from 'winston';
import * as path from 'path';
import * as fs from 'fs';
import { AppConfig } from '../types';

let logger: winston.Logger | null = null;

/**
 * Initialize the global logger. Must be called once at startup.
 */
export function initLogger(config: AppConfig): winston.Logger {
  if (logger) return logger;

  // Ensure log directory exists if file logging is enabled
  if (config.logging.toFile) {
    const logDir = path.resolve(process.cwd(), config.logging.dir);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
  }

  const logFormat = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ timestamp, level, message, module, ...meta }) => {
      const mod = module ? `[${module}]` : '';
      const metaStr = Object.keys(meta).length > 0
        ? ` ${JSON.stringify(meta)}`
        : '';
      return `${timestamp} ${level.toUpperCase().padEnd(5)} ${mod} ${message}${metaStr}`;
    })
  );

  const transports: winston.transport[] = [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        logFormat
      ),
    }),
  ];

  if (config.logging.toFile) {
    const logDir = path.resolve(process.cwd(), config.logging.dir);

    // Main log file — all levels
    transports.push(
      new winston.transports.File({
        filename: path.join(logDir, 'bot.log'),
        format: logFormat,
        maxsize: 10 * 1024 * 1024, // 10 MB
        maxFiles: 5,
      })
    );

    // Separate file for trades only — audit trail
    transports.push(
      new winston.transports.File({
        filename: path.join(logDir, 'trades.log'),
        format: winston.format.combine(
          winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
          winston.format.json()
        ),
        level: 'info',
        maxsize: 10 * 1024 * 1024,
        maxFiles: 10,
      })
    );

    // Error-only file for quick debugging
    transports.push(
      new winston.transports.File({
        filename: path.join(logDir, 'errors.log'),
        format: logFormat,
        level: 'error',
        maxsize: 5 * 1024 * 1024,
        maxFiles: 5,
      })
    );
  }

  logger = winston.createLogger({
    level: config.logging.level,
    transports,
    exitOnError: false,
  });

  return logger;
}

/**
 * Get the global logger instance.
 * Throws if called before initLogger().
 */
export function getLogger(): winston.Logger {
  if (!logger) {
    throw new Error('Logger not initialized. Call initLogger() first.');
  }
  return logger;
}

/**
 * Create a child logger scoped to a specific module.
 * Usage: const log = createModuleLogger('risk-manager');
 *        log.info('Risk check passed', { stake: 10 });
 */
export function createModuleLogger(moduleName: string): winston.Logger {
  return getLogger().child({ module: moduleName });
}
