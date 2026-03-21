// ============================================================
// Pure utility functions. No side effects, no state.
// ============================================================

import { TradingWindow } from '../types';

/**
 * Generate a unique window ID based on timestamp and duration.
 * Windows are aligned to clock boundaries (e.g., 5-min windows
 * start at :00, :05, :10, etc.)
 */
export function getWindowId(timestamp: number, durationSeconds: number): string {
  const durationMs = durationSeconds * 1000;
  const windowStart = Math.floor(timestamp / durationMs) * durationMs;
  return `window-${windowStart}`;
}

/**
 * Create a TradingWindow object for the current time.
 */
export function getCurrentWindow(durationSeconds: number): TradingWindow {
  const now = Date.now();
  const durationMs = durationSeconds * 1000;
  const windowStart = Math.floor(now / durationMs) * durationMs;
  const windowEnd = windowStart + durationMs;

  return {
    id: `window-${windowStart}`,
    startTimestamp: windowStart,
    endTimestamp: windowEnd,
    durationSeconds,
    tradeExecuted: false,
    tradeId: null,
  };
}

/**
 * Calculate percentage change between two numbers.
 */
export function pctChange(from: number, to: number): number {
  if (from === 0) return 0;
  return ((to - from) / from) * 100;
}

/**
 * Format a number as USD.
 */
export function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/**
 * Format a percentage.
 */
export function formatPct(pct: number): string {
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(2)}%`;
}

/**
 * Sleep for a given number of milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Format a timestamp as a human-readable date string.
 */
export function formatTimestamp(ts: number): string {
  return new Date(ts).toISOString().replace('T', ' ').replace('Z', '');
}

/**
 * Calculate elapsed time in a human-readable format.
 */
export function formatUptime(startTimestamp: number): string {
  const elapsed = Date.now() - startTimestamp;
  const seconds = Math.floor(elapsed / 1000) % 60;
  const minutes = Math.floor(elapsed / 60000) % 60;
  const hours = Math.floor(elapsed / 3600000);
  return `${hours}h ${minutes}m ${seconds}s`;
}
