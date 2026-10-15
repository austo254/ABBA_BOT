/**
 * ABBA · Persistent engine worker
 *
 * Owns the tick loop so trading continues when the dashboard is closed
 * or the browser stops polling. Run alongside `next start` / `next dev`:
 *
 *   TRADING_MODE=live  npx tsx scripts/worker.ts
 *   TRADING_MODE=sim   npx tsx scripts/worker.ts
 *
 * Env:
 *   TICK_MS           default 1000 (live) / 400 (sim)
 *   MT5_BRIDGE_URL    default http://127.0.0.1:8765
 *   DATABASE_URL      required (same as Next app)
 */

import "dotenv/config";

// Ensure the engine never treats HTTP requests as the driver while we run
process.env.WORKER_OWNED = "1";

async function main() {
  // Dynamic import so dotenv has already loaded
  const { workerTick } = await import("../src/lib/engine");
  const { isLive } = await import("../src/lib/broker");

  const live = isLive();
  const interval = Number(process.env.TICK_MS) || (live ? 1000 : 400);

  console.log(`[worker] starting · mode=${live ? "live" : "sim"} · tick=${interval}ms`);

  let busy = false;
  const loop = async () => {
    if (busy) return;
    busy = true;
    try {
      const state = await workerTick();
      if (process.env.WORKER_VERBOSE === "1") {
        console.log(
          `[worker] t=${new Date(state.simNow).toISOString()} running=${state.running} killed=${state.killed} open=${state.openTrades.length} eq=${state.account.toFixed(2)}`,
        );
      }
    } catch (err) {
      console.error("[worker] tick error:", err instanceof Error ? err.message : err);
    } finally {
      busy = false;
    }
  };

  // Immediate first tick (includes live reconcile)
  await loop();
  setInterval(loop, interval);

  // Keep process alive
  process.on("SIGINT", () => {
    console.log("[worker] shutting down");
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    console.log("[worker] shutting down");
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("[worker] fatal:", err);
  process.exit(1);
});
