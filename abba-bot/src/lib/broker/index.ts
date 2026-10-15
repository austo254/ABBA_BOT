export * from "./mt5-client";
export * from "./reconcile";
export * from "./news";

/** Trading mode: simulation (default) or live MT5 bridge. */
export type TradingMode = "sim" | "live";

export function tradingMode(): TradingMode {
  const m = (process.env.TRADING_MODE || "sim").toLowerCase();
  return m === "live" ? "live" : "sim";
}

export function isLive(): boolean {
  return tradingMode() === "live";
}
