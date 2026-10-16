// ---------------------------------------------------------------------------
// ABBA · Market & session definitions (shared between engine + dashboard)
// ---------------------------------------------------------------------------

export type SymbolCode = "EURUSD" | "GBPUSD" | "USDJPY" | "XAUUSD";

export interface SymbolSpec {
  code: SymbolCode;
  name: string;
  base: number;
  pip: number; // size of one pip in price terms
  decimals: number; // display decimals
  spreadPips: number; // typical spread in pips
  pipValuePerLot: number; // USD per pip per 1.00 lot
  sigmaPipsPerMin: number; // baseline 1-min volatility (pips)
}

export const SYMBOLS: SymbolSpec[] = [
  {
    code: "EURUSD",
    name: "Euro / US Dollar",
    base: 1.0874,
    pip: 0.0001,
    decimals: 5,
    spreadPips: 0.4,
    pipValuePerLot: 10,
    sigmaPipsPerMin: 1.5,
  },
  {
    code: "GBPUSD",
    name: "Pound / US Dollar",
    base: 1.2698,
    pip: 0.0001,
    decimals: 5,
    spreadPips: 0.6,
    pipValuePerLot: 10,
    sigmaPipsPerMin: 2.0,
  },
  {
    code: "USDJPY",
    name: "US Dollar / Yen",
    base: 149.32,
    pip: 0.01,
    decimals: 3,
    spreadPips: 0.5,
    pipValuePerLot: 6.7,
    sigmaPipsPerMin: 2.0,
  },
  {
    code: "XAUUSD",
    name: "Gold / US Dollar",
    base: 2331.6,
    pip: 0.1,
    decimals: 2,
    spreadPips: 2.4,
    pipValuePerLot: 1,
    sigmaPipsPerMin: 9,
  },
];

export const SYMBOL_MAP: Record<SymbolCode, SymbolSpec> = Object.fromEntries(
  SYMBOLS.map((s) => [s.code, s]),
) as Record<SymbolCode, SymbolSpec>;

// ---------------------------------------------------------------------------
// Sessions — each sim minute belongs to exactly one block (no overlaps) so the
// strategy runs single-threaded, matching Abba's sequential session rules.
// Times in UTC minutes from midnight.
// ---------------------------------------------------------------------------

export type SessionName = "London" | "New York" | "Asian";

export interface SessionSpec {
  name: SessionName;
  startMin: number; // UTC minute of day
  endMin: number;
  closeOutMin: number; // minutes before end when all positions are flattened
  volMult: number; // volatility multiplier for the session
  color: string; // accent for UI
}

export const SESSIONS: SessionSpec[] = [
  { name: "Asian", startMin: 0, endMin: 480, closeOutMin: 15, volMult: 0.7, color: "#8b9cf9" },
  { name: "London", startMin: 480, endMin: 810, closeOutMin: 15, volMult: 1.2, color: "#34f5a2" },
  { name: "New York", startMin: 810, endMin: 1260, closeOutMin: 15, volMult: 1.25, color: "#45e0ff" },
];

export const TARGET_PCT = 0.2; // 20% per-session profit target
export const START_EQUITY = 10_000;
export const BASE_RISK_PCT = 0.018; // 1.8% risk per trade (1–2% band)
export const LOSS_RISK_SCALE = 0.5; // next trade after a loss risks half

export const MAX_CONCURRENT_TRADES = 2;
export const MAX_CANDLES = 130;
export const MAX_EQUITY_POINTS = 900;
export const SYMBOL_COOLDOWN_MS = 3.5 * 60_000; // per-symbol re-entry cooldown
export const GLOBAL_COOLDOWN_MS = 30_000; // global gap between entries

export function sessionAt(simMinOfDay: number): SessionSpec | null {
  for (const s of SESSIONS) {
    if (simMinOfDay >= s.startMin && simMinOfDay < s.endMin) return s;
  }
  return null;
}

export function isLowLiquidity(simMinOfDay: number): boolean {
  // Session transitions + the thin late-NY window
  for (const s of SESSIONS) {
    if (Math.abs(simMinOfDay - s.startMin) < 10) return true;
  }
  if (simMinOfDay >= 1230 && simMinOfDay < 1260) return true;
  return false;
}
