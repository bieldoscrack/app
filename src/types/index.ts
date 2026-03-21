// ============================================================
// Global types for the Polymarket Trading Bot v2
// Updated: maker-first strategy, dynamic fees, last-second edge
// ============================================================

/** Trading mode — PAPER is simulated, LIVE is real money */
export enum TradingMode {
  PAPER = 'PAPER',
  LIVE = 'LIVE',
}

/** Side of a trade */
export enum TradeSide {
  BUY = 'BUY',
  SELL = 'SELL',
}

/** Outcome of a binary market */
export enum MarketOutcome {
  YES = 'YES',
  NO = 'NO',
}

/** Status of a trade through its lifecycle */
export enum TradeStatus {
  PENDING = 'PENDING',
  OPEN = 'OPEN',
  CLOSED = 'CLOSED',
  CANCELLED = 'CANCELLED',
  EXPIRED = 'EXPIRED',
}

/** Order type — maker (limit) vs taker (market) */
export enum OrderType {
  MAKER = 'MAKER',
  TAKER = 'TAKER',
}

/** Why a trade was entered */
export interface EntryReason {
  /** Score from the opportunity detector (0-100) */
  score: number;
  /** External price movement detected (e.g., +0.35%) */
  externalMovementPct: number;
  /** Was movement persistence confirmed? */
  persistenceConfirmed: boolean;
  /** Spread at time of entry in basis points */
  spreadBps: number;
  /** Estimated liquidity available in USDC */
  liquidityUsd: number;
  /** Fair probability calculated at entry */
  fairProbability: number;
  /** Probability edge at entry (fair - book price) */
  probabilityEdge: number;
  /** Time remaining in window at entry (seconds) */
  timeRemainingS: number;
  /** Order type used */
  orderType: OrderType;
  /** Human-readable summary */
  summary: string;
}

/** Why a trade was exited */
export interface ExitReason {
  /** Type of exit */
  type: 'target' | 'timeout' | 'stop_loss' | 'manual' | 'risk_halt' | 'window_end';
  /** Human-readable summary */
  summary: string;
}

/** A single trade record */
export interface Trade {
  id: string;
  marketId: string;
  outcome: MarketOutcome;
  side: TradeSide;
  status: TradeStatus;
  mode: TradingMode;
  orderType: OrderType;

  /** Entry details */
  entryPrice: number;
  entryTimestamp: number;
  entryReason: EntryReason;
  stake: number;
  /** Number of shares purchased (stake / entryPrice) */
  shares: number;

  /** Exit details (null while open) */
  exitPrice: number | null;
  exitTimestamp: number | null;
  exitReason: ExitReason | null;

  /** Profit/loss in USDC (null while open) */
  pnl: number | null;
  /** Fee paid in USDC */
  feePaid: number;

  /** The trading window this trade belongs to */
  windowId: string;
}

/** Snapshot of a Polymarket order book level */
export interface OrderBookLevel {
  price: number;
  size: number;
}

/** Polymarket order book snapshot */
export interface OrderBook {
  marketId: string;
  timestamp: number;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  bestBid: number;
  bestAsk: number;
  spread: number;
  midPrice: number;
}

/** External price tick from Binance or similar */
export interface ExternalPriceTick {
  symbol: string;
  price: number;
  timestamp: number;
  source: string;
}

/** A time window for trading (e.g., 5-minute window) */
export interface TradingWindow {
  id: string;
  startTimestamp: number;
  endTimestamp: number;
  durationSeconds: number;
  /** Has a trade already been placed in this window? */
  tradeExecuted: boolean;
  tradeId: string | null;
}

/** Opportunity detected by the detector */
export interface Opportunity {
  timestamp: number;
  marketId: string;
  outcome: MarketOutcome;
  side: TradeSide;
  orderType: OrderType;
  score: number;
  externalMovementPct: number;
  persistenceConfirmed: boolean;
  spreadBps: number;
  liquidityUsd: number;
  suggestedStake: number;
  suggestedEntryPrice: number;
  fairProbability: number;
  probabilityEdge: number;
  timeRemainingS: number;
  reasons: string[];
  rejected: boolean;
  rejectionReasons: string[];
}

/** Risk manager state */
export interface RiskState {
  tradesThisHour: number;
  consecutiveLosses: number;
  dailyPnl: number;
  dailyDrawdown: number;
  isHalted: boolean;
  haltReason: string | null;
  lastResetTimestamp: number;
}

/** Portfolio state */
export interface PortfolioState {
  balance: number;
  startingBalance: number;
  openTrades: Trade[];
  closedTrades: Trade[];
  totalPnl: number;
  winCount: number;
  lossCount: number;
  totalTrades: number;
  totalFeesPaid: number;
}

/** Connection status for feeds */
export interface ConnectionStatus {
  source: string;
  connected: boolean;
  lastMessageTimestamp: number | null;
  reconnectCount: number;
  latencyMs: number | null;
}

/** Dashboard state — everything the dashboard needs to render */
export interface DashboardState {
  mode: TradingMode;
  uptime: number;
  portfolio: PortfolioState;
  risk: RiskState;
  connections: ConnectionStatus[];
  currentWindow: TradingWindow | null;
  lastOpportunity: Opportunity | null;
  recentTrades: Trade[];
}

/** Application configuration (validated at startup) */
export interface AppConfig {
  tradingMode: TradingMode;

  polymarket: {
    apiKey: string;
    apiSecret: string;
    apiPassphrase: string;
    clobUrl: string;
    marketId: string;
  };

  externalFeed: {
    binanceWsUrl: string;
    symbol: string;
  };

  risk: {
    maxStakePerTrade: number;
    maxTradesPerHour: number;
    maxDailyDrawdown: number;
    maxConsecutiveLosses: number;
  };

  paper: {
    startingBalance: number;
  };

  timing: {
    windowDurationSeconds: number;
    /** Seconds before window end to start looking for entries */
    entryWindowStartS: number;
    /** Seconds before window end to stop entering (safety buffer) */
    entryWindowEndS: number;
  };

  fees: {
    /** Market duration type: '5m', '15m', '1h' */
    marketType: string;
    /** Whether to use maker orders (no fee + rebates) */
    preferMaker: boolean;
  };

  logging: {
    level: string;
    toFile: boolean;
    dir: string;
  };

  dashboard: {
    enabled: boolean;
    refreshMs: number;
  };
}
