/**
 * ABBA · HTTP client for the Python MT5 bridge.
 *
 * All live broker I/O goes through this module. Simulation mode never
 * imports it; the engine selects the adapter via TRADING_MODE env.
 */

const BRIDGE_URL = (process.env.MT5_BRIDGE_URL || "http://127.0.0.1:8765").replace(/\/$/, "");
const DEFAULT_TIMEOUT_MS = 10_000;

export interface BridgeHealth {
  ok: boolean;
  connected: boolean;
  stale: boolean;
  last_heartbeat_ms: number | null;
  last_error: string;
  kill_requested: boolean;
  kill_confirmed: boolean;
  account: {
    login?: number;
    balance?: number;
    equity?: number;
    margin?: number;
    free_margin?: number;
    leverage?: number;
    currency?: string;
    server?: string;
    trade_allowed?: boolean;
    trade_expert?: boolean;
  };
  server_time_ms: number;
}

export interface SymbolContractSpec {
  symbol: string;
  digits: number;
  point: number;
  pip: number;
  contract_size: number;
  tick_size: number;
  tick_value: number;
  pip_value_per_lot: number;
  volume_min: number;
  volume_max: number;
  volume_step: number;
  stops_level: number;
  freeze_level: number;
  spread: number;
  trade_mode: number;
  filling_mode: number;
  margin_initial: number;
}

export interface Tick {
  symbol: string;
  bid: number;
  ask: number;
  last: number;
  volume: number;
  time_msc: number;
  spread: number;
  stale: boolean;
  age_ms: number;
}

export interface CandleBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

export interface BridgePosition {
  ticket: number;
  symbol: string;
  side: "long" | "short";
  volume: number;
  price_open: number;
  sl: number;
  tp: number;
  profit: number;
  swap: number;
  magic: number;
  comment: string;
  time_msc: number;
}

export interface BridgeDeal {
  ticket: number;
  order: number;
  position_id: number;
  symbol: string;
  side: "long" | "short";
  volume: number;
  price: number;
  profit: number;
  commission: number;
  swap: number;
  magic: number;
  comment: string;
  entry: number; // 0 = in, 1 = out
  time_msc: number;
}

export interface OrderResult {
  ok: boolean;
  ticket: number;
  deal: number;
  volume: number;
  price: number;
  retcode: number;
  comment: string;
}

export interface KillResult {
  ok: boolean;
  kill_requested: boolean;
  kill_confirmed: boolean;
  closed: { ticket: number; price: number }[];
  remaining?: number[];
  errors: string[];
}

async function bridgeFetch<T>(
  path: string,
  init?: RequestInit & { timeoutMs?: number },
): Promise<T> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...rest } = init ?? {};
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BRIDGE_URL}${path}`, {
      ...rest,
      signal: ctrl.signal,
      headers: {
        "content-type": "application/json",
        ...(rest.headers ?? {}),
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`bridge ${path} → ${res.status}: ${body.slice(0, 300)}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export async function getHealth(): Promise<BridgeHealth> {
  return bridgeFetch<BridgeHealth>("/health", { timeoutMs: 4000 });
}

export async function connectBridge(): Promise<BridgeHealth> {
  await bridgeFetch<{ ok: boolean }>("/connect", { method: "POST" });
  return getHealth();
}

export async function getSpecs(symbol?: string): Promise<SymbolContractSpec | SymbolContractSpec[]> {
  const q = symbol ? `?symbol=${encodeURIComponent(symbol)}` : "";
  return bridgeFetch(`/specs${q}`);
}

export async function getTicks(symbol?: string): Promise<Tick | Tick[]> {
  const q = symbol ? `?symbol=${encodeURIComponent(symbol)}` : "";
  return bridgeFetch(`/ticks${q}`);
}

export async function getBars(
  symbol: string,
  count = 130,
  timeframe = "M1",
): Promise<CandleBar[]> {
  return bridgeFetch(
    `/bars?symbol=${encodeURIComponent(symbol)}&count=${count}&timeframe=${timeframe}`,
  );
}

export async function getPositions(opts?: {
  symbol?: string;
  magicOnly?: boolean;
}): Promise<BridgePosition[]> {
  const params = new URLSearchParams();
  if (opts?.symbol) params.set("symbol", opts.symbol);
  if (opts?.magicOnly === false) params.set("magic_only", "false");
  const q = params.toString() ? `?${params}` : "";
  return bridgeFetch(`/positions${q}`);
}

export async function getDeals(opts?: {
  fromMs?: number;
  toMs?: number;
  magicOnly?: boolean;
}): Promise<BridgeDeal[]> {
  const params = new URLSearchParams();
  if (opts?.fromMs != null) params.set("from_ms", String(opts.fromMs));
  if (opts?.toMs != null) params.set("to_ms", String(opts.toMs));
  if (opts?.magicOnly === false) params.set("magic_only", "false");
  const q = params.toString() ? `?${params}` : "";
  return bridgeFetch(`/deals${q}`);
}

export async function placeOrder(body: {
  symbol: string;
  side: "long" | "short";
  volume: number;
  sl: number;
  tp: number;
  comment?: string;
  deviation?: number;
}): Promise<OrderResult> {
  return bridgeFetch("/order", {
    method: "POST",
    body: JSON.stringify(body),
    timeoutMs: 15_000,
  });
}

export async function modifyPosition(body: {
  ticket: number;
  sl?: number;
  tp?: number;
}): Promise<{ ok: boolean; ticket: number; sl: number; tp: number }> {
  return bridgeFetch("/modify", { method: "POST", body: JSON.stringify(body) });
}

export async function closePosition(body: {
  ticket: number;
  volume?: number;
  deviation?: number;
}): Promise<{ ok: boolean; ticket: number; deal: number; price: number; volume: number }> {
  return bridgeFetch("/close", {
    method: "POST",
    body: JSON.stringify(body),
    timeoutMs: 15_000,
  });
}

export async function killSwitch(): Promise<KillResult> {
  return bridgeFetch("/kill", {
    method: "POST",
    body: JSON.stringify({ confirm: true }),
    timeoutMs: 30_000,
  });
}

export async function unkill(): Promise<{ ok: boolean }> {
  return bridgeFetch("/unkill", { method: "POST", body: "{}" });
}

/**
 * Broker-aware position size.
 *
 * Computes the monetary loss if SL is hit, using the instrument's actual
 * pip value per lot from the bridge contract spec. If the broker minimum
 * lot would exceed the risk budget, returns null (caller must skip the trade).
 */
export function sizeByRisk(opts: {
  equity: number;
  riskPct: number;
  entry: number;
  stop: number;
  side: "long" | "short";
  pip: number;
  pipValuePerLot: number;
  volumeMin: number;
  volumeStep: number;
  volumeMax: number;
}): { lots: number; riskUsd: number; stopPips: number } | null {
  const stopDist = Math.abs(opts.entry - opts.stop);
  if (stopDist <= 0 || opts.pip <= 0 || opts.pipValuePerLot <= 0) return null;

  const stopPips = stopDist / opts.pip;
  const riskUsd = opts.equity * opts.riskPct;
  const rawLots = riskUsd / (stopPips * opts.pipValuePerLot);

  // round down to volume_step
  const step = opts.volumeStep > 0 ? opts.volumeStep : 0.01;
  const stepped = Math.floor(rawLots / step) * step;
  const lots = Math.min(opts.volumeMax, Math.max(0, stepped));

  // If even the minimum lot exceeds the risk limit, skip the trade
  if (lots < opts.volumeMin - 1e-12) {
    const minRisk = opts.volumeMin * stopPips * opts.pipValuePerLot;
    if (minRisk > riskUsd * 1.02) {
      // 2 % tolerance for rounding
      return null;
    }
    // otherwise take the minimum lot (within tolerance)
    return {
      lots: opts.volumeMin,
      riskUsd: opts.volumeMin * stopPips * opts.pipValuePerLot,
      stopPips,
    };
  }

  return { lots: Math.round(lots * 1e8) / 1e8, riskUsd: lots * stopPips * opts.pipValuePerLot, stopPips };
}
