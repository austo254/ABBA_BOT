// ---------------------------------------------------------------------------
// ABBA · Autonomous MT5 scalping engine
// ---------------------------------------------------------------------------
// DB-backed engine. In simulation, time advances at `speed`× (legacy demo).
// In live mode (TRADING_MODE=live) the engine uses wall-clock time, pulls
// ticks/bars from the Python MT5 bridge, sizes positions from real contract
// specs, and never advances unless the persistent worker is running.
//
// Critical invariants for live:
//   1. Dashboard GET /api/engine is read-only (does NOT advance).
//   2. Persistent worker owns the tick loop.
//   3. Kill switch blocks entries immediately and flattens at the broker;
//      status distinguishes requested vs confirmed.
//   4. Connection status comes from bridge heartbeat + stale-tick checks.
//   5. Risk uses monetary stop distance × pip_value_per_lot from the broker.
//   6. Startup reconciles DB ↔ broker positions (no forgotten / duplicate).
//   7. Sessions & news use real UTC timestamps + economic calendar.
//   8. No artificial post-entry price drift (edgeDir removed).
// ---------------------------------------------------------------------------

import { db } from "@/db";
import { botState, events, sessionLogs, trades } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import {
  BASE_RISK_PCT,
  GLOBAL_COOLDOWN_MS,
  LOSS_RISK_SCALE,
  MAX_CANDLES,
  MAX_CONCURRENT_TRADES,
  MAX_EQUITY_POINTS,
  SESSIONS,
  START_EQUITY,
  SYMBOLS,
  SYMBOL_COOLDOWN_MS,
  SYMBOL_MAP,
  TARGET_PCT,
  isLowLiquidity,
  sessionAt,
  type SessionSpec,
  type SymbolCode,
  type SymbolSpec,
} from "./market";
import type { EngineState, PriceState } from "./engine-state";
import type {
  Candle,
  ClosedTradeRow,
  ControlAction,
  EngineSnapshot,
  EventRow,
  OpenTrade,
  SessionRuntime,
  SetupType,
} from "./types";
import {
  isLive,
  getHealth,
  getTicks,
  getBars,
  getSpecs,
  placeOrder,
  modifyPosition,
  closePosition,
  killSwitch,
  unkill,
  sizeByRisk,
  reconcilePositions,
  refreshNewsCalendar,
  newsWindowAt,
  type SymbolContractSpec,
  type Tick,
} from "./broker";

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const MAX_SIM_JUMP = 8 * HOUR; // largest catch-up advance per tick
const MAX_STEPS = 900;

const NEWS_LABELS = [
  "USD CPI m/m",
  "USD Non-Farm Payrolls",
  "EUR ECB Rate Decision",
  "GBP BoE MPC Vote",
  "USD FOMC Minutes",
  "JPY BoJ Outlook Report",
  "USD Retail Sales m/m",
  "EUR German ZEW Sentiment",
];

// ---------------------------------------------------------------------------
// Small math helpers
// ---------------------------------------------------------------------------

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const randPick = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

let gaussSpare: number | null = null;
function gauss(): number {
  if (gaussSpare !== null) {
    const v = gaussSpare;
    gaussSpare = null;
    return v;
  }
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const m = Math.sqrt(-2 * Math.log(u));
  gaussSpare = m * Math.sin(2 * Math.PI * v);
  return m * Math.cos(2 * Math.PI * v);
}

function emaSeries(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = values[0] ?? 0;
  for (const v of values) {
    prev = v * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

function atrPips(candles: Candle[], pip: number, period = 14): number {
  if (candles.length < 2) return 8;
  const n = Math.min(period, candles.length);
  let sum = 0;
  for (let i = candles.length - n; i < candles.length; i++) {
    sum += (candles[i].h - candles[i].l) / pip;
  }
  return sum / n || 8;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const r2 = (v: number) => Math.round(v * 100) / 100;

// ---------------------------------------------------------------------------
// State initialisation
// ---------------------------------------------------------------------------

function freshMarketState(spec: SymbolSpec): PriceState {
  const jitter = spec.pip * rand(-30, 30);
  const price = spec.base + jitter;
  return {
    price,
    openDay: price,
    trendDir: 0,
    trendStrength: 0,
    trendLifeMs: 0,
    volMult: 1,
    sweepAtMs: rand(10, 40) * MIN,
    sweepDir: 0,
    sweepLifeMs: 0,
    sweepRevertMs: 0,
    candles: [],
    cur: null,
    cooldownUntil: 0,
  };
}

function simDateStr(simNow: number): string {
  const d = new Date(simNow);
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${d.getUTCFullYear()}-${m}-${day}`;
}

function sessionKey(name: string, date: string) {
  return `${name}|${date}`;
}

function freshSessions(date: string, account: number): SessionRuntime[] {
  return SESSIONS.map((s) => ({
    key: sessionKey(s.name, date),
    name: s.name,
    simDate: date,
    startEquity: account,
    equity: account,
    targetPct: TARGET_PCT,
    status: "waiting" as const,
    trades: 0,
    wins: 0,
    losses: 0,
    peak: 0,
    logged: false,
  }));
}

export function createInitialState(simNow: number): EngineState {
  const date = simDateStr(simNow);
  const markets = {} as EngineState["markets"];
  for (const spec of SYMBOLS) markets[spec.code] = freshMarketState(spec);
  const live = isLive();
  return {
    simNow: live ? Date.now() : simNow,
    lastRealMs: Date.now(),
    running: true,
    killed: false,
    killConfirmed: false,
    speed: live ? 1 : 60,
    account: START_EQUITY,
    dayKey: date,
    markets,
    openTrades: [],
    sessions: freshSessions(date, START_EQUITY),
    equityCurve: [{ t: live ? Date.now() : simNow, eq: START_EQUITY }],
    lastEntryAt: 0,
    riskScale: 1,
    connDownUntil: 0,
    nextConnEventAt: live ? 0 : simNow + rand(35, 90) * MIN,
    newsActiveUntil: 0,
    newsBlockFrom: 0,
    newsLabel: "",
    nextNewsAt: live ? 0 : simNow + rand(45, 150) * MIN,
    connHeartbeatMs: null,
    connStale: false,
    workerHeartbeatMs: 0,
    mode: live ? "live" : "sim",
  };
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

function migrateState(raw: EngineState): EngineState {
  // Backfill fields introduced for live bridge / worker so old DB rows load cleanly.
  if (raw.killConfirmed === undefined) raw.killConfirmed = false;
  if (raw.connHeartbeatMs === undefined) raw.connHeartbeatMs = null;
  if (raw.connStale === undefined) raw.connStale = false;
  if (raw.workerHeartbeatMs === undefined) raw.workerHeartbeatMs = 0;
  if (!raw.mode) raw.mode = isLive() ? "live" : "sim";
  for (const code of Object.keys(raw.markets) as SymbolCode[]) {
    const m = raw.markets[code] as PriceState & { edgeDir?: number; edgeLifeMs?: number };
    // Drop legacy edge fields if present
    delete m.edgeDir;
    delete m.edgeLifeMs;
  }
  return raw;
}

async function loadState(): Promise<EngineState> {
  const rows = await db.select().from(botState).where(eq(botState.id, 1));
  const row = rows[0];
  if (row?.state) return migrateState(row.state);
  const init = createInitialState(Date.now());
  await db
    .insert(botState)
    .values({ id: 1, state: init })
    .onConflictDoUpdate({ target: botState.id, set: { state: init } });
  return init;
}

async function saveState(state: EngineState) {
  await db
    .insert(botState)
    .values({ id: 1, state })
    .onConflictDoUpdate({
      target: botState.id,
      set: { state, updatedAt: new Date() },
    });
}

async function logEvent(
  state: EngineState,
  type: string,
  level: EventRow["level"],
  message: string,
) {
  await db.insert(events).values({ simTime: state.simNow, type, level, message });
}

// ---------------------------------------------------------------------------
// Trade lifecycle
// ---------------------------------------------------------------------------

function unrealisedPnl(state: EngineState, t: OpenTrade): number {
  const m = state.markets[t.symbol];
  const spec = SYMBOL_MAP[t.symbol];
  const gross = t.side === "long" ? (m.price - t.entry) / spec.pip : (t.entry - m.price) / spec.pip;
  return (gross - spec.spreadPips) * t.qty * spec.pipValuePerLot;
}

function sessionEquity(state: EngineState, rt: SessionRuntime): number {
  let eq = state.account;
  for (const t of state.openTrades) if (t.sessionKey === rt.key) eq += unrealisedPnl(state, t);
  return eq;
}

async function closeTrade(
  state: EngineState,
  t: OpenTrade,
  exitPrice: number,
  reason: string,
  countTowardSession: boolean,
) {
  const spec = SYMBOL_MAP[t.symbol];
  const gross = t.side === "long" ? (exitPrice - t.entry) / spec.pip : (t.entry - exitPrice) / spec.pip;
  const net = gross - spec.spreadPips;
  const pnl = r2(net * t.qty * spec.pipValuePerLot);
  state.account = r2(state.account + pnl);

  const rt = state.sessions.find((s) => s.key === t.sessionKey);
  if (rt && countTowardSession) {
    rt.trades += 1;
    if (pnl > 0) rt.wins += 1;
    else rt.losses += 1;
  }

  // Position-size discipline: after a loss, the next trade risks half
  state.riskScale = pnl < 0 ? LOSS_RISK_SCALE : 1;
  state.markets[t.symbol].cooldownUntil = state.simNow + SYMBOL_COOLDOWN_MS;
  state.lastEntryAt = state.simNow;
  state.openTrades = state.openTrades.filter((x) => x.id !== t.id);

  await db
    .update(trades)
    .set({
      status: "closed",
      exitPrice,
      slFinal: t.sl,
      pnl,
      pips: r2(net),
      exitReason: reason,
      closedSim: state.simNow,
    })
    .where(eq(trades.id, t.id));

  const sign = t.side === "long" ? "LONG" : "SHORT";
  const level: EventRow["level"] = pnl > 0 ? "success" : pnl < 0 ? "danger" : "info";
  const pnlStr = `${pnl >= 0 ? "+" : "-"}$${Math.abs(pnl).toFixed(2)}`;
  await logEvent(
    state,
    pnl < 0 && reason === "Stop loss hit" ? "stop_hit" : "trade_close",
    level,
    `${reason} · ${sign} ${t.qty.toFixed(2)} ${t.symbol} @${exitPrice.toFixed(spec.decimals)} → ${pnlStr} (${net.toFixed(1)}p)`,
  );
}

/** Live contract specs cached per tick cycle. */
let liveSpecs: Record<string, SymbolContractSpec> = {};

async function openTrade(
  state: EngineState,
  spec: SymbolSpec,
  side: "long" | "short",
  setup: SetupType,
  rt: SessionRuntime,
) {
  const atr = atrPips(state.markets[spec.code].candles, spec.pip);
  const slPips = clamp(atr * 1.15, 7, 12);
  const tpPips = clamp(slPips * 1.5, 10, 15);
  const riskPct = BASE_RISK_PCT * state.riskScale;

  const m = state.markets[spec.code];
  const entry = m.price;
  const sl = side === "long" ? entry - slPips * spec.pip : entry + slPips * spec.pip;
  const tp = side === "long" ? entry + tpPips * spec.pip : entry - tpPips * spec.pip;

  // ---- Broker-aware position sizing ----------------------------------------
  // Live: monetary loss at SL using real pip_value_per_lot / volume_min.
  // If min lot exceeds risk budget → skip the trade (do not clamp up).
  let qty: number;
  let contract = liveSpecs[spec.code];
  if (state.mode === "live" && contract) {
    const sized = sizeByRisk({
      equity: state.account,
      riskPct,
      entry,
      stop: sl,
      side,
      pip: contract.pip || spec.pip,
      pipValuePerLot: contract.pip_value_per_lot || spec.pipValuePerLot,
      volumeMin: contract.volume_min || 0.01,
      volumeStep: contract.volume_step || 0.01,
      volumeMax: Math.min(contract.volume_max || 5, 5),
    });
    if (!sized) {
      await logEvent(
        state,
        "skip_size",
        "warn",
        `Skip ${side.toUpperCase()} ${spec.code} — min lot exceeds ${(riskPct * 100).toFixed(2)}% risk budget`,
      );
      return;
    }
    qty = sized.lots;
  } else {
    // Simulation: same formula, fixed specs from market.ts — still skip if
    // min lot would blow the risk (no artificial 0.05 floor that violates risk).
    const sized = sizeByRisk({
      equity: state.account,
      riskPct,
      entry,
      stop: sl,
      side,
      pip: spec.pip,
      pipValuePerLot: spec.pipValuePerLot,
      volumeMin: 0.01,
      volumeStep: 0.01,
      volumeMax: 5,
    });
    if (!sized) {
      await logEvent(
        state,
        "skip_size",
        "warn",
        `Skip ${side.toUpperCase()} ${spec.code} — min lot exceeds risk budget`,
      );
      return;
    }
    qty = sized.lots;
  }

  // ---- Live: send market order to bridge -----------------------------------
  let brokerTicket: number | undefined;
  let fillPrice = entry;
  if (state.mode === "live") {
    if (state.killed) return;
    try {
      const result = await placeOrder({
        symbol: spec.code,
        side,
        volume: qty,
        sl,
        tp,
        comment: `ABBA ${setup}`.slice(0, 31),
      });
      brokerTicket = result.ticket;
      fillPrice = result.price || entry;
      qty = result.volume || qty;
    } catch (err) {
      await logEvent(
        state,
        "order_reject",
        "danger",
        `Order rejected ${side.toUpperCase()} ${spec.code}: ${err instanceof Error ? err.message : err}`,
      );
      return;
    }
  }

  const inserted = await db
    .insert(trades)
    .values({
      sessionKey: rt.key,
      session: rt.name,
      symbol: spec.code,
      side,
      qty,
      entryPrice: fillPrice,
      sl,
      tp,
      slFinal: sl,
      riskPct,
      status: "open",
      setup,
      openedSim: state.simNow,
    })
    .returning({ id: trades.id });

  const id = inserted[0]?.id ?? -1;
  const ot: OpenTrade = {
    id,
    sessionKey: rt.key,
    session: rt.name,
    symbol: spec.code,
    side,
    qty,
    entry: fillPrice,
    sl,
    slInit: sl,
    tp,
    riskPct,
    setup,
    openedSim: state.simNow,
    beDone: false,
    brokerTicket,
  };
  state.openTrades.push(ot);
  state.lastEntryAt = state.simNow;

  // Artificial post-entry edge drift intentionally removed.
  // Simulator results must not be biased by entry-related price drift.

  await logEvent(
    state,
    "trade_open",
    "info",
    `${side === "long" ? "LONG" : "SHORT"} ${qty.toFixed(2)} ${spec.code} @${fillPrice.toFixed(spec.decimals)} · ${setup} · SL ${slPips.toFixed(1)}p / TP ${tpPips.toFixed(1)}p · risk ${(riskPct * 100).toFixed(2)}%${brokerTicket ? ` · ticket ${brokerTicket}` : ""}`,
  );
}

// ---------------------------------------------------------------------------
// Strategy — signal evaluation on each closed 1-min candle
// ---------------------------------------------------------------------------

async function evaluateEntry(state: EngineState, code: SymbolCode, rt: SessionRuntime) {
  const m = state.markets[code];
  const cs = m.candles;
  if (cs.length < 36) return;

  const spec = SYMBOL_MAP[code];
  const closes = cs.map((c) => c.c);
  const fast = emaSeries(closes, 5);
  const slow = emaSeries(closes, 13);
  const mean = emaSeries(closes, 20);
  const atr = atrPips(cs, spec.pip);
  const i = cs.length - 1;
  const c1 = cs[i];
  const f = fast[i];
  const fPrev = fast[i - 1];
  const s = slow[i];
  const atrPx = atr * spec.pip;

  let priorHigh10 = -Infinity;
  let priorHigh20 = -Infinity;
  let priorLow10 = Infinity;
  let priorLow20 = Infinity;
  for (let j = i - 20; j < i; j++) {
    const c = cs[j];
    if (!c) continue;
    if (j >= i - 10) {
      if (c.h > priorHigh10) priorHigh10 = c.h;
      if (c.l < priorLow10) priorLow10 = c.l;
    }
    if (c.h > priorHigh20) priorHigh20 = c.h;
    if (c.l < priorLow20) priorLow20 = c.l;
  }
  if (!isFinite(priorHigh20) || !isFinite(priorLow20)) return;

  const range = c1.h - c1.l || spec.pip;
  const closesUp = c1.c > c1.o;
  const rangePos = (c1.c - c1.l) / range; // 1 = closed at high

  let side: "long" | "short" | null = null;
  let setup: SetupType | null = null;

  // never chase a momentum break straight into an active sweep reversion
  const reversionBlocksLong = m.sweepRevertMs > 0 && m.sweepDir === 1;
  const reversionBlocksShort = m.sweepRevertMs > 0 && m.sweepDir === -1;

  // 1) Liquidity sweep: wick runs stops beyond the 20-bar extreme, then reclaims
  if (c1.l < priorLow20 - 0.1 * atrPx && rangePos > 0.55 && closesUp) {
    side = "long";
    setup = "Liquidity Sweep";
  } else if (c1.h > priorHigh20 + 0.1 * atrPx && rangePos < 0.45 && !closesUp) {
    side = "short";
    setup = "Liquidity Sweep";
  }
  // 2) Momentum break: close through the 10-bar extreme with EMA trend support
  else if (c1.c > priorHigh10 + 0.15 * atrPx && f > s && f > fPrev && closesUp && !reversionBlocksLong) {
    side = "long";
    setup = "Momentum Break";
  } else if (c1.c < priorLow10 - 0.15 * atrPx && f < s && f < fPrev && !closesUp && !reversionBlocksShort) {
    side = "short";
    setup = "Momentum Break";
  }
  // 3) Micro reversal: stretched from the mean, candle closes back toward it
  else if (c1.c < mean[i] - 1.7 * atrPx && closesUp) {
    side = "long";
    setup = "Micro Reversal";
  } else if (c1.c > mean[i] + 1.7 * atrPx && !closesUp) {
    side = "short";
    setup = "Micro Reversal";
  }

  if (side && setup) await openTrade(state, spec, side, setup, rt);
}

// ---------------------------------------------------------------------------
// Per-step trade management (breakeven lock + aggressive trailing)
// ---------------------------------------------------------------------------

function manageTrade(state: EngineState, t: OpenTrade, minOfDay: number) {
  void minOfDay;
  const m = state.markets[t.symbol];
  const spec = SYMBOL_MAP[t.symbol];
  const price = m.price;
  const grossPips = t.side === "long" ? (price - t.entry) / spec.pip : (t.entry - price) / spec.pip;
  const atr = atrPips(m.candles, spec.pip);

  // 1) Breakeven lock: once comfortably in profit, move stop above entry +
  // full spread cost so a scratch exit can never realize a loss
  const beTrigger = Math.max(4, spec.spreadPips + 1.5);
  if (!t.beDone && grossPips >= beTrigger) {
    const lock = spec.spreadPips + 0.8;
    const be = t.side === "long" ? t.entry + lock * spec.pip : t.entry - lock * spec.pip;
    if (t.side === "long" ? be > t.sl : be < t.sl) t.sl = be;
    t.beDone = true;
  }

  // 2) Aggressive trailing after the lock — suited to extended scalp runners
  if (t.beDone) {
    const trail = Math.max(3.5, 1.05 * atr) * spec.pip;
    const candidate = t.side === "long" ? price - trail : price + trail;
    if (t.side === "long" ? candidate > t.sl : candidate < t.sl) t.sl = candidate;
  }

  // 3) Exits — stop / target fills are broker-side and always honoured
  const hitSl = t.side === "long" ? price <= t.sl : price >= t.sl;
  const hitTp = t.side === "long" ? price >= t.tp : price <= t.tp;
  if (hitSl) {
    const locked = t.side === "long" ? t.sl - t.entry : t.entry - t.sl;
    const reason = t.beDone
      ? locked > 1.5 * spec.pip
        ? "Trailing stop locked"
        : "Breakeven stop"
      : "Stop loss hit";
    return { exit: t.sl, reason };
  }
  if (hitTp) return { exit: t.tp, reason: "Take profit" };

  // Discretionary exits paused while the bridge is down
  if (state.connDownUntil > 0 && state.simNow < state.connDownUntil) return null;

  const ageMs = state.simNow - t.openedSim;
  const closes = m.candles.map((c) => c.c);
  if (ageMs > 3 * MIN && closes.length > 15 && grossPips < 3 && grossPips > -4) {
    const fast = emaSeries(closes.slice(-30), 5);
    const slow = emaSeries(closes.slice(-30), 13);
    const f = fast[fast.length - 1];
    const s = slow[slow.length - 1];
    if ((t.side === "long" && f < s) || (t.side === "short" && f > s)) {
      return { exit: price, reason: "Momentum exit" };
    }
  }
  if (ageMs > 45 * MIN) return { exit: price, reason: "Time stop" };
  return null;
}

// ---------------------------------------------------------------------------
// Market emulator — regime-switching drift + volatility clustering + sweeps
// ---------------------------------------------------------------------------

async function evolveMarket(state: EngineState, code: SymbolCode, dtMs: number, minOfDay: number) {
  const m = state.markets[code];
  const spec = SYMBOL_MAP[code];
  const spec_sess = sessionAt(minOfDay);
  const targetVol = spec_sess ? spec_sess.volMult : 0.35;

  // volatility mean-reverts toward the session regime with noise
  const ou = 1 - Math.exp(-dtMs / (5 * MIN));
  m.volMult += (targetVol - m.volMult) * ou + gauss() * 0.05 * Math.sqrt(dtMs / MIN);
  m.volMult = clamp(m.volMult, 0.2, 2.6);

  // news shock
  const inNewsShock = state.newsActiveUntil > 0 && state.simNow >= state.newsBlockFrom + 5 * MIN && state.simNow < state.newsActiveUntil;
  const vol = inNewsShock ? m.volMult * 1.9 : m.volMult;

  // trend regime
  m.trendLifeMs -= dtMs;
  if (m.trendLifeMs <= 0) {
    const roll = Math.random();
    m.trendDir = roll < 0.35 ? -1 : roll < 0.65 ? 0 : 1;
    m.trendStrength = m.trendDir === 0 ? 0 : rand(0.15, 0.85);
    m.trendLifeMs = rand(8, 40) * MIN;
  }

  // liquidity sweep injection then reversion
  let sweepDrift = 0;
  if (m.sweepDir === 0 && state.simNow >= m.sweepAtMs) {
    m.sweepDir = Math.random() < 0.5 ? -1 : 1;
    m.sweepLifeMs = rand(3, 6) * MIN;
    m.sweepRevertMs = rand(5, 9) * MIN;
  }
  if (m.sweepLifeMs > 0) {
    m.sweepLifeMs -= dtMs;
    sweepDrift += (m.sweepDir as number) * rand(1.8, 3.2);
    if (m.sweepLifeMs <= 0) m.sweepAtMs = state.simNow + rand(15, 90) * MIN;
  } else if (m.sweepRevertMs > 0) {
    m.sweepRevertMs -= dtMs;
    sweepDrift -= (m.sweepDir as number) * rand(0.8, 1.5);
    if (m.sweepRevertMs <= 0) m.sweepDir = 0;
  }

  // Artificial post-entry edge drift removed — it biased simulator results
  // and must not exist when validating the live strategy.

  // mild mean reversion toward the 20-period mean
  let pull = 0;
  if (m.candles.length >= 20) {
    const closes = m.candles.map((c) => c.c);
    const mean = emaSeries(closes.slice(-30), 20);
    const dist = clamp((mean[mean.length - 1] - m.price) / spec.pip, -8, 8);
    pull = dist * 0.02;
  }

  const dtMin = dtMs / MIN;
  const driftPipsPerMin =
    m.trendDir * m.trendStrength * (0.6 + 0.4 * m.volMult) + sweepDrift + pull;
  const sigma = spec.sigmaPipsPerMin * vol * Math.sqrt(dtMin);
  const dpPips = driftPipsPerMin * dtMin + gauss() * sigma;
  m.price = Math.max(spec.pip * 10, m.price + dpPips * spec.pip);

  // 1-minute candle rollup + signal evaluation on close
  const bucket = Math.floor(state.simNow / MIN) * MIN;
  if (!m.cur) {
    m.cur = { t: bucket, o: m.price, h: m.price, l: m.price, c: m.price };
  } else if (m.cur.t !== bucket) {
    m.candles.push(m.cur);
    if (m.candles.length > MAX_CANDLES) m.candles.splice(0, m.candles.length - MAX_CANDLES);
    m.cur = { t: bucket, o: m.price, h: m.price, l: m.price, c: m.price };
    await maybeEnterOnClose(state, code, minOfDay);
  } else {
    m.cur.h = Math.max(m.cur.h, m.price);
    m.cur.l = Math.min(m.cur.l, m.price);
    m.cur.c = m.price;
  }
}

function entryGatesOpen(state: EngineState, minOfDay: number): SessionRuntime | null {
  if (!state.running || state.killed) return null;
  // Connection: live uses wall-clock mark; sim uses scheduled window
  if (state.mode === "live") {
    if (state.connDownUntil !== 0 || state.connStale) return null;
  } else if (state.connDownUntil > 0 && state.simNow < state.connDownUntil) {
    return null;
  }
  const spec = sessionAt(minOfDay);
  if (!spec) return null;
  const rt = state.sessions.find((s) => s.name === spec.name && s.simDate === state.dayKey);
  if (!rt || rt.status !== "trading") return null;
  if (minOfDay >= spec.endMin - spec.closeOutMin) return null; // close-out window
  if (isLowLiquidity(minOfDay)) return null;
  // News blackout — live uses absolute UTC window; sim uses scheduled nextNewsAt
  if (state.newsActiveUntil > 0 && state.simNow >= state.newsBlockFrom && state.simNow < state.newsActiveUntil) {
    return null;
  }
  if (state.openTrades.length >= MAX_CONCURRENT_TRADES) return null;
  if (state.simNow - state.lastEntryAt < GLOBAL_COOLDOWN_MS) return null;
  return rt;
}

async function maybeEnterOnClose(state: EngineState, code: SymbolCode, minOfDay: number) {
  const rt = entryGatesOpen(state, minOfDay);
  if (!rt) return;
  const m = state.markets[code];
  if (state.simNow < m.cooldownUntil) return;
  if (state.openTrades.some((t) => t.symbol === code)) return;
  await evaluateEntry(state, code, rt);
}

// ---------------------------------------------------------------------------
// Sessions — start, targets, close-out, end-of-day report
// ---------------------------------------------------------------------------

async function startSession(state: EngineState, rt: SessionRuntime, spec: SessionSpec) {
  rt.status = "trading";
  rt.startEquity = state.account;
  rt.equity = state.account;
  rt.peak = 0;
  await logEvent(
    state,
    "session_open",
    "info",
    `${rt.name} session open — baseline $${state.account.toFixed(2)} · target +${(TARGET_PCT * 100).toFixed(0)}% ($${(state.account * (1 + TARGET_PCT)).toFixed(2)})`,
  );
  void spec;
}

async function endSession(state: EngineState, rt: SessionRuntime) {
  if (rt.logged) return;
  rt.logged = true;
  rt.status = rt.status === "target_hit" ? "target_hit" : "closed";
  rt.equity = state.account;
  const pnl = r2(state.account - rt.startEquity);
  const pct = ((state.account / rt.startEquity - 1) * 100).toFixed(2);
  const wr = rt.trades > 0 ? ((rt.wins / rt.trades) * 100).toFixed(1) : "0.0";
  const hit = rt.status === "target_hit";
  await db
    .insert(sessionLogs)
    .values({
      key: rt.key,
      name: rt.name,
      simDate: rt.simDate,
      startEquity: rt.startEquity,
      endEquity: state.account,
      targetPct: TARGET_PCT,
      status: hit ? "target_hit" : "closed",
      tradesCount: rt.trades,
      wins: rt.wins,
      losses: rt.losses,
      startedSim: state.simNow,
      endedSim: state.simNow,
    })
    .onConflictDoUpdate({
      target: sessionLogs.key,
      set: { endEquity: state.account, status: hit ? "target_hit" : "closed", tradesCount: rt.trades, wins: rt.wins, losses: rt.losses, endedSim: state.simNow },
    });
  await logEvent(
    state,
    "session_close",
    hit ? "success" : "warn",
    `${rt.name} session closed — P&L ${pnl >= 0 ? "+" : "-"}$${Math.abs(pnl).toFixed(2)} (${pct}%) · ${rt.trades} trades · win rate ${wr}% · 20% target ${hit ? "ACHIEVED" : "missed"}`,
  );
}

async function manageSessions(state: EngineState, minOfDay: number) {
  const date = simDateStr(state.simNow);

  // New simulated day — archive stale runtimes and reset baselines
  if (date !== state.dayKey) {
    for (const rt of state.sessions) {
      if (rt.status === "trading" || rt.status === "closeout" || (rt.status === "target_hit" && !rt.logged)) {
        for (const t of [...state.openTrades]) {
          if (t.sessionKey === rt.key) {
            await closeTrade(state, t, state.markets[t.symbol].price, "Session close-out", true);
          }
        }
        await endSession(state, rt);
      }
    }
    state.dayKey = date;
    state.sessions = freshSessions(date, state.account);
    for (const code of Object.keys(state.markets) as SymbolCode[]) {
      state.markets[code].openDay = state.markets[code].price;
    }
    state.equityCurve.push({ t: state.simNow, eq: state.account });
  }

  const active = sessionAt(minOfDay);
  for (const rt of state.sessions) {
    const spec = SESSIONS.find((s) => s.name === rt.name);
    if (!spec) continue;
    const isActive = active?.name === rt.name;

    if (isActive && rt.status === "waiting") await startSession(state, rt, spec);

    if (isActive && rt.status === "trading") {
      // close-out: flatten everything 15 min before the end
      if (minOfDay >= spec.endMin - spec.closeOutMin) {
        rt.status = "closeout";
        for (const t of [...state.openTrades]) {
          if (t.sessionKey === rt.key) {
            await closeTrade(state, t, state.markets[t.symbol].price, "Session close-out", true);
          }
        }
        await logEvent(state, "session_closeout", "warn", `${rt.name} close-out — all positions flattened, entries halted`);
      } else {
        // 20% target check on floating session equity
        const eqNow = sessionEquity(state, rt);
        rt.equity = eqNow;
        rt.peak = Math.max(rt.peak, eqNow / rt.startEquity - 1);
        if (eqNow >= rt.startEquity * (1 + TARGET_PCT)) {
          for (const t of [...state.openTrades]) {
            if (t.sessionKey === rt.key) {
              await closeTrade(state, t, state.markets[t.symbol].price, "Target locked — 20% secured", true);
            }
          }
          rt.status = "target_hit";
          rt.equity = state.account;
          await logEvent(
            state,
            "target_hit",
            "success",
            `${rt.name} +20% TARGET HIT — equity $${state.account.toFixed(2)} · trading stopped until next session`,
          );
        }
      }
    }

    if (
      !isActive &&
      (rt.status === "trading" || rt.status === "closeout" || rt.status === "target_hit") &&
      !rt.logged &&
      rt.simDate === date
    ) {
      // clock has moved past the session end
      for (const t of [...state.openTrades]) {
        if (t.sessionKey === rt.key) {
          await closeTrade(state, t, state.markets[t.symbol].price, "Session close-out", true);
        }
      }
      await endSession(state, rt);
    }

    if (!isActive && rt.status === "waiting") {
      // projected baseline tracks live equity until the session actually opens
      rt.startEquity = state.account;
      rt.equity = state.account;
    }
  }
}

// ---------------------------------------------------------------------------
// News calendar + connectivity guard
// ---------------------------------------------------------------------------

async function manageNewsAndConn(state: EngineState) {
  if (state.mode === "live") {
    // Real calendar — wall-clock UTC
    try {
      await refreshNewsCalendar();
      const win = newsWindowAt(Date.now());
      const wasActive = state.simNow < state.newsActiveUntil && state.simNow >= state.newsBlockFrom;
      state.newsBlockFrom = win.blockFrom;
      state.newsActiveUntil = win.blockUntil;
      state.newsLabel = win.label;
      state.nextNewsAt = win.nextEventIn > 0 ? Date.now() + win.nextEventIn : 0;
      if (win.active && !wasActive) {
        await logEvent(state, "news", "warn", `RED FOLDER: ${win.label} — entries paused (pre/post news blackout)`);
      }
    } catch {
      /* non-fatal */
    }

    // Connection status from bridge heartbeat (updated in tickLive)
    return;
  }

  // ---- Simulation path (random news + random disconnects for demo) --------
  if (state.nextNewsAt > 0 && state.simNow >= state.nextNewsAt) {
    const label = randPick(NEWS_LABELS);
    state.newsLabel = label;
    state.newsBlockFrom = state.simNow - 5 * MIN;
    state.newsActiveUntil = state.simNow + 8 * MIN;
    await logEvent(state, "news", "warn", `RED FOLDER: ${label} — entries paused (pre/post news blackout)`);
    state.nextNewsAt = state.simNow + rand(120, 320) * MIN;
  }

  if (state.connDownUntil === 0 && state.simNow >= state.nextConnEventAt) {
    state.connDownUntil = state.simNow + rand(3, 8) * MIN;
    state.nextConnEventAt = state.simNow + rand(90, 320) * MIN;
    await logEvent(state, "conn_down", "danger", "MT5 bridge connection dropped — entries paused, resting stops live");
  } else if (state.connDownUntil > 0 && state.simNow >= state.connDownUntil) {
    state.connDownUntil = 0;
    await logEvent(state, "conn_up", "success", "MT5 bridge reconnected — market feed resynced, trading resumed");
  }
}

// ---------------------------------------------------------------------------
// Core advance
// ---------------------------------------------------------------------------

export async function tickEngine(): Promise<EngineState> {
  const state = await loadState();
  const realNow = Date.now();
  const elapsed = Math.max(0, realNow - state.lastRealMs);
  state.lastRealMs = realNow;

  if (!state.running || state.killed || elapsed < 250) {
    await saveState(state);
    return state;
  }

  let advance = Math.min(elapsed * state.speed, MAX_SIM_JUMP);
  const step = Math.max(10_000, Math.ceil(advance / MAX_STEPS));
  let guard = 0;

  while (advance > 0 && guard < MAX_STEPS + 5) {
    const dt = Math.min(step, advance);
    advance -= dt;
    guard += 1;
    state.simNow += dt;
    const minOfDay = Math.floor((state.simNow % DAY) / MIN);

    await manageSessions(state, minOfDay);
    for (const code of Object.keys(state.markets) as SymbolCode[]) {
      await evolveMarket(state, code, dt, minOfDay);
    }
    for (const t of [...state.openTrades]) {
      const hit = manageTrade(state, t, minOfDay);
      if (hit) await closeTrade(state, t, hit.exit, hit.reason, true);
    }
    await manageNewsAndConn(state);
  }

  // equity curve bookkeeping
  const lastPt = state.equityCurve[state.equityCurve.length - 1];
  const eqNow = state.account + state.openTrades.reduce((s, t) => s + unrealisedPnl(state, t), 0);
  if (!lastPt || state.simNow - lastPt.t >= 30_000) {
    state.equityCurve.push({ t: state.simNow, eq: r2(eqNow) });
    if (state.equityCurve.length > MAX_EQUITY_POINTS) {
      state.equityCurve = state.equityCurve.filter((_, i) => i % 2 === 0);
    }
  }

  await saveState(state);
  return state;
}

// ---------------------------------------------------------------------------
// Control actions
// ---------------------------------------------------------------------------

export async function controlEngine(action: ControlAction): Promise<void> {
  const state = await loadState();
  switch (action.action) {
    case "speed": {
      // Speed only meaningful in simulation; live always runs real-time.
      if (state.mode === "sim") {
        state.speed = clamp(action.speed, 1, 120);
        await saveState(state);
      }
      break;
    }
    case "toggle": {
      state.running = !state.running;
      state.lastRealMs = Date.now();
      await logEvent(state, "engine", "info", state.running ? "Engine resumed — signal scan active" : "Engine paused — signal scan suspended");
      await saveState(state);
      break;
    }
    case "kill": {
      // 1) Immediately block new entries
      state.killed = true;
      state.killConfirmed = false;
      await logEvent(state, "kill", "danger", "KILL SWITCH requested — new entries blocked");

      if (state.mode === "live") {
        // 2) True broker flatten via Python bridge
        try {
          const result = await killSwitch();
          state.killConfirmed = result.kill_confirmed;
          // Mirror closes into DB
          for (const t of [...state.openTrades]) {
            const closed = result.closed.find((c) => c.ticket === t.brokerTicket);
            const px = closed?.price ?? state.markets[t.symbol]?.price ?? t.entry;
            await closeTrade(state, t, px, "Kill switch flatten", true);
          }
          if (result.kill_confirmed) {
            await logEvent(state, "kill", "danger", "KILL SWITCH confirmed — all broker positions flat, engine halted");
          } else {
            await logEvent(
              state,
              "kill",
              "warn",
              `KILL SWITCH partial — remaining tickets: ${(result.remaining ?? []).join(", ") || "unknown"}; errors: ${result.errors.join("; ")}`,
            );
          }
        } catch (err) {
          await logEvent(
            state,
            "kill",
            "danger",
            `KILL SWITCH broker error: ${err instanceof Error ? err.message : err} — entries still blocked`,
          );
        }
      } else {
        // Simulation: close in-memory positions
        for (const t of [...state.openTrades]) {
          await closeTrade(state, t, state.markets[t.symbol].price, "Kill switch flatten", true);
        }
        state.killConfirmed = true;
        await logEvent(state, "kill", "danger", "KILL SWITCH engaged — all positions flattened, engine halted");
      }
      await saveState(state);
      break;
    }
    case "resume": {
      if (state.mode === "live") {
        try {
          await unkill();
        } catch {
          /* non-fatal */
        }
      }
      state.killed = false;
      state.killConfirmed = false;
      state.running = true;
      state.lastRealMs = Date.now();
      await logEvent(state, "engine", "success", "Kill switch disengaged — engine live");
      await saveState(state);
      break;
    }
    case "disconnect": {
      if (state.mode === "sim") {
        state.connDownUntil = state.simNow + 5 * MIN;
        state.nextConnEventAt = state.simNow + rand(90, 240) * MIN;
        await logEvent(state, "conn_down", "danger", "MT5 bridge connection dropped (manual) — entries paused, resting stops live");
      }
      await saveState(state);
      break;
    }
    case "reconcile": {
      if (state.mode === "live") {
        const report = await reconcilePositions(state);
        await logEvent(
          state,
          "reconcile",
          "info",
          `Manual reconcile: matched=${report.matched} closed=${report.closedFromBroker} imported=${report.importedFromBroker}`,
        );
        await saveState(state);
      }
      break;
    }
    case "reset": {
      const fresh = createInitialState(Date.now());
      fresh.speed = state.speed;
      await db.delete(trades);
      await db.delete(events);
      await db.delete(sessionLogs);
      await logEvent(fresh, "engine", "info", "Terminal reset — accounts rebased to $10,000, logs cleared");
      await saveState(fresh);
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Live tick path — wall-clock, bridge ticks, no time acceleration
// ---------------------------------------------------------------------------

let reconciledOnce = false;

async function tickLive(state: EngineState): Promise<EngineState> {
  const now = Date.now();
  state.lastRealMs = now;
  state.simNow = now; // live: simNow === wall clock
  state.dayKey = simDateStr(now);
  state.workerHeartbeatMs = now;

  // Heartbeat + connection status from bridge
  try {
    const health = await getHealth();
    state.connHeartbeatMs = health.last_heartbeat_ms;
    state.connStale = health.stale;
    const up = health.ok && health.connected && !health.stale;
    if (!up && state.connDownUntil === 0) {
      state.connDownUntil = now; // mark down
      await logEvent(state, "conn_down", "danger", `MT5 bridge down: ${health.last_error || "stale/disconnected"}`);
    } else if (up && state.connDownUntil !== 0) {
      state.connDownUntil = 0;
      await logEvent(state, "conn_up", "success", "MT5 bridge reconnected — market feed resynced");
    }
    // Sync kill flags from bridge
    if (health.kill_requested) state.killed = true;
    if (health.kill_confirmed) state.killConfirmed = true;
    if (health.account?.equity != null && health.account.equity > 0) {
      // Prefer broker equity when no open trades tracked (reconcile handles the rest)
      if (state.openTrades.length === 0) state.account = health.account.balance ?? state.account;
    }
  } catch (err) {
    state.connStale = true;
    if (state.connDownUntil === 0) {
      state.connDownUntil = now;
      await logEvent(
        state,
        "conn_down",
        "danger",
        `MT5 bridge unreachable: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  // One-time + periodic reconcile
  if (!reconciledOnce || now % 60_000 < 1500) {
    try {
      await reconcilePositions(state);
      reconciledOnce = true;
    } catch (err) {
      await logEvent(
        state,
        "reconcile",
        "warn",
        `Reconcile error: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  // Refresh contract specs + ticks
  try {
    const specs = await getSpecs();
    if (Array.isArray(specs)) {
      liveSpecs = {};
      for (const s of specs) liveSpecs[s.symbol] = s;
    }
  } catch {
    /* keep last cache */
  }

  try {
    const ticks = await getTicks();
    if (Array.isArray(ticks)) {
      for (const t of ticks as Tick[]) {
        const code = t.symbol as SymbolCode;
        if (!state.markets[code]) continue;
        const mid = t.bid && t.ask ? (t.bid + t.ask) / 2 : t.last || t.bid || t.ask;
        if (mid > 0) {
          state.markets[code].price = mid;
          state.markets[code].lastTickMs = t.time_msc;
        }
      }
    }
  } catch {
    /* non-fatal */
  }

  // Pull 1-min bars and evaluate signals on new candle closes
  const minOfDay = Math.floor(((now % DAY) + DAY) % DAY / MIN); // UTC
  await manageSessions(state, minOfDay);

  for (const code of Object.keys(state.markets) as SymbolCode[]) {
    try {
      const bars = await getBars(code, MAX_CANDLES, "M1");
      if (bars.length) {
        const m = state.markets[code];
        const closed = bars.slice(0, -1); // last is forming
        m.candles = closed.map((b) => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c }));
        const last = bars[bars.length - 1];
        m.cur = { t: last.t, o: last.o, h: last.h, l: last.l, c: last.c };
        // Evaluate entry only when we have enough history and gates open
        await maybeEnterOnClose(state, code, minOfDay);
      }
    } catch {
      /* per-symbol non-fatal */
    }
  }

  // Manage open trades (trail / BE / exits) using live prices
  for (const t of [...state.openTrades]) {
    const hit = manageTrade(state, t, minOfDay);
    if (hit) {
      if (t.brokerTicket) {
        try {
          const res = await closePosition({ ticket: t.brokerTicket });
          await closeTrade(state, t, res.price, hit.reason, true);
        } catch (err) {
          await logEvent(
            state,
            "close_fail",
            "danger",
            `Close ticket ${t.brokerTicket} failed: ${err instanceof Error ? err.message : err}`,
          );
        }
      } else {
        await closeTrade(state, t, hit.exit, hit.reason, true);
      }
    } else if (t.brokerTicket && t.sl !== t.slInit) {
      // Push trailing SL to broker
      try {
        await modifyPosition({ ticket: t.brokerTicket, sl: t.sl, tp: t.tp });
      } catch {
        /* retry next tick */
      }
    }
  }

  await manageNewsAndConn(state);

  // Equity curve
  const lastPt = state.equityCurve[state.equityCurve.length - 1];
  const eqNow = state.account + state.openTrades.reduce((s, t) => s + unrealisedPnl(state, t), 0);
  if (!lastPt || now - lastPt.t >= 30_000) {
    state.equityCurve.push({ t: now, eq: r2(eqNow) });
    if (state.equityCurve.length > MAX_EQUITY_POINTS) {
      state.equityCurve = state.equityCurve.filter((_, i) => i % 2 === 0);
    }
  }

  await saveState(state);
  return state;
}

// ---------------------------------------------------------------------------
// Snapshot for the dashboard
// ---------------------------------------------------------------------------

let ticking = false;

/**
 * Read-only snapshot for the dashboard.
 * Does NOT advance the engine when a worker is alive (workerHeartbeat < 5s ago)
 * or when TRADING_MODE=live. This is the fix for issue #1.
 */
export async function advanceAndSnapshot(): Promise<EngineSnapshot> {
  const state = await loadState();
  const workerAlive = state.workerHeartbeatMs > 0 && Date.now() - state.workerHeartbeatMs < 5_000;

  // Live mode or active worker → never advance from the HTTP request path
  if (state.mode === "live" || workerAlive || process.env.WORKER_OWNED === "1") {
    return buildSnapshot(state);
  }

  // Legacy sim without worker: keep dashboard-driven advance for local demos
  if (ticking) return buildSnapshot(state);
  ticking = true;
  try {
    const next = await tickEngine();
    return buildSnapshot(next);
  } finally {
    ticking = false;
  }
}

/** Called exclusively by the persistent worker process. */
export async function workerTick(): Promise<EngineState> {
  const state = await loadState();
  // Ensure mode flag is consistent with env
  if (isLive() && state.mode !== "live") {
    state.mode = "live";
    state.speed = 1;
  }
  if (state.mode === "live") {
    return tickLive(state);
  }
  // Sim mode under worker: still advance via tickEngine, stamp heartbeat
  const next = await tickEngine();
  next.workerHeartbeatMs = Date.now();
  await saveState(next);
  return next;
}

export async function buildSnapshot(state: EngineState): Promise<EngineSnapshot> {
  const [evRows, trRows, sessRows] = await Promise.all([
    db.select().from(events).orderBy(desc(events.id)).limit(60),
    db.select().from(trades).orderBy(desc(trades.id)).limit(80),
    db.select().from(sessionLogs).orderBy(desc(sessionLogs.id)).limit(9),
  ]);

  const eventsOut: EventRow[] = evRows
    .map((e) => ({ id: e.id, simTime: e.simTime, type: e.type, level: e.level as EventRow["level"], message: e.message }))
    .reverse();

  const tradesOut: ClosedTradeRow[] = trRows.map((t) => ({
    id: t.id,
    sessionKey: t.sessionKey,
    session: t.session,
    symbol: t.symbol,
    side: t.side as ClosedTradeRow["side"],
    qty: t.qty,
    entryPrice: t.entryPrice,
    exitPrice: t.exitPrice,
    sl: t.sl,
    tp: t.tp,
    slFinal: t.slFinal,
    pnl: t.pnl,
    pips: t.pips,
    riskPct: t.riskPct,
    setup: t.setup,
    exitReason: t.exitReason,
    openedSim: t.openedSim,
    closedSim: t.closedSim,
  }));

  const markets: EngineSnapshot["markets"] = {};
  for (const code of Object.keys(state.markets) as SymbolCode[]) {
    const m = state.markets[code];
    const candles = m.cur ? [...m.candles.slice(-(MAX_CANDLES - 1)), m.cur] : m.candles.slice(-MAX_CANDLES);
    const liveSpread =
      liveSpecs[code]?.spread != null && liveSpecs[code].pip
        ? (liveSpecs[code].spread * (liveSpecs[code].point || 0)) / (liveSpecs[code].pip || 1)
        : SYMBOL_MAP[code].spreadPips;
    markets[code] = {
      price: m.price,
      openDay: m.openDay,
      spreadPips: liveSpread || SYMBOL_MAP[code].spreadPips,
      candles,
    };
  }

  const workerAlive = state.workerHeartbeatMs > 0 && Date.now() - state.workerHeartbeatMs < 5_000;
  const connUp =
    state.mode === "live"
      ? state.connDownUntil === 0 && !state.connStale
      : !(state.connDownUntil > 0 && state.simNow < state.connDownUntil);

  return {
    ok: true,
    simNow: state.simNow,
    realNow: Date.now(),
    running: state.running,
    killed: state.killed,
    killConfirmed: state.killConfirmed ?? false,
    speed: state.speed,
    account: state.account,
    connUp,
    connDownUntil: state.connDownUntil,
    connHeartbeatMs: state.connHeartbeatMs ?? null,
    connStale: state.connStale ?? false,
    newsActive: state.simNow < state.newsActiveUntil && state.simNow >= state.newsBlockFrom,
    newsLabel: state.newsLabel,
    nextNewsIn:
      state.mode === "live"
        ? state.nextNewsAt > 0
          ? Math.max(0, state.nextNewsAt - Date.now())
          : 0
        : state.nextNewsAt > 0
          ? Math.max(0, state.nextNewsAt - state.simNow)
          : 0,
    sessions: state.sessions,
    sessionHistory: sessRows.map((r) => ({
      id: r.id,
      key: r.key,
      name: r.name,
      simDate: r.simDate,
      startEquity: r.startEquity,
      endEquity: r.endEquity,
      targetPct: r.targetPct,
      status: r.status,
      tradesCount: r.tradesCount,
      wins: r.wins,
      losses: r.losses,
      startedSim: r.startedSim,
      endedSim: r.endedSim,
    })),
    openTrades: state.openTrades,
    recentTrades: tradesOut,
    events: eventsOut,
    markets,
    equityCurve: state.equityCurve,
    dayKey: state.dayKey,
    mode: state.mode ?? (isLive() ? "live" : "sim"),
    workerAlive,
  };
}
