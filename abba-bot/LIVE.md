# ABBA Live Trading — Architecture & Ops

## What changed (critical fixes)

| # | Issue | Fix |
|---|-------|-----|
| 1 | Dashboard drove the engine via `GET /api/engine → advanceAndSnapshot()` | Persistent **worker** (`scripts/worker.ts`) owns the tick loop. Dashboard GET is **read-only** when `workerHeartbeat` is fresh or `TRADING_MODE=live`. |
| 2 | Kill switch only closed simulated positions | Live kill calls bridge `POST /kill`: blocks new entries immediately, flattens ABBA-magic positions at the broker, exposes `killed` vs `killConfirmed`. |
| 3 | Connection status was simulated | Bridge heartbeat thread + stale-tick checks; engine mirrors `connUp` / `connStale` / `connHeartbeatMs` from `/health`. |
| 4 | Risk used fixed pip values + min-lot clamp | `sizeByRisk()` uses bridge contract specs (`pip_value_per_lot`, `volume_min/step`). **If min lot exceeds risk budget, the trade is skipped.** |
| 5 | Restart could forget / duplicate positions | `reconcilePositions()` on worker start (and periodically): DB↔broker match by ticket; import orphans; close DB rows whose broker position is gone. |
| 6 | Session/news used accelerated sim time | Live mode sets `simNow = Date.now()`; sessions use UTC wall clock; news from real economic calendar (`NEWS_CALENDAR_URL`). |
| 7 | Simulator granted artificial post-entry drift | `edgeDir` / `edgeLifeMs` **removed**. No entry-related price bias. |

## Process topology

```
┌─────────────────┐     HTTP      ┌──────────────────┐
│  Next.js app    │◄─────────────►│  Dashboard UI    │
│  (API routes)   │   poll snap   └──────────────────┘
└────────▲────────┘
         │ read/write state
         │
┌────────┴────────┐     HTTP      ┌──────────────────┐
│  Worker process │◄─────────────►│  Python MT5      │
│  scripts/worker │  ticks/orders │  bridge :8765    │
└─────────────────┘               └────────▲─────────┘
                                           │
                                  MetaTrader 5 terminal
```

## Run live

1. **Windows host** — start MetaTrader 5, log in, enable Algo Trading.
2. **Bridge**
   ```bash
   cd bridge
   pip install -r requirements.txt
   set MT5_LOGIN=...
   set MT5_PASSWORD=...
   set MT5_SERVER=...
   python mt5_bridge.py
   ```
3. **App + worker** (Linux/Mac or same Windows box)
   ```bash
   export TRADING_MODE=live
   export MT5_BRIDGE_URL=http://<bridge-host>:8765
   export DATABASE_URL=...
   npm run dev          # or start
   npm run worker       # separate terminal — must stay up
   ```

## Kill switch UX

- **Requested** (`killed=true`, `killConfirmed=false`): no new entries; flatten in progress or deferred.
- **Confirmed** (`killConfirmed=true`): broker reports zero ABBA positions.
- **Resume** clears both flags via bridge `/unkill` + engine `resume`.

## Risk formula (live)

```
stopPips   = |entry − stop| / pip
riskUsd    = equity × riskPct
rawLots    = riskUsd / (stopPips × pipValuePerLot)
lots       = floor_to_step(rawLots)
if lots < volume_min and minLotRisk > riskUsd → SKIP trade
```

## Reconciliation

On first live worker tick (and ~every 60s):

1. Fetch broker positions with ABBA magic.
2. Match DB open trades by `brokerTicket`.
3. Missing at broker → close DB row from deal history.
4. Extra at broker → insert DB row (`setup=Reconciled`).

An application restart will not open a duplicate: entries only fire after reconcile and when gates allow.
