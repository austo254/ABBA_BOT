// Internal engine state persisted as JSONB in bot_state (single row)
import type { Candle, OpenTrade, SessionRuntime } from "./types";
import type { SymbolCode } from "./market";

export interface PriceState {
  price: number;
  openDay: number; // price at day start (for % change)
  trendDir: -1 | 0 | 1;
  trendStrength: number; // pips per minute drift (sim only)
  trendLifeMs: number; // remaining life of current trend regime (sim only)
  volMult: number; // current volatility multiplier (sim only)
  sweepAtMs: number; // next liquidity-sweep injection time (sim only)
  sweepDir: -1 | 0 | 1; // active sweep direction (0 = none)
  sweepLifeMs: number;
  sweepRevertMs: number;
  // edgeDir / edgeLifeMs intentionally removed — artificial post-entry
  // drift biased results and must not exist in live or realistic sim.
  candles: Candle[]; // closed 1-min candles (capped)
  cur: Candle | null; // forming candle
  cooldownUntil: number; // per-symbol re-entry cooldown (ms)
  /** Last tick timestamp from bridge (live). */
  lastTickMs?: number;
}

export interface EngineState {
  simNow: number;
  lastRealMs: number;
  running: boolean;
  /** Kill requested — blocks new entries. */
  killed: boolean;
  /** Kill confirmed by broker (all positions flat). Live only. */
  killConfirmed: boolean;
  speed: number; // sim acceleration factor (ignored in live / real-time)
  account: number; // realized equity (USD)
  dayKey: string; // date YYYY-MM-DD (UTC)
  markets: Record<SymbolCode, PriceState>;
  openTrades: OpenTrade[];
  sessions: SessionRuntime[];
  equityCurve: { t: number; eq: number }[];
  lastEntryAt: number;
  riskScale: number;
  connDownUntil: number; // ms; 0 = connected (sim uses this for random drops)
  nextConnEventAt: number; // sim-only random disconnect schedule
  newsActiveUntil: number;
  newsBlockFrom: number;
  newsLabel: string;
  nextNewsAt: number; // sim-only; live uses real calendar
  /** Last successful bridge heartbeat age (ms). Live only. */
  connHeartbeatMs: number | null;
  connStale: boolean;
  /** Timestamp of last worker tick (ms). Dashboard uses this to detect worker liveness. */
  workerHeartbeatMs: number;
  mode: "sim" | "live";
}
