"""
ABBA · MetaTrader 5 Python Bridge
=================================
Standalone FastAPI service that owns the MT5 terminal connection.

The Node engine talks to this process over HTTP. The bridge is responsible for:
  - terminal login / heartbeat / reconnect
  - symbol contract specs (tick size, contract size, margin, stops level)
  - streaming ticks + 1-minute bars
  - market / pending order placement with SL/TP
  - position modification (trailing stop, breakeven)
  - close-by-ticket and emergency flatten (true kill switch)
  - deal / position history for reconciliation on restart

Environment
-----------
  MT5_LOGIN      int     account number
  MT5_PASSWORD   str
  MT5_SERVER     str     broker server name as shown in terminal
  MT5_PATH       str     optional path to terminal64.exe (Windows only)
  BRIDGE_HOST    str     default 0.0.0.0
  BRIDGE_PORT    int     default 8765
  HEARTBEAT_SEC  float   default 2.0
  STALE_TICK_MS  int     default 15000  — mark feed stale after this
  ORDER_TIMEOUT  float   default 8.0    — seconds to wait for order fill
"""

from __future__ import annotations

import os
import time
import threading
from datetime import datetime, timezone
from typing import Any, Literal, Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

try:
    import MetaTrader5 as mt5
except ImportError:  # allow import on non-Windows / CI without the package
    mt5 = None  # type: ignore

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

LOGIN = int(os.getenv("MT5_LOGIN", "0") or 0)
PASSWORD = os.getenv("MT5_PASSWORD", "")
SERVER = os.getenv("MT5_SERVER", "")
PATH = os.getenv("MT5_PATH") or None
HOST = os.getenv("BRIDGE_HOST", "0.0.0.0")
PORT = int(os.getenv("BRIDGE_PORT", "8765"))
HEARTBEAT_SEC = float(os.getenv("HEARTBEAT_SEC", "2.0"))
STALE_TICK_MS = int(os.getenv("STALE_TICK_MS", "15000"))
ORDER_TIMEOUT = float(os.getenv("ORDER_TIMEOUT", "8.0"))
MAGIC = int(os.getenv("MT5_MAGIC", "260415"))  # ABBA magic number

SYMBOLS = ["EURUSD", "GBPUSD", "USDJPY", "XAUUSD"]

# ---------------------------------------------------------------------------
# Connection state (thread-safe)
# ---------------------------------------------------------------------------

_lock = threading.RLock()
_connected = False
_last_heartbeat = 0.0
_last_error = ""
_account_info: dict[str, Any] = {}
_tick_cache: dict[str, dict[str, Any]] = {}
_spec_cache: dict[str, dict[str, Any]] = {}
_kill_requested = False
_kill_confirmed = False


def _now_ms() -> int:
    return int(time.time() * 1000)


def _ensure_mt5():
    if mt5 is None:
        raise HTTPException(status_code=503, detail="MetaTrader5 package not installed")


def _initialize() -> bool:
    global _connected, _last_error, _last_heartbeat
    _ensure_mt5()
    kwargs: dict[str, Any] = {}
    if PATH:
        kwargs["path"] = PATH
    if LOGIN and PASSWORD and SERVER:
        kwargs.update(login=LOGIN, password=PASSWORD, server=SERVER)
    ok = mt5.initialize(**kwargs) if kwargs else mt5.initialize()
    if not ok:
        err = mt5.last_error()
        _last_error = f"initialize failed: {err}"
        _connected = False
        return False
    # ensure symbols are selected in Market Watch
    for sym in SYMBOLS:
        mt5.symbol_select(sym, True)
    _connected = True
    _last_error = ""
    _last_heartbeat = time.time()
    _refresh_account()
    _refresh_specs()
    return True


def _shutdown():
    global _connected
    if mt5 is not None:
        try:
            mt5.shutdown()
        except Exception:
            pass
    _connected = False


def _refresh_account():
    global _account_info
    info = mt5.account_info()
    if info is None:
        return
    _account_info = {
        "login": info.login,
        "balance": info.balance,
        "equity": info.equity,
        "margin": info.margin,
        "free_margin": info.margin_free,
        "leverage": info.leverage,
        "currency": info.currency,
        "server": info.server,
        "trade_allowed": bool(info.trade_allowed),
        "trade_expert": bool(info.trade_expert),
    }


def _refresh_specs():
    for sym in SYMBOLS:
        info = mt5.symbol_info(sym)
        if info is None:
            continue
        # pip size: for 5-digit FX, point=0.00001 → pip = 10*point
        point = float(info.point)
        digits = int(info.digits)
        if digits in (3, 5):
            pip = point * 10
        else:
            pip = point
        contract = float(info.trade_contract_size)
        tick_value = float(info.trade_tick_value)
        tick_size = float(info.trade_tick_size) or point
        # USD value of 1 pip per 1.00 lot
        pip_value = (pip / tick_size) * tick_value if tick_size else 0.0
        _spec_cache[sym] = {
            "symbol": sym,
            "digits": digits,
            "point": point,
            "pip": pip,
            "contract_size": contract,
            "tick_size": tick_size,
            "tick_value": tick_value,
            "pip_value_per_lot": pip_value,
            "volume_min": float(info.volume_min),
            "volume_max": float(info.volume_max),
            "volume_step": float(info.volume_step),
            "stops_level": int(info.trade_stops_level),
            "freeze_level": int(info.trade_freeze_level),
            "spread": int(info.spread),
            "trade_mode": int(info.trade_mode),
            "filling_mode": int(info.filling_mode),
            "margin_initial": float(info.margin_initial),
        }


def _refresh_ticks():
    for sym in SYMBOLS:
        tick = mt5.symbol_info_tick(sym)
        if tick is None:
            continue
        _tick_cache[sym] = {
            "symbol": sym,
            "bid": float(tick.bid),
            "ask": float(tick.ask),
            "last": float(tick.last),
            "volume": int(tick.volume),
            "time_msc": int(tick.time_msc),
            "flags": int(tick.flags),
            "spread": float(tick.ask - tick.bid) if tick.ask and tick.bid else 0.0,
        }


def _heartbeat_loop():
    global _connected, _last_heartbeat, _last_error
    while True:
        time.sleep(HEARTBEAT_SEC)
        with _lock:
            if not _connected:
                # try reconnect
                if not _initialize():
                    continue
            try:
                # terminal_info is a cheap liveness probe
                ti = mt5.terminal_info()
                if ti is None or not ti.connected:
                    _last_error = "terminal disconnected"
                    _connected = False
                    _shutdown()
                    continue
                _refresh_account()
                _refresh_ticks()
                _last_heartbeat = time.time()
                _last_error = ""
            except Exception as exc:
                _last_error = str(exc)
                _connected = False
                _shutdown()


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class OrderRequest(BaseModel):
    symbol: str
    side: Literal["long", "short"]
    volume: float
    sl: float
    tp: float
    comment: str = "ABBA"
    deviation: int = 20  # points


class ModifyRequest(BaseModel):
    ticket: int
    sl: Optional[float] = None
    tp: Optional[float] = None


class CloseRequest(BaseModel):
    ticket: int
    volume: Optional[float] = None  # partial close; None = full
    deviation: int = 20


class KillRequest(BaseModel):
    """Request emergency flatten of all ABBA positions."""
    confirm: bool = True


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

app = FastAPI(title="ABBA MT5 Bridge", version="1.0.0")


@app.on_event("startup")
def on_startup():
    with _lock:
        _initialize()
    t = threading.Thread(target=_heartbeat_loop, daemon=True, name="mt5-heartbeat")
    t.start()


@app.on_event("shutdown")
def on_shutdown():
    with _lock:
        _shutdown()


# ---- health / connection ---------------------------------------------------

@app.get("/health")
def health():
    with _lock:
        age_ms = int((time.time() - _last_heartbeat) * 1000) if _last_heartbeat else None
        stale = age_ms is not None and age_ms > STALE_TICK_MS
        return {
            "ok": _connected and not stale,
            "connected": _connected,
            "stale": stale,
            "last_heartbeat_ms": age_ms,
            "last_error": _last_error,
            "kill_requested": _kill_requested,
            "kill_confirmed": _kill_confirmed,
            "account": _account_info,
            "server_time_ms": _now_ms(),
        }


@app.post("/connect")
def connect():
    with _lock:
        ok = _initialize()
        if not ok:
            raise HTTPException(status_code=503, detail=_last_error or "connect failed")
        return {"ok": True, "account": _account_info}


@app.post("/disconnect")
def disconnect():
    with _lock:
        _shutdown()
        return {"ok": True}


# ---- market data -----------------------------------------------------------

@app.get("/specs")
def specs(symbol: Optional[str] = None):
    with _lock:
        if not _connected:
            raise HTTPException(status_code=503, detail="not connected")
        if not _spec_cache:
            _refresh_specs()
        if symbol:
            s = _spec_cache.get(symbol.upper())
            if not s:
                raise HTTPException(status_code=404, detail=f"unknown symbol {symbol}")
            return s
        return list(_spec_cache.values())


@app.get("/ticks")
def ticks(symbol: Optional[str] = None):
    with _lock:
        if not _connected:
            raise HTTPException(status_code=503, detail="not connected")
        _refresh_ticks()
        if symbol:
            t = _tick_cache.get(symbol.upper())
            if not t:
                raise HTTPException(status_code=404, detail=f"no tick for {symbol}")
            # mark stale per-symbol
            age = _now_ms() - t["time_msc"]
            return {**t, "stale": age > STALE_TICK_MS, "age_ms": age}
        out = []
        for sym, t in _tick_cache.items():
            age = _now_ms() - t["time_msc"]
            out.append({**t, "stale": age > STALE_TICK_MS, "age_ms": age})
        return out


@app.get("/bars")
def bars(symbol: str, count: int = 130, timeframe: str = "M1"):
    with _lock:
        if not _connected:
            raise HTTPException(status_code=503, detail="not connected")
        tf_map = {
            "M1": mt5.TIMEFRAME_M1,
            "M5": mt5.TIMEFRAME_M5,
            "M15": mt5.TIMEFRAME_M15,
            "H1": mt5.TIMEFRAME_H1,
        }
        tf = tf_map.get(timeframe.upper())
        if tf is None:
            raise HTTPException(status_code=400, detail=f"unsupported timeframe {timeframe}")
        rates = mt5.copy_rates_from_pos(symbol.upper(), tf, 0, min(count, 500))
        if rates is None:
            raise HTTPException(status_code=502, detail=f"no rates: {mt5.last_error()}")
        candles = []
        for r in rates:
            candles.append({
                "t": int(r["time"]) * 1000,
                "o": float(r["open"]),
                "h": float(r["high"]),
                "l": float(r["low"]),
                "c": float(r["close"]),
            })
        return candles


# ---- positions / deals (reconciliation) ------------------------------------

@app.get("/positions")
def positions(symbol: Optional[str] = None, magic_only: bool = True):
    with _lock:
        if not _connected:
            raise HTTPException(status_code=503, detail="not connected")
        pos = mt5.positions_get(symbol=symbol.upper()) if symbol else mt5.positions_get()
        if pos is None:
            return []
        out = []
        for p in pos:
            if magic_only and int(p.magic) != MAGIC:
                continue
            out.append({
                "ticket": int(p.ticket),
                "symbol": p.symbol,
                "side": "long" if p.type == mt5.ORDER_TYPE_BUY else "short",
                "volume": float(p.volume),
                "price_open": float(p.price_open),
                "sl": float(p.sl),
                "tp": float(p.tp),
                "profit": float(p.profit),
                "swap": float(p.swap),
                "magic": int(p.magic),
                "comment": p.comment,
                "time_msc": int(p.time_msc) if hasattr(p, "time_msc") else int(p.time) * 1000,
            })
        return out


@app.get("/deals")
def deals(from_ms: Optional[int] = None, to_ms: Optional[int] = None, magic_only: bool = True):
    with _lock:
        if not _connected:
            raise HTTPException(status_code=503, detail="not connected")
        now = datetime.now(timezone.utc)
        frm = datetime.fromtimestamp((from_ms or (_now_ms() - 7 * 86400_000)) / 1000, tz=timezone.utc)
        to = datetime.fromtimestamp((to_ms or _now_ms()) / 1000, tz=timezone.utc) if to_ms else now
        hist = mt5.history_deals_get(frm, to)
        if hist is None:
            return []
        out = []
        for d in hist:
            if magic_only and int(d.magic) != MAGIC:
                continue
            if d.entry not in (mt5.DEAL_ENTRY_IN, mt5.DEAL_ENTRY_OUT, mt5.DEAL_ENTRY_INOUT):
                continue
            out.append({
                "ticket": int(d.ticket),
                "order": int(d.order),
                "position_id": int(d.position_id),
                "symbol": d.symbol,
                "side": "long" if d.type == mt5.DEAL_TYPE_BUY else "short",
                "volume": float(d.volume),
                "price": float(d.price),
                "profit": float(d.profit),
                "commission": float(d.commission),
                "swap": float(d.swap),
                "magic": int(d.magic),
                "comment": d.comment,
                "entry": int(d.entry),  # 0=in, 1=out
                "time_msc": int(d.time_msc) if hasattr(d, "time_msc") else int(d.time) * 1000,
            })
        return out


# ---- order execution -------------------------------------------------------

def _filling_mode(symbol: str) -> int:
    info = mt5.symbol_info(symbol)
    if info is None:
        return mt5.ORDER_FILLING_IOC
    fm = info.filling_mode
    # prefer FOK, then IOC, then RETURN
    if fm & 1:  # SYMBOL_FILLING_FOK
        return mt5.ORDER_FILLING_FOK
    if fm & 2:  # SYMBOL_FILLING_IOC
        return mt5.ORDER_FILLING_IOC
    return mt5.ORDER_FILLING_RETURN


def _normalize_volume(symbol: str, volume: float) -> float:
    spec = _spec_cache.get(symbol) or {}
    step = float(spec.get("volume_step") or 0.01)
    vmin = float(spec.get("volume_min") or 0.01)
    vmax = float(spec.get("volume_max") or 100.0)
    if step <= 0:
        step = 0.01
    steps = round(volume / step)
    v = round(steps * step, 8)
    return max(vmin, min(vmax, v))


@app.post("/order")
def place_order(req: OrderRequest):
    global _kill_requested
    with _lock:
        if not _connected:
            raise HTTPException(status_code=503, detail="not connected")
        if _kill_requested:
            raise HTTPException(status_code=423, detail="kill switch active — new entries blocked")
        symbol = req.symbol.upper()
        tick = mt5.symbol_info_tick(symbol)
        if tick is None:
            raise HTTPException(status_code=502, detail=f"no tick for {symbol}")
        volume = _normalize_volume(symbol, req.volume)
        order_type = mt5.ORDER_TYPE_BUY if req.side == "long" else mt5.ORDER_TYPE_SELL
        price = float(tick.ask) if req.side == "long" else float(tick.bid)
        request = {
            "action": mt5.TRADE_ACTION_DEAL,
            "symbol": symbol,
            "volume": volume,
            "type": order_type,
            "price": price,
            "sl": float(req.sl),
            "tp": float(req.tp),
            "deviation": req.deviation,
            "magic": MAGIC,
            "comment": req.comment[:31],
            "type_time": mt5.ORDER_TIME_GTC,
            "type_filling": _filling_mode(symbol),
        }
        deadline = time.time() + ORDER_TIMEOUT
        last_retcode = None
        while time.time() < deadline:
            result = mt5.order_send(request)
            if result is None:
                raise HTTPException(status_code=502, detail=f"order_send null: {mt5.last_error()}")
            last_retcode = result.retcode
            if result.retcode == mt5.TRADE_RETCODE_DONE:
                return {
                    "ok": True,
                    "ticket": int(result.order),
                    "deal": int(result.deal),
                    "volume": float(result.volume),
                    "price": float(result.price),
                    "retcode": int(result.retcode),
                    "comment": result.comment,
                }
            # retryable: requote / price changed
            if result.retcode in (
                mt5.TRADE_RETCODE_REQUOTE,
                mt5.TRADE_RETCODE_PRICE_CHANGED,
                mt5.TRADE_RETCODE_PRICE_OFF,
            ):
                tick = mt5.symbol_info_tick(symbol)
                if tick:
                    request["price"] = float(tick.ask) if req.side == "long" else float(tick.bid)
                time.sleep(0.15)
                continue
            break
        raise HTTPException(
            status_code=502,
            detail=f"order failed retcode={last_retcode} comment={getattr(result, 'comment', '')}",
        )


@app.post("/modify")
def modify_position(req: ModifyRequest):
    with _lock:
        if not _connected:
            raise HTTPException(status_code=503, detail="not connected")
        pos_list = mt5.positions_get(ticket=req.ticket)
        if not pos_list:
            raise HTTPException(status_code=404, detail=f"position {req.ticket} not found")
        p = pos_list[0]
        request = {
            "action": mt5.TRADE_ACTION_SLTP,
            "symbol": p.symbol,
            "position": req.ticket,
            "sl": float(req.sl if req.sl is not None else p.sl),
            "tp": float(req.tp if req.tp is not None else p.tp),
            "magic": MAGIC,
        }
        result = mt5.order_send(request)
        if result is None or result.retcode != mt5.TRADE_RETCODE_DONE:
            raise HTTPException(
                status_code=502,
                detail=f"modify failed: {result.retcode if result else mt5.last_error()}",
            )
        return {"ok": True, "ticket": req.ticket, "sl": request["sl"], "tp": request["tp"]}


@app.post("/close")
def close_position(req: CloseRequest):
    with _lock:
        if not _connected:
            raise HTTPException(status_code=503, detail="not connected")
        pos_list = mt5.positions_get(ticket=req.ticket)
        if not pos_list:
            raise HTTPException(status_code=404, detail=f"position {req.ticket} not found")
        p = pos_list[0]
        volume = float(req.volume) if req.volume is not None else float(p.volume)
        volume = _normalize_volume(p.symbol, volume)
        close_type = mt5.ORDER_TYPE_SELL if p.type == mt5.ORDER_TYPE_BUY else mt5.ORDER_TYPE_BUY
        tick = mt5.symbol_info_tick(p.symbol)
        if tick is None:
            raise HTTPException(status_code=502, detail="no tick")
        price = float(tick.bid) if p.type == mt5.ORDER_TYPE_BUY else float(tick.ask)
        request = {
            "action": mt5.TRADE_ACTION_DEAL,
            "symbol": p.symbol,
            "volume": volume,
            "type": close_type,
            "position": req.ticket,
            "price": price,
            "deviation": req.deviation,
            "magic": MAGIC,
            "comment": "ABBA close",
            "type_time": mt5.ORDER_TIME_GTC,
            "type_filling": _filling_mode(p.symbol),
        }
        result = mt5.order_send(request)
        if result is None or result.retcode != mt5.TRADE_RETCODE_DONE:
            raise HTTPException(
                status_code=502,
                detail=f"close failed: {result.retcode if result else mt5.last_error()}",
            )
        return {
            "ok": True,
            "ticket": req.ticket,
            "deal": int(result.deal),
            "price": float(result.price),
            "volume": float(result.volume),
        }


@app.post("/kill")
def kill_switch(req: KillRequest):
    """
    True broker kill switch:
      1. Set kill_requested → blocks all new entries immediately
      2. Close every ABBA-magic position
      3. Set kill_confirmed only after all closes succeed (or none remain)
    Status is exposed on /health so the dashboard can distinguish
    "stop requested" from "confirmed flat + halted".
    """
    global _kill_requested, _kill_confirmed
    with _lock:
        if not req.confirm:
            raise HTTPException(status_code=400, detail="confirm must be true")
        _kill_requested = True
        _kill_confirmed = False
        if not _connected:
            # still block entries; positions will be reconciled on reconnect
            return {
                "ok": False,
                "kill_requested": True,
                "kill_confirmed": False,
                "closed": [],
                "errors": ["not connected — entries blocked, flatten deferred"],
            }
        pos = mt5.positions_get() or []
        closed = []
        errors = []
        for p in pos:
            if int(p.magic) != MAGIC:
                continue
            try:
                close_type = mt5.ORDER_TYPE_SELL if p.type == mt5.ORDER_TYPE_BUY else mt5.ORDER_TYPE_BUY
                tick = mt5.symbol_info_tick(p.symbol)
                if tick is None:
                    errors.append(f"{p.ticket}: no tick")
                    continue
                price = float(tick.bid) if p.type == mt5.ORDER_TYPE_BUY else float(tick.ask)
                request = {
                    "action": mt5.TRADE_ACTION_DEAL,
                    "symbol": p.symbol,
                    "volume": float(p.volume),
                    "type": close_type,
                    "position": int(p.ticket),
                    "price": price,
                    "deviation": 50,
                    "magic": MAGIC,
                    "comment": "ABBA KILL",
                    "type_time": mt5.ORDER_TIME_GTC,
                    "type_filling": _filling_mode(p.symbol),
                }
                result = mt5.order_send(request)
                if result and result.retcode == mt5.TRADE_RETCODE_DONE:
                    closed.append({"ticket": int(p.ticket), "price": float(result.price)})
                else:
                    errors.append(f"{p.ticket}: retcode={result.retcode if result else mt5.last_error()}")
            except Exception as exc:
                errors.append(f"{p.ticket}: {exc}")

        remaining = [
            int(p.ticket)
            for p in (mt5.positions_get() or [])
            if int(p.magic) == MAGIC
        ]
        _kill_confirmed = len(remaining) == 0
        return {
            "ok": _kill_confirmed,
            "kill_requested": True,
            "kill_confirmed": _kill_confirmed,
            "closed": closed,
            "remaining": remaining,
            "errors": errors,
        }


@app.post("/unkill")
def unkill():
    global _kill_requested, _kill_confirmed
    with _lock:
        _kill_requested = False
        _kill_confirmed = False
        return {"ok": True, "kill_requested": False, "kill_confirmed": False}


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("mt5_bridge:app", host=HOST, port=PORT, reload=False)
