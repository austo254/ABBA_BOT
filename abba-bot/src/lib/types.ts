// Shared types between the engine (server) and dashboard (client)
import type { SessionName, SymbolCode } from "./market";

export interface Candle {
  t: number; // sim epoch ms (open time)
  o: number;
  h: number;
  l: number;
  c: number;
}

export type TradeSide = "long" | "short";
export type SetupType = "Momentum Break" | "Liquidity Sweep" | "Micro Reversal";

export interface OpenTrade {
  id: number;
  sessionKey: string;
  session: SessionName;
  symbol: SymbolCode;
  side: TradeSide;
  qty: number; // lots
  entry: number;
  sl: number; // current (trailing) stop
  slInit: number;
  tp: number;
  riskPct: number;
  setup: SetupType;
  openedSim: number;
  beDone: boolean; // breakeven lock applied
  /** Broker ticket when running live; undefined in pure simulation. */
  brokerTicket?: number;
}

export interface ClosedTradeRow {
  id: number;
  sessionKey: string;
  session: string;
  symbol: string;
  side: TradeSide;
  qty: number;
  entryPrice: number;
  exitPrice: number;
  sl: number;
  tp: number;
  slFinal: number;
  pnl: number;
  pips: number;
  riskPct: number;
  setup: string;
  exitReason: string | null;
  openedSim: number;
  closedSim: number | null;
}

export type SessionStatus = "waiting" | "trading" | "target_hit" | "closed" | "closeout";

export interface SessionRuntime {
  key: string;
  name: SessionName;
  simDate: string;
  startEquity: number;
  equity: number;
  targetPct: number;
  status: SessionStatus;
  trades: number;
  wins: number;
  losses: number;
  peak: number; // highest intraday return fraction seen
  logged: boolean; // end-of-session report written
}

export interface EventRow {
  id: number;
  simTime: number;
  type: string;
  level: "info" | "success" | "warn" | "danger";
  message: string;
}

export interface SessionHistoryRow {
  id: number;
  key: string;
  name: string;
  simDate: string;
  startEquity: number;
  endEquity: number | null;
  targetPct: number;
  status: string;
  tradesCount: number;
  wins: number;
  losses: number;
  startedSim: number;
  endedSim: number | null;
}

export interface MarketSnap {
  price: number;
  openDay: number;
  spreadPips: number;
  candles: Candle[];
}

export interface EngineSnapshot {
  ok: boolean;
  simNow: number;
  realNow: number;
  running: boolean;
  /** True once a kill has been requested (blocks new entries). */
  killed: boolean;
  /** True only after broker confirms all ABBA positions are flat. */
  killConfirmed: boolean;
  speed: number;
  account: number;
  /** Terminal connection is up and feed is not stale. */
  connUp: boolean;
  connDownUntil: number;
  /** Age of last successful bridge heartbeat in ms (null in sim). */
  connHeartbeatMs: number | null;
  /** Feed marked stale by bridge. */
  connStale: boolean;
  newsActive: boolean;
  newsLabel: string;
  nextNewsIn: number; // ms until next red news (0 if unknown)
  sessions: SessionRuntime[];
  sessionHistory: SessionHistoryRow[];
  openTrades: OpenTrade[];
  recentTrades: ClosedTradeRow[];
  events: EventRow[];
  markets: Partial<Record<SymbolCode, MarketSnap>>;
  equityCurve: { t: number; eq: number }[];
  dayKey: string;
  /** "sim" | "live" */
  mode: "sim" | "live";
  /** Worker process is advancing the engine (true when not dashboard-driven). */
  workerAlive: boolean;
}

export type ControlAction =
  | { action: "speed"; speed: number }
  | { action: "toggle" }
  | { action: "kill" }
  | { action: "resume" }
  | { action: "disconnect" }
  | { action: "reset" }
  | { action: "reconcile" };
