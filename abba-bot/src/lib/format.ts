export function fmtMoney(v: number, opts?: { sign?: boolean }): string {
  const abs = Math.abs(v);
  const core = abs >= 1000 ? abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : abs.toFixed(2);
  const sign = v < 0 ? "-" : opts?.sign ? "+" : "";
  return `${sign}$${core}`;
}

export function fmtPrice(v: number, decimals: number): string {
  return v.toFixed(decimals);
}

export function fmtSimClock(simNow: number): string {
  const d = new Date(simNow);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

export function fmtHm(simNow: number): string {
  const d = new Date(simNow);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

export function fmtSimDate(simNow: number): string {
  const d = new Date(simNow);
  const days = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
  const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  return `${days[d.getUTCDay()]} ${String(d.getUTCDate()).padStart(2, "0")} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export function fmtSignedPct(frac: number): string {
  const pct = frac * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
}

export function fmtPips(p: number): string {
  return `${p >= 0 ? "+" : ""}${p.toFixed(1)}p`;
}

export function fmtDur(ms: number): string {
  const totalMin = Math.round(ms / 60000);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}
