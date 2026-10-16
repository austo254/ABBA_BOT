"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, animate, motion } from "framer-motion";
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Bell,
  Bot,
  CheckCircle2,
  CircleDollarSign,
  Crosshair,
  Flag,
  Gauge,
  History,
  Info,
  Pause,
  Play,
  Power,
  RotateCcw,
  ScanLine,
  Shield,
  ShieldCheck,
  Target,
  Wifi,
  WifiOff,
  XCircle,
  Zap,
} from "lucide-react";
import { SESSIONS, SYMBOLS, SYMBOL_MAP, TARGET_PCT } from "@/lib/market";
import type { SymbolCode, SymbolSpec } from "@/lib/market";
import type {
  EngineSnapshot,
  EventRow,
  OpenTrade,
  SessionRuntime,
} from "@/lib/types";
import { fmtHm, fmtMoney, fmtSimClock, fmtSimDate, fmtSignedPct } from "@/lib/format";
import { EquityChart, PriceChart } from "./charts";

// ---------------------------------------------------------------------------
// constants & small tools
// ---------------------------------------------------------------------------

const SPEEDS = [1, 10, 30, 60, 120];
const ORDER: ("London" | "New York" | "Asian")[] = ["London", "New York", "Asian"];

const WINDOWS: Record<string, string> = Object.fromEntries(
  SESSIONS.map((s) => {
    const f = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    return [s.name, `${f(s.startMin)}–${f(s.endMin)}`];
  }),
);

const SESSION_COLORS: Record<string, string> = {
  London: "#34f5a2",
  "New York": "#45e0ff",
  Asian: "#8b9cf9",
};

function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}

function AN({ value, format }: { value: number; format: (n: number) => string }) {
  const [display, setDisplay] = useState(value);
  const prev = useRef(value);
  const fmtRef = useRef(format);
  fmtRef.current = format;
  useEffect(() => {
    const from = prev.current;
    prev.current = value;
    const controls = animate(from, value, {
      duration: 0.6,
      ease: [0.22, 1, 0.36, 1],
      onUpdate: (v) => setDisplay(v),
    });
    return () => controls.stop();
  }, [value]);
  return <>{fmtRef.current(display)}</>;
}

// ---------------------------------------------------------------------------
// root dashboard
// ---------------------------------------------------------------------------

export default function Dashboard() {
  const [snap, setSnap] = useState<EngineSnapshot | null>(null);
  const [symbol, setSymbol] = useState<SymbolCode>("EURUSD");
  const [clockNow, setClockNow] = useState<number>(Date.now());
  const snapAt = useRef<number>(Date.now());
  const busy = useRef(false);

  const poll = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const res = await fetch("/api/engine", { cache: "no-store" });
      const data = (await res.json()) as EngineSnapshot;
      if (data && data.ok) {
        setSnap(data);
        snapAt.current = Date.now();
      }
    } catch {
      /* keep last snapshot */
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    void poll();
    const iv = setInterval(poll, 1600);
    const ck = setInterval(() => setClockNow(Date.now()), 100);
    return () => {
      clearInterval(iv);
      clearInterval(ck);
    };
  }, [poll]);

  const post = useCallback(
    async (body: Record<string, unknown>) => {
      try {
        const res = await fetch("/api/engine", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = (await res.json()) as EngineSnapshot;
        if (data && data.ok) {
          setSnap(data);
          snapAt.current = Date.now();
        }
      } catch {
        /* noop */
      }
    },
    [],
  );

  // auto-focus chart on a symbol with an open trade
  useEffect(() => {
    if (snap && snap.openTrades.length > 0 && !snap.openTrades.some((t) => t.symbol === symbol)) {
      setSymbol(snap.openTrades[0].symbol);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap?.openTrades.length]);

  const simDisplay = useMemo(() => {
    if (!snap) return clockNow;
    return snap.simNow + (clockNow - snapAt.current) * (snap.running && !snap.killed ? snap.speed : 0);
  }, [snap, clockNow]);

  if (!snap) return <BootScreen />;

  const activeSession =
    snap.sessions.find((s) => s.status === "trading" || s.status === "closeout") ??
    [...ORDER].map((n) => snap.sessions.find((s) => s.name === n)).find((s) => s && s.status === "target_hit") ??
    snap.sessions[0];

  const market = snap.markets[symbol];
  const chartTrades = snap.openTrades.filter((t) => t.symbol === symbol);

  return (
    <div className="term-noise relative min-h-screen overflow-x-clip">
      <div className="term-grid pointer-events-none fixed inset-0" />
      <div className="pointer-events-none fixed -top-40 left-1/2 h-[420px] w-[900px] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,rgba(69,224,255,0.07),transparent)] blur-2xl" />

      <div className="relative z-10 mx-auto flex min-h-screen max-w-[1680px] flex-col gap-3 px-3 py-3 sm:px-5">
        <Header snap={snap} simDisplay={simDisplay} post={post} activeSession={activeSession} />

        {!snap.connUp && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            className="conn-stripes panel-tight flex items-center gap-3 border-rose-500/30 px-4 py-2.5"
          >
            <WifiOff className="h-4 w-4 text-rose-400" />
            <p className="font-mono text-[11px] tracking-wider text-rose-300">
              MT5 BRIDGE DOWN — NEW ENTRIES PAUSED · RESTING STOPS REMAIN SERVER-SIDE · AUTO-RECONNECT ARMED
            </p>
          </motion.div>
        )}

        <main className="grid flex-1 grid-cols-1 gap-3 xl:grid-cols-12">
          {/* left rail — sessions + risk */}
          <div className="order-2 flex flex-col gap-3 xl:order-1 xl:col-span-3">
            {ORDER.map((name) => {
              const rt = snap.sessions.find((s) => s.name === name);
              return rt ? <SessionCard key={rt.key} rt={rt} /> : null;
            })}
            <RiskPanel snap={snap} />
          </div>

          {/* center — charts */}
          <div className="order-1 flex flex-col gap-3 xl:order-2 xl:col-span-6">
            <ChartPanel snap={snap} symbol={symbol} setSymbol={setSymbol} market={market} trades={chartTrades} />
            <EquityPanel snap={snap} activeSession={activeSession} />
          </div>

          {/* right rail — positions + feed */}
          <div className="order-3 flex flex-col gap-3 xl:col-span-3">
            <PositionsPanel snap={snap} />
            <EventFeed events={snap.events} newsActive={snap.newsActive} newsLabel={snap.newsLabel} />
          </div>
        </main>

        <TradeLog snap={snap} />
        <SessionHistoryStrip snap={snap} />

        <footer className="flex flex-wrap items-center justify-between gap-2 px-1 pb-2 pt-1">
          <p className="font-mono text-[10px] tracking-wider text-zinc-600">
            ABBA v2.4 · MT5 BRIDGE: <span className="text-amber-500/80">EMULATED FEED</span> · SIMULATION
            ENVIRONMENT — NO REAL FUNDS AT RISK
          </p>
          <p className="font-mono text-[10px] tracking-wider text-zinc-600">
            RISK/TRADE ≤ 2% · TARGET +20%/SESSION · NO OVERNIGHT EXPOSURE
          </p>
        </footer>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// boot screen
// ---------------------------------------------------------------------------

function BootScreen() {
  return (
    <div className="term-noise relative grid min-h-screen place-items-center bg-[#04060b]">
      <div className="term-grid pointer-events-none fixed inset-0" />
      <div className="flex flex-col items-center gap-5">
        <div className="relative h-20 w-20">
          <div className="radar-sweep absolute inset-0 rounded-full [background:conic-gradient(from_0deg,rgba(52,245,162,0.5),transparent_22%)]" />
          <div className="absolute inset-[3px] grid place-items-center rounded-full border border-mint/20 bg-[#0a0e16]">
            <Bot className="h-7 w-7 text-mint" />
          </div>
        </div>
        <div className="text-center">
          <p className="font-mono text-[11px] tracking-[0.35em] text-mint">ABBA TERMINAL</p>
          <p className="mt-2 font-mono text-[10px] tracking-wider text-zinc-500">
            LINKING MT5 BRIDGE · HYDRATING ENGINE STATE
          </p>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// header
// ---------------------------------------------------------------------------

function Header({
  snap,
  simDisplay,
  post,
  activeSession,
}: {
  snap: EngineSnapshot;
  simDisplay: number;
  post: (body: Record<string, unknown>) => Promise<void>;
  activeSession: SessionRuntime | undefined;
}) {
  return (
    <header className="panel flex flex-wrap items-center gap-x-5 gap-y-3 px-4 py-3 sm:px-5">
      <div className="flex items-center gap-3">
        <div className="relative grid h-11 w-11 place-items-center rounded-xl border border-mint/25 bg-gradient-to-br from-mint/15 to-cyan/10">
          <Activity className="h-5 w-5 text-mint" />
          <span className="pulse-dot absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-mint [--pulse-color:rgba(52,245,162,0.5)]" />
        </div>
        <div>
          <div className="flex items-baseline gap-2">
            <h1 className="text-xl font-bold tracking-[0.18em] text-zinc-50">ABBA</h1>
            <span className="font-mono text-[9px] tracking-[0.25em] text-zinc-500">SCALP ENGINE</span>
          </div>
          <StatusLine snap={snap} activeSession={activeSession} />
        </div>
      </div>

      {/* sim clock */}
      <div className="mx-auto flex items-center gap-6">
        <div className="text-center">
          <p className="font-mono text-[9px] tracking-[0.3em] text-zinc-500">SIM CLOCK · UTC</p>
          <p className="tabular font-mono text-2xl font-bold tracking-wider text-glow-mint text-mint">
            {fmtSimClock(simDisplay)}
          </p>
        </div>
        <div className="hidden text-left sm:block">
          <p className="font-mono text-[9px] tracking-[0.3em] text-zinc-500">DATE</p>
          <p className="font-mono text-xs font-semibold tracking-wider text-zinc-300">{fmtSimDate(simDisplay)}</p>
          <p className="mt-0.5 flex items-center gap-1.5 font-mono text-[10px] text-zinc-500">
            <Gauge className="h-3 w-3" />
            {snap.speed}× TIME COMPRESSION
          </p>
        </div>
      </div>

      <div className="ml-auto flex flex-wrap items-center gap-2">
        {/* speed */}
        <div className="panel-tight flex items-center gap-1 p-1">
          {SPEEDS.map((s) => (
            <button
              key={s}
              onClick={() => void post({ action: "speed", speed: s })}
              className={cx(
                "rounded-md px-2 py-1 font-mono text-[10px] font-semibold transition-all",
                snap.speed === s ? "bg-cyan/15 text-cyan" : "text-zinc-500 hover:text-zinc-300",
              )}
            >
              {s}×
            </button>
          ))}
        </div>

        {/* connection */}
        <div
          className={cx(
            "panel-tight flex items-center gap-2 px-3 py-2",
            snap.connUp ? "border-mint/20" : "border-rose-500/40",
          )}
        >
          {snap.connUp ? <Wifi className="h-3.5 w-3.5 text-mint" /> : <WifiOff className="h-3.5 w-3.5 text-rose-400 blink-soft" />}
          <span className={cx("font-mono text-[10px] font-semibold tracking-wider", snap.connUp ? "text-mint" : "text-rose-400")}>
            MT5 {snap.connUp ? "LINKED" : "DROPPED"}
          </span>
        </div>

        <HeaderButton
          title={snap.running ? "Pause engine" : "Resume engine"}
          onClick={() => void post({ action: "toggle" })}
          disabled={snap.killed}
          icon={snap.running ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
        />
        <HeaderButton
          title="Simulate MT5 disconnect"
          onClick={() => void post({ action: "disconnect" })}
          icon={<WifiOff className="h-3.5 w-3.5" />}
        />
        <ConfirmButton title="Reset terminal" onConfirm={() => void post({ action: "reset" })} icon={<RotateCcw className="h-3.5 w-3.5" />} />
        {snap.killed ? (
          <button
            onClick={() => void post({ action: "resume" })}
            className="glow-mint flex items-center gap-2 rounded-xl bg-mint px-3.5 py-2 font-mono text-[10px] font-bold tracking-wider text-[#04060b] transition-transform hover:scale-[1.03]"
          >
            <Power className="h-3.5 w-3.5" /> RE-ARM
          </button>
        ) : (
          <button
            onClick={() => void post({ action: "kill" })}
            className="flex items-center gap-2 rounded-xl border border-rose-500/40 bg-rose-500/10 px-3.5 py-2 font-mono text-[10px] font-bold tracking-wider text-rose-400 transition-colors hover:bg-rose-500/20"
          >
            <Power className="h-3.5 w-3.5" /> KILL
          </button>
        )}
        <span className="font-mono text-[9px] tracking-wider text-zinc-600">
          {(snap.mode ?? "sim").toUpperCase()}
          {snap.workerAlive ? " · WORKER" : ""}
        </span>
      </div>
    </header>
  );
}

function StatusLine({ snap, activeSession }: { snap: EngineSnapshot; activeSession: SessionRuntime | undefined }) {
  let text = "STANDBY";
  let cls = "text-zinc-500";
  if (snap.killed && snap.killConfirmed) {
    text = "KILLED — CONFIRMED FLAT";
    cls = "text-rose-400";
  } else if (snap.killed) {
    text = "KILL REQUESTED — FLATTENING";
    cls = "text-amber-400";
  } else if (!snap.running) {
    text = "PAUSED";
    cls = "text-amber-400";
  } else if (!snap.connUp) {
    text = snap.connStale ? "FEED STALE — DEFENSIVE MODE" : "LINK DOWN — DEFENSIVE MODE";
    cls = "text-rose-400";
  } else if (activeSession?.status === "trading") {
    text = `TRADING · ${activeSession.name.toUpperCase()}`;
    cls = "text-mint";
  } else if (activeSession?.status === "closeout") {
    text = `${activeSession.name.toUpperCase()} CLOSE-OUT`;
    cls = "text-amber-400";
  } else if (activeSession?.status === "target_hit") {
    text = `${activeSession.name.toUpperCase()} TARGET BANKED`;
    cls = "text-mint";
  } else {
    text = "INTERMISSION — WAITING FOR SESSION";
    cls = "text-zinc-400";
  }
  return <p className={cx("font-mono text-[10px] font-semibold tracking-[0.2em]", cls)}>{text}</p>;
}

function HeaderButton({
  title,
  onClick,
  icon,
  disabled,
}: {
  title: string;
  onClick: () => void;
  icon: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      disabled={disabled}
      className="panel-tight grid h-[34px] w-[34px] place-items-center text-zinc-400 transition-colors hover:text-zinc-100 disabled:opacity-40"
    >
      {icon}
    </button>
  );
}

function ConfirmButton({
  title,
  onConfirm,
  icon,
}: {
  title: string;
  onConfirm: () => void;
  icon: React.ReactNode;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 2600);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button
      title={title}
      onClick={() => {
        if (armed) {
          setArmed(false);
          onConfirm();
        } else setArmed(true);
      }}
      className={cx(
        "panel-tight grid h-[34px] w-[34px] place-items-center transition-colors",
        armed ? "border-amber-400/60 text-amber-300" : "text-zinc-400 hover:text-zinc-100",
      )}
    >
      {icon}
    </button>
  );
}

// ---------------------------------------------------------------------------
// session cards
// ---------------------------------------------------------------------------

function SessionCard({ rt }: { rt: SessionRuntime }) {
  const accent = SESSION_COLORS[rt.name] ?? "#45e0ff";
  const frac = rt.startEquity > 0 ? rt.equity / rt.startEquity - 1 : 0;
  const progress = Math.max(0, Math.min(1, frac / TARGET_PCT));
  const pnl = rt.equity - rt.startEquity;
  const winRate = rt.trades > 0 ? (rt.wins / rt.trades) * 100 : 0;

  const chip = {
    waiting: { label: "WAITING", cls: "border-zinc-700/60 text-zinc-500", dot: "bg-zinc-600" },
    trading: { label: "TRADING", cls: "border-mint/40 text-mint", dot: "bg-mint pulse-dot [--pulse-color:rgba(52,245,162,0.5)]" },
    closeout: { label: "CLOSE-OUT", cls: "border-amber-400/50 text-amber-300", dot: "bg-amber-400" },
    target_hit: { label: "TARGET LOCKED", cls: "border-mint/60 text-mint", dot: "bg-mint" },
    closed: { label: "CLOSED", cls: "border-zinc-700/60 text-zinc-400", dot: "bg-zinc-600" },
  }[rt.status];

  return (
    <motion.div
      layout
      className={cx("panel relative overflow-hidden px-4 py-3.5", rt.status === "target_hit" && "glow-mint")}
    >
      {rt.status === "target_hit" && (
        <div className="target-aura pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,rgba(52,245,162,0.25),transparent_60%)]" />
      )}
      <div className="relative">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span className="h-8 w-1 rounded-full" style={{ background: accent, boxShadow: `0 0 12px ${accent}` }} />
            <div>
              <p className="text-[13px] font-bold tracking-[0.14em] text-zinc-100">{rt.name.toUpperCase()}</p>
              <p className="font-mono text-[9px] tracking-[0.18em] text-zinc-500">{WINDOWS[rt.name]} UTC</p>
            </div>
          </div>
          <span className={cx("flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[9px] font-bold tracking-[0.14em]", chip.cls)}>
            <span className={cx("h-1.5 w-1.5 rounded-full", chip.dot)} />
            {chip.label}
          </span>
        </div>

        <div className="mt-3 flex items-end justify-between">
          <div>
            <p className="font-mono text-[9px] tracking-[0.2em] text-zinc-500">SESSION EQUITY</p>
            <p className={cx("tabular font-mono text-xl font-bold", frac >= 0 ? "text-mint" : "text-rose-400")}>
              <AN value={rt.equity} format={(v) => fmtMoney(v)} />
            </p>
          </div>
          <div className="text-right">
            <p className="font-mono text-[9px] tracking-[0.2em] text-zinc-500">P&L / TARGET</p>
            <p className={cx("tabular font-mono text-xs font-bold", pnl >= 0 ? "text-mint" : "text-rose-400")}>
              {fmtMoney(pnl, { sign: true })}
              <span className="text-zinc-500"> / </span>
              <span className="text-zinc-300">{fmtSignedPct(frac)}</span>
            </p>
          </div>
        </div>

        {/* progress to 20% target */}
        <div className="mt-3">
          <div className="relative h-1.5 overflow-hidden rounded-full bg-zinc-800/80">
            <motion.div
              className={cx("shimmer-bar relative h-full rounded-full")}
              style={{
                background: `linear-gradient(90deg, ${accent}, #45e0ff)`,
                boxShadow: `0 0 14px ${accent}66`,
              }}
              initial={false}
              animate={{ width: `${progress * 100}%` }}
              transition={{ type: "spring", stiffness: 60, damping: 18 }}
            />
          </div>
          <div className="mt-1.5 flex justify-between font-mono text-[9px] tracking-wider text-zinc-500">
            <span>BASE {fmtMoney(rt.startEquity)}</span>
            <span className="text-zinc-400">{Math.round(progress * 100)}% OF TARGET</span>
            <span>+20% {fmtMoney(rt.startEquity * (1 + TARGET_PCT))}</span>
          </div>
        </div>

        <div className="mt-3 grid grid-cols-3 gap-2 border-t border-white/5 pt-2.5">
            <Metric label="TRADES" value={String(rt.trades)} />
          <Metric label="W / L" value={`${rt.wins} / ${rt.losses}`} />
          <Metric label="WIN RATE" value={rt.trades > 0 ? `${winRate.toFixed(0)}%` : "—"} />
        </div>
      </div>
    </motion.div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="font-mono text-[8px] tracking-[0.2em] text-zinc-600">{label}</p>
      <p className="tabular font-mono text-[11px] font-bold text-zinc-200">{value}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// risk panel
// ---------------------------------------------------------------------------

function RiskPanel({ snap }: { snap: EngineSnapshot }) {
  const exposure = snap.openTrades.reduce((s, t) => s + t.riskPct, 0);
  const dayStartEq = snap.sessionHistory.length > 0 || snap.sessions.length > 0 ? snap.sessions[0]?.startEquity ?? snap.account : snap.account;
  const dayFrac = dayStartEq > 0 ? snap.account / dayStartEq - 1 : 0;

  return (
    <div className="panel px-4 py-3.5">
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-cyan" />
        <p className="font-mono text-[10px] font-bold tracking-[0.25em] text-zinc-300">RISK GOVERNOR</p>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <Metric label="ACCOUNT EQUITY" value={fmtMoney(snap.account)} />
        <Metric label="SESSION-DAY P&L" value={fmtSignedPct(dayFrac)} />
        <Metric label="RISK / TRADE" value="≤ 1.80%" />
        <Metric label="OPEN EXPOSURE" value={`${(exposure * 100).toFixed(2)}%`} />
        <Metric label="MAX POSITIONS" value="2" />
        <Metric label="OVERNIGHT HOLD" value="NEVER" />
      </div>
      <div className="mt-3 flex items-start gap-2 rounded-lg border border-white/5 bg-white/[0.02] p-2.5">
        <Shield className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-500" />
        <p className="font-mono text-[9px] leading-relaxed tracking-wider text-zinc-500">
          BREAKEVEN LOCK AT +4P · TRAIL 0.65×ATR · SIZE HALVED AFTER LOSS · FLAT 15 MIN BEFORE SESSION END
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// price chart panel
// ---------------------------------------------------------------------------

function ChartPanel({
  snap,
  symbol,
  setSymbol,
  market,
  trades,
}: {
  snap: EngineSnapshot;
  symbol: SymbolCode;
  setSymbol: (s: SymbolCode) => void;
  market: EngineSnapshot["markets"][SymbolCode] | undefined;
  trades: OpenTrade[];
}) {
  const spec = SYMBOL_MAP[symbol];
  return (
    <div className="panel flex min-h-[380px] flex-col p-4 xl:flex-1" style={{ minHeight: 400 }}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {SYMBOLS.map((s) => {
          const m = snap.markets[s.code];
          const chg = m && m.openDay > 0 ? (m.price / m.openDay - 1) * 100 : 0;
          const active = s.code === symbol;
          const inPlay = snap.openTrades.some((t) => t.symbol === s.code);
          return (
            <button
              key={s.code}
              onClick={() => setSymbol(s.code)}
              className={cx(
                "panel-tight group flex items-center gap-2 px-3 py-2 transition-all",
                active ? "border-cyan/50 bg-cyan/[0.06]" : "hover:border-white/20",
              )}
            >
              <span className={cx("font-mono text-[11px] font-bold tracking-wider", active ? "text-cyan" : "text-zinc-300")}>
                {s.code}
              </span>
              <span className={cx("tabular font-mono text-[10px]", chg >= 0 ? "text-mint" : "text-rose-400")}>
                {m ? m.price.toFixed(s.decimals) : "—"}
              </span>
              <span className={cx("flex items-center font-mono text-[9px]", chg >= 0 ? "text-mint/70" : "text-rose-400/70")}>
                {chg >= 0 ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
                {Math.abs(chg).toFixed(2)}%
              </span>
              {inPlay && <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-amber-400 [--pulse-color:rgba(255,193,77,0.5)]" />}
            </button>
          );
        })}
        <div className="ml-auto hidden items-center gap-4 font-mono text-[9px] tracking-wider text-zinc-500 lg:flex">
          <span>{spec.name.toUpperCase()}</span>
          <span>SPREAD {spec.spreadPips.toFixed(1)}P</span>
          <span>M1 CANDLES</span>
        </div>
      </div>
      <div className="relative min-h-[280px] flex-1">
        {market ? (
          <PriceChart candles={market.candles} decimals={spec.decimals} trades={trades} />
        ) : (
          <div className="grid h-full place-items-center font-mono text-[10px] tracking-wider text-zinc-600">
            AWAITING FEED…
          </div>
        )}
        {trades.length > 0 && (
          <div className="absolute left-3 top-3 flex items-center gap-2 rounded-lg border border-cyan/30 bg-[#04060b]/80 px-2.5 py-1.5 backdrop-blur">
            <Crosshair className="h-3.5 w-3.5 text-cyan" />
            <span className="font-mono text-[10px] font-bold tracking-wider text-cyan">
              IN POSITION · {trades[0].side.toUpperCase()} {trades[0].qty.toFixed(2)} · TRAILING ACTIVE
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// equity panel
// ---------------------------------------------------------------------------

function EquityPanel({ snap, activeSession }: { snap: EngineSnapshot; activeSession: SessionRuntime | undefined }) {
  const sess = activeSession;
  const dayStart = useMemo(() => {
    const d = new Date(snap.simNow);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }, [snap.simNow]);

  const points = useMemo(
    () => snap.equityCurve.filter((p) => p.t >= dayStart),
    [snap.equityCurve, dayStart],
  );

  const baseline = sess?.startEquity ?? snap.account;
  const target = baseline * (1 + TARGET_PCT);

  return (
    <div className="panel p-4" style={{ height: 230 }}>
      <div className="mb-1 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <CircleDollarSign className="h-4 w-4 text-mint" />
          <p className="font-mono text-[10px] font-bold tracking-[0.25em] text-zinc-300">
            SESSION EQUITY CURVE {sess ? `· ${sess.name.toUpperCase()}` : ""}
          </p>
        </div>
        {sess && (
          <div className="flex items-center gap-3 font-mono text-[9px] tracking-wider text-zinc-500">
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-0 w-4 border-t border-dashed border-zinc-400" /> BASELINE
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-0 w-4 border-t border-dashed border-mint" /> +20% TARGET
            </span>
          </div>
        )}
      </div>
      <div className="h-[168px]">
        <EquityChart points={points} baseline={baseline} target={target} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// open positions
// ---------------------------------------------------------------------------

function PositionsPanel({ snap }: { snap: EngineSnapshot }) {
  const open = snap.openTrades;
  return (
    <div className="panel flex flex-col p-4" style={{ minHeight: 240 }}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ScanLine className="h-4 w-4 text-amber-400" />
          <p className="font-mono text-[10px] font-bold tracking-[0.25em] text-zinc-300">OPEN POSITIONS</p>
        </div>
        <span className="font-mono text-[10px] text-zinc-500">
          {open.length} / 2
        </span>
      </div>

      <div className="mt-3 flex flex-1 flex-col gap-2.5">
        <AnimatePresence mode="popLayout">
          {open.length === 0 && (
            <motion.div
              key="flat"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex flex-1 items-center gap-4 rounded-xl border border-white/5 bg-white/[0.015] p-4"
            >
              <div className="relative h-14 w-14 shrink-0">
                <div className="radar-sweep absolute inset-0 rounded-full [background:conic-gradient(from_0deg,rgba(52,245,162,0.4),transparent_25%)]" />
                <div className="absolute inset-[2px] rounded-full border border-mint/15 bg-[#0a0e16]" />
                <div className="absolute inset-[38%] rounded-full border border-mint/30" />
                <div className="absolute inset-[18%] rounded-full border border-mint/10" />
              </div>
              <div>
                <p className="font-mono text-[11px] font-bold tracking-[0.2em] text-mint">FLAT</p>
                <p className="mt-1 font-mono text-[9px] leading-relaxed tracking-wider text-zinc-500">
                  SCANNING M1 FLOW FOR MOMENTUM BREAKS, SWEEPS & MICRO REVERSALS
                </p>
              </div>
            </motion.div>
          )}
          {open.map((t) => (
            <PositionCard key={t.id} trade={t} snap={snap} />
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}

function PositionCard({ trade: t, snap }: { trade: OpenTrade; snap: EngineSnapshot }) {
  const spec = SYMBOL_MAP[t.symbol];
  const m = snap.markets[t.symbol];
  const price = m?.price ?? t.entry;
  const grossPips = t.side === "long" ? (price - t.entry) / spec.pip : (t.entry - price) / spec.pip;
  const netPips = grossPips - spec.spreadPips;
  const pnl = netPips * t.qty * spec.pipValuePerLot;
  const up = pnl >= 0;

  // progress of price between SL and TP
  const lo = t.side === "long" ? t.sl : t.tp;
  const hi = t.side === "long" ? t.tp : t.sl;
  const pos = hi > lo ? Math.max(0, Math.min(1, (price - lo) / (hi - lo))) : 0.5;
  const entryPos = hi > lo ? Math.max(0, Math.min(1, (t.entry - lo) / (hi - lo))) : 0.5;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96 }}
      className={cx(
        "rounded-xl border p-3",
        up ? "border-mint/25 bg-mint/[0.04]" : "border-rose-500/25 bg-rose-500/[0.04]",
      )}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span
            className={cx(
              "rounded px-1.5 py-0.5 font-mono text-[9px] font-bold tracking-wider",
              t.side === "long" ? "bg-mint/15 text-mint" : "bg-rose-500/15 text-rose-400",
            )}
          >
            {t.side.toUpperCase()}
          </span>
          <span className="font-mono text-xs font-bold tracking-wider text-zinc-100">{t.symbol}</span>
          <span className="font-mono text-[9px] text-zinc-500">{t.qty.toFixed(2)} LOTS</span>
        </div>
        <span className={cx("tabular font-mono text-sm font-bold", up ? "text-mint text-glow-mint" : "text-rose-400 text-glow-rose")}>
          <AN value={pnl} format={(v) => fmtMoney(v, { sign: true })} />
        </span>
      </div>

      <div className="tabular mt-2 grid grid-cols-3 gap-2 font-mono text-[10px]">
        <div>
          <p className="text-[8px] tracking-[0.2em] text-zinc-600">ENTRY</p>
          <p className="text-zinc-300">{t.entry.toFixed(spec.decimals)}</p>
        </div>
        <div>
          <p className="text-[8px] tracking-[0.2em] text-zinc-600">MARK</p>
          <p className={up ? "text-mint" : "text-rose-400"}>{price.toFixed(spec.decimals)}</p>
        </div>
        <div>
          <p className="text-[8px] tracking-[0.2em] text-zinc-600">FLOAT</p>
          <p className={up ? "text-mint" : "text-rose-400"}>{netPips.toFixed(1)}p</p>
        </div>
      </div>

      {/* SL — price — TP ribbon */}
      <div className="mt-2.5">
        <div className="relative h-1 rounded-full bg-zinc-800">
          <div
            className="absolute inset-y-0 rounded-full"
            style={{
              left: `${Math.min(entryPos, pos) * 100}%`,
              width: `${Math.abs(pos - entryPos) * 100}%`,
              background: up ? "rgba(52,245,162,0.55)" : "rgba(255,84,112,0.55)",
            }}
          />
          <span
            className={cx("absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[#04060b]", up ? "bg-mint" : "bg-rose-400")}
            style={{ left: `${pos * 100}%` }}
          />
          <span
            className="absolute top-1/2 h-2 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-sm bg-cyan"
            style={{ left: `${entryPos * 100}%` }}
          />
        </div>
        <div className="tabular mt-1 flex justify-between font-mono text-[8px] tracking-wider text-zinc-500">
          <span className={(t.side === "long" ? t.sl > t.entry : t.sl < t.entry) ? "text-mint" : "text-rose-400/90"}>
            SL {t.sl.toFixed(spec.decimals)}{t.beDone ? " · TRAIL" : ""}
          </span>
          <span className="text-mint/80">TP {t.tp.toFixed(spec.decimals)}</span>
        </div>
      </div>

      <div className="mt-2 flex items-center justify-between border-t border-white/5 pt-1.5">
        <span className="font-mono text-[8px] tracking-[0.18em] text-zinc-600">{t.setup.toUpperCase()}</span>
        <span className="font-mono text-[8px] tracking-[0.18em] text-zinc-600">RISK {(t.riskPct * 100).toFixed(2)}%</span>
      </div>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// event feed
// ---------------------------------------------------------------------------

const EVENT_STYLE: Record<string, { icon: React.ReactNode; cls: string }> = {
  info: { icon: <Info className="h-3.5 w-3.5" />, cls: "text-zinc-400" },
  success: { icon: <CheckCircle2 className="h-3.5 w-3.5" />, cls: "text-mint" },
  warn: { icon: <AlertTriangle className="h-3.5 w-3.5" />, cls: "text-amber-400" },
  danger: { icon: <XCircle className="h-3.5 w-3.5" />, cls: "text-rose-400" },
};

function eventIcon(e: EventRow) {
  switch (e.type) {
    case "trade_open":
      return <Zap className="h-3.5 w-3.5" />;
    case "stop_hit":
      return <AlertTriangle className="h-3.5 w-3.5" />;
    case "target_hit":
      return <Target className="h-3.5 w-3.5" />;
    case "session_open":
      return <Play className="h-3.5 w-3.5" />;
    case "session_close":
      return <Flag className="h-3.5 w-3.5" />;
    case "session_closeout":
      return <Bell className="h-3.5 w-3.5" />;
    case "news":
      return <Bell className="h-3.5 w-3.5" />;
    case "conn_down":
      return <WifiOff className="h-3.5 w-3.5" />;
    case "conn_up":
      return <Wifi className="h-3.5 w-3.5" />;
    case "kill":
      return <Power className="h-3.5 w-3.5" />;
    default:
      return EVENT_STYLE[e.level]?.icon ?? <Info className="h-3.5 w-3.5" />;
  }
}

function EventFeed({
  events,
  newsActive,
  newsLabel,
}: {
  events: EventRow[];
  newsActive: boolean;
  newsLabel: string;
}) {
  const list = useMemo(() => [...events].reverse().slice(0, 28), [events]);
  return (
    <div className="panel flex min-h-0 flex-1 flex-col p-4" style={{ minHeight: 300 }}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-mint" />
          <p className="font-mono text-[10px] font-bold tracking-[0.25em] text-zinc-300">LIVE WIRE</p>
        </div>
        {newsActive && (
          <span className="blink-soft flex items-center gap-1.5 rounded-full border border-amber-400/50 px-2 py-0.5 font-mono text-[8px] font-bold tracking-wider text-amber-300">
            <Bell className="h-3 w-3" /> NEWS BLACKOUT
          </span>
        )}
      </div>
      {newsActive && (
        <p className="mt-2 rounded-lg border border-amber-400/20 bg-amber-400/[0.05] px-2.5 py-1.5 font-mono text-[9px] tracking-wider text-amber-300/90">
          {newsLabel} — ENTRIES SUSPENDED IN BLACKOUT WINDOW
        </p>
      )}
      <div className="nice-scroll mt-2 min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1" style={{ maxHeight: 460 }}>
        <AnimatePresence initial={false}>
          {list.map((e) => (
            <motion.div
              key={e.id}
              layout="position"
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              className="feed-in flex items-start gap-2.5 rounded-lg border border-white/[0.04] bg-white/[0.02] px-2.5 py-2"
            >
              <span className={cx("mt-0.5 shrink-0", EVENT_STYLE[e.level]?.cls ?? "text-zinc-400")}>{eventIcon(e)}</span>
              <div className="min-w-0">
                <p className="break-words font-mono text-[10px] leading-snug text-zinc-300">{e.message}</p>
                <p className="tabular mt-0.5 font-mono text-[8px] tracking-[0.2em] text-zinc-600">{fmtHm(e.simTime)} UTC</p>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
        {list.length === 0 && (
          <p className="py-8 text-center font-mono text-[10px] tracking-wider text-zinc-600">NO EVENTS YET</p>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// trade log
// ---------------------------------------------------------------------------

const REASON_CLS: Record<string, string> = {
  "Take profit": "border-mint/40 text-mint",
  "Trailing stop locked": "border-mint/40 text-mint",
  "Breakeven stop": "border-cyan/40 text-cyan",
  "Stop loss hit": "border-rose-500/50 text-rose-400",
  "Momentum exit": "border-amber-400/40 text-amber-300",
  "Time stop": "border-zinc-600 text-zinc-400",
  "Session close-out": "border-violet-400/40 text-violet-300",
  "Target locked — 20% secured": "border-mint/60 text-mint",
  "Kill switch flatten": "border-rose-500/50 text-rose-400",
};

function TradeLog({ snap }: { snap: EngineSnapshot }) {
  const rows = useMemo(() => snap.recentTrades.filter((t) => t.closedSim != null).slice(0, 30), [snap.recentTrades]);
  const totals = useMemo(() => {
    const wins = rows.filter((r) => r.pnl > 0).length;
    const pnl = rows.reduce((s, r) => s + r.pnl, 0);
    return { wins, pnl, n: rows.length, wr: rows.length ? (wins / rows.length) * 100 : 0 };
  }, [rows]);

  return (
    <div className="panel p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <History className="h-4 w-4 text-cyan" />
          <p className="font-mono text-[10px] font-bold tracking-[0.25em] text-zinc-300">EXECUTION LOG</p>
        </div>
        <div className="flex items-center gap-4 font-mono text-[9px] tracking-wider text-zinc-500">
          <span>
            SHOWN <span className="text-zinc-300">{totals.n}</span>
          </span>
          <span>
            WIN RATE <span className="text-mint">{totals.wr.toFixed(0)}%</span>
          </span>
          <span>
            NET <span className={totals.pnl >= 0 ? "text-mint" : "text-rose-400"}>{fmtMoney(totals.pnl, { sign: true })}</span>
          </span>
        </div>
      </div>

      <div className="nice-scroll overflow-x-auto" style={{ maxHeight: 300, overflowY: "auto" }}>
        <table className="w-full min-w-[980px] border-collapse font-mono text-[10px]">
          <thead className="sticky top-0 z-10 bg-[#0a0e16]">
            <tr className="text-left text-[8px] tracking-[0.22em] text-zinc-500">
              {["TIME", "SESSION", "SYMBOL", "SIDE", "SETUP", "LOTS", "ENTRY", "EXIT", "PIPS", "P&L", "EXIT REASON"].map((h) => (
                <th key={h} className="border-b border-white/5 px-2.5 py-2 font-semibold">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const spec: SymbolSpec | undefined = SYMBOL_MAP[r.symbol as SymbolCode];
              const dec = spec?.decimals ?? 5;
              return (
                <tr key={r.id} className="tabular border-b border-white/[0.03] text-zinc-300 transition-colors hover:bg-white/[0.025]">
                  <td className="px-2.5 py-2 text-zinc-500">{r.closedSim ? fmtHm(r.closedSim) : "—"}</td>
                  <td className="px-2.5 py-2">
                    <span className="flex items-center gap-1.5">
                      <span className="h-1.5 w-1.5 rounded-full" style={{ background: SESSION_COLORS[r.session] ?? "#666" }} />
                      {r.session}
                    </span>
                  </td>
                  <td className="px-2.5 py-2 font-bold text-zinc-100">{r.symbol}</td>
                  <td className="px-2.5 py-2">
                    <span className={cx("rounded px-1.5 py-0.5 text-[9px] font-bold", r.side === "long" ? "bg-mint/10 text-mint" : "bg-rose-500/10 text-rose-400")}>
                      {r.side.toUpperCase()}
                    </span>
                  </td>
                  <td className="px-2.5 py-2 text-zinc-400">{r.setup}</td>
                  <td className="px-2.5 py-2">{r.qty.toFixed(2)}</td>
                  <td className="px-2.5 py-2">{r.entryPrice.toFixed(dec)}</td>
                  <td className="px-2.5 py-2">{r.exitPrice.toFixed(dec)}</td>
                  <td className={cx("px-2.5 py-2", r.pips >= 0 ? "text-mint" : "text-rose-400")}>{fmtSignedPips(r.pips)}</td>
                  <td className={cx("px-2.5 py-2 font-bold", r.pnl >= 0 ? "text-mint" : "text-rose-400")}>
                    {fmtMoney(r.pnl, { sign: true })}
                  </td>
                  <td className="px-2.5 py-2">
                    <span className={cx("rounded-full border px-2 py-0.5 text-[9px]", REASON_CLS[r.exitReason ?? ""] ?? "border-zinc-600 text-zinc-400")}>
                      {r.exitReason}
                    </span>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={11} className="px-2.5 py-8 text-center text-zinc-600">
                  NO CLOSED TRADES YET — ENGINE IS SCANNING
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function fmtSignedPips(p: number) {
  return `${p >= 0 ? "+" : ""}${p.toFixed(1)}`;
}

// ---------------------------------------------------------------------------
// session history strip
// ---------------------------------------------------------------------------

function SessionHistoryStrip({ snap }: { snap: EngineSnapshot }) {
  if (snap.sessionHistory.length === 0) return null;
  return (
    <div className="panel flex flex-wrap items-center gap-2 px-4 py-3">
      <Flag className="h-3.5 w-3.5 text-violet-300" />
      <span className="mr-2 font-mono text-[9px] font-bold tracking-[0.25em] text-zinc-400">SESSION REPORTS</span>
      {snap.sessionHistory.map((s) => {
        const pnl = (s.endEquity ?? s.startEquity) - s.startEquity;
        const pct = s.startEquity > 0 ? ((s.endEquity ?? s.startEquity) / s.startEquity - 1) * 100 : 0;
        const hit = s.status === "target_hit";
        const wr = s.tradesCount > 0 ? (s.wins / s.tradesCount) * 100 : 0;
        return (
          <div
            key={s.id}
            className={cx(
              "flex items-center gap-2 rounded-lg border px-2.5 py-1.5 font-mono text-[9px]",
              hit ? "border-mint/30 bg-mint/[0.05]" : "border-white/10 bg-white/[0.02]",
            )}
          >
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: SESSION_COLORS[s.name] ?? "#666" }} />
            <span className="font-bold tracking-wider text-zinc-200">{s.name.toUpperCase()}</span>
            <span className="text-zinc-500">{s.simDate.slice(5)}</span>
            <span className={pnl >= 0 ? "text-mint" : "text-rose-400"}>{fmtMoney(pnl, { sign: true })}</span>
            <span className={pct >= 0 ? "text-mint/70" : "text-rose-400/70"}>({pct.toFixed(1)}%)</span>
            <span className="text-zinc-500">
              {s.tradesCount}T · {wr.toFixed(0)}%
            </span>
            {hit ? (
              <span className="flex items-center gap-1 font-bold text-mint">
                <Target className="h-3 w-3" /> HIT
              </span>
            ) : (
              <span className="font-bold text-zinc-500">MISSED</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
