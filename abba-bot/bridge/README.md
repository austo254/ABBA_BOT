# ABBA MT5 Python Bridge

Standalone FastAPI service that owns the MetaTrader 5 terminal connection.

## Requirements

- Windows host with MetaTrader 5 terminal installed and logged in (or credentials via env)
- Python 3.10+
- `pip install -r requirements.txt`

> The official `MetaTrader5` package only runs on Windows. For Linux development you can still start the bridge; endpoints will return 503 until a Windows terminal is reachable (e.g. via Wine or a remote Windows VM).

## Environment

| Variable       | Default | Description                          |
|----------------|---------|--------------------------------------|
| `MT5_LOGIN`    | —       | Account number                       |
| `MT5_PASSWORD` | —       | Account password                     |
| `MT5_SERVER`   | —       | Broker server name                   |
| `MT5_PATH`     | —       | Optional path to `terminal64.exe`    |
| `MT5_MAGIC`    | 260415  | Magic number for ABBA orders         |
| `BRIDGE_HOST`  | 0.0.0.0 | Bind address                         |
| `BRIDGE_PORT`  | 8765    | HTTP port                            |
| `HEARTBEAT_SEC`| 2.0     | Terminal liveness probe interval     |
| `STALE_TICK_MS`| 15000   | Mark feed stale after N ms           |
| `ORDER_TIMEOUT`| 8.0     | Seconds to retry requotes            |

## Run

```bash
cd bridge
pip install -r requirements.txt
python mt5_bridge.py
# or: uvicorn mt5_bridge:app --host 0.0.0.0 --port 8765
```

## Endpoints

| Method | Path         | Purpose                                      |
|--------|--------------|----------------------------------------------|
| GET    | `/health`    | Connection, heartbeat age, kill status, account |
| POST   | `/connect`   | Force (re)initialize terminal                |
| POST   | `/disconnect`| Shutdown terminal link                       |
| GET    | `/specs`     | Contract specs (pip, lot step, tick value…)  |
| GET    | `/ticks`     | Latest bid/ask + stale flag                  |
| GET    | `/bars`      | OHLC history (`symbol`, `count`, `timeframe`)|
| GET    | `/positions` | Open positions (magic-filtered by default)   |
| GET    | `/deals`     | History deals for reconciliation             |
| POST   | `/order`     | Market entry with SL/TP                      |
| POST   | `/modify`    | Change SL/TP on an open position             |
| POST   | `/close`     | Close (or partial-close) by ticket           |
| POST   | `/kill`      | **True kill switch**: block entries + flatten|
| POST   | `/unkill`    | Clear kill flags                             |

## Kill-switch semantics

1. `POST /kill` sets `kill_requested=true` immediately → all new `/order` calls return 423.
2. Bridge attempts to close every position with ABBA magic.
3. `kill_confirmed=true` only when zero ABBA positions remain.
4. Dashboard / engine should surface **requested** vs **confirmed** distinctly.
5. `POST /unkill` clears both flags so trading can resume after operator review.
