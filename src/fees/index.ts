// ============================================================
// Polymarket Dynamic Fee Calculator
//
// Polymarket uses dynamic taker fees on crypto markets:
// - 5-min markets: max 0.44% at 50% probability
// - 15-min markets: max 1.56% at 50% probability
// - Fee = 0 at extremes (0% or 100% probability)
// - Makers pay NO fees and earn daily rebates
//
// Fee curve: fee = maxFee * (1 - |2 * price - 1|)
// This creates a parabolic curve peaking at price = 0.50
// ============================================================

import { OrderType } from '../types';

/** Max taker fee rates by market type (as fraction, not %) */
const MAX_TAKER_FEE: Record<string, number> = {
  '5m': 0.0044,   // 0.44%
  '15m': 0.0156,  // 1.56%
  '1h': 0.0156,   // 1.56% (same as 15m)
};

/**
 * Calculate the taker fee for a given share price and market type.
 *
 * @param price - Share price (0 to 1)
 * @param marketType - '5m', '15m', or '1h'
 * @param orderType - MAKER (0 fee) or TAKER
 * @returns Fee rate as a fraction (e.g., 0.0044 = 0.44%)
 */
export function calculateFeeRate(
  price: number,
  marketType: string,
  orderType: OrderType
): number {
  // Makers pay NO fee
  if (orderType === OrderType.MAKER) return 0;

  const maxFee = MAX_TAKER_FEE[marketType] ?? MAX_TAKER_FEE['5m'];

  // Fee curve: parabolic, peaks at 0.50, zero at 0 and 1
  // fee = maxFee * (1 - |2 * price - 1|)
  // At price 0.50: fee = maxFee * (1 - 0) = maxFee
  // At price 0.90: fee = maxFee * (1 - 0.8) = maxFee * 0.2
  // At price 0.99: fee = maxFee * (1 - 0.98) = maxFee * 0.02
  const feeRate = maxFee * (1 - Math.abs(2 * price - 1));

  return Math.max(0, feeRate);
}

/**
 * Calculate fee in USDC for a given trade.
 *
 * @param stake - Trade size in USDC
 * @param price - Share price (0 to 1)
 * @param marketType - '5m', '15m', or '1h'
 * @param orderType - MAKER or TAKER
 * @returns Fee in USDC
 */
export function calculateFeeUsd(
  stake: number,
  price: number,
  marketType: string,
  orderType: OrderType
): number {
  const rate = calculateFeeRate(price, marketType, orderType);
  const fee = stake * rate;
  // Polymarket rounds to 4 decimal places, minimum 0.0001 or 0
  if (fee < 0.00005) return 0;
  return Math.round(fee * 10000) / 10000;
}

/**
 * Get the feeRateBps for order signing (required by Polymarket API).
 * Returns 0 for maker orders.
 */
export function getFeeRateBps(
  price: number,
  marketType: string,
  orderType: OrderType
): number {
  const rate = calculateFeeRate(price, marketType, orderType);
  return Math.round(rate * 10000); // Convert to basis points
}
