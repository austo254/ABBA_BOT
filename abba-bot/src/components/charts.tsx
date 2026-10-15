"use client";

import { useEffect, useRef } from "react";
import type { Candle, OpenTrade } from "@/lib/types";

const MINT = "#34f5a2";
const ROSE = "#ff5470";
const CYAN = "#45e0ff";
const GRID = "rgba(148,163,184,0.07)";
const LABEL = "rgba(148,163,184,0.75)";

function useCanvas(draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const drawRef = useRef(draw);
  drawRef.current = draw;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (!parent) return;

    const render = () => {
      const rect = parent.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.max(10, rect.width);
      const h = Math.max(10, rect.height);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      drawRef.current(ctx, w, h);
    };

    render();
    const ro = new ResizeObserver(render);
    ro.observe(parent);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = ref.current;
    const parent = canvas?.parentElement;
    if (!canvas || !parent) return;
    const rect = parent.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(10, rect.width);
    const h = Math.max(10, rect.height);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    drawRef.current(ctx, w, h);
  });

  return ref;
}

function priceTicks(min: number, max: number) {
  const span = max - min || 1e-9;
  const rough = span / 5;
  const pow = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / pow;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * pow;
  const start = Math.ceil(min / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= max + 1e-12; v += step) ticks.push(v);
  return ticks;
}

export function PriceChart({
  candles,
  decimals,
  trades,
}: {
  candles: Candle[];
  decimals: number;
  trades: OpenTrade[];
}) {
  const ref = useCanvas((ctx, w, h) => {
    const padR = 66;
    const padL = 8;
    const padT = 12;
    const padB = 22;
    const plotW = w - padR - padL;
    const plotH = h - padT - padB;

    const data = candles.length > 2 ? candles : makeSeedCandles();
    let lo = Infinity;
    let hi = -Infinity;
    for (const c of data) {
      if (c.l < lo) lo = c.l;
      if (c.h > hi) hi = c.h;
    }
    for (const t of trades) {
      lo = Math.min(lo, t.sl, t.tp, t.entry);
      hi = Math.max(hi, t.sl, t.tp, t.entry);
    }
    const span = hi - lo || 1;
    lo -= span * 0.06;
    hi += span * 0.06;

    const x = (i: number) => padL + (i + 0.5) * (plotW / data.length);
    const y = (p: number) => padT + (1 - (p - lo) / (hi - lo)) * plotH;

    ctx.font = "10px var(--font-jet), monospace";

    // grid + price labels
    for (const tick of priceTicks(lo, hi)) {
      const yy = y(tick);
      ctx.strokeStyle = GRID;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padL, yy);
      ctx.lineTo(w - padR, yy);
      ctx.stroke();
      ctx.fillStyle = LABEL;
      ctx.textAlign = "left";
      ctx.fillText(tick.toFixed(decimals), w - padR + 8, yy + 3);
    }

    // time labels
    ctx.fillStyle = LABEL;
    ctx.textAlign = "center";
    const every = Math.max(1, Math.floor(data.length / 5));
    for (let i = 0; i < data.length; i += every) {
      const d = new Date(data[i].t);
      const lbl = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
      ctx.fillText(lbl, x(i), h - 7);
    }

    // candles
    const bw = Math.max(1.5, Math.min(9, (plotW / data.length) * 0.62));
    for (let i = 0; i < data.length; i++) {
      const c = data[i];
      const up = c.c >= c.o;
      ctx.strokeStyle = up ? "rgba(52,245,162,0.85)" : "rgba(255,84,112,0.85)";
      ctx.fillStyle = up ? "rgba(52,245,162,0.75)" : "rgba(255,84,112,0.75)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x(i), y(c.h));
      ctx.lineTo(x(i), y(c.l));
      ctx.stroke();
      const top = y(Math.max(c.o, c.c));
      const bot = y(Math.min(c.o, c.c));
      ctx.fillRect(x(i) - bw / 2, top, bw, Math.max(1, bot - top));
    }

    const last = data[data.length - 1];
    const prev = data[data.length - 2] ?? last;
    const lastCol = last.c >= prev.c ? MINT : ROSE;

    levelLine(ctx, y(last.c), padL, w - padR, lastCol, [4, 4], 0.55);
    tag(ctx, w - padR + 2, y(last.c), last.c.toFixed(decimals), lastCol, "#04060b", decimals);

    // open trade levels
    for (const t of trades) {
      const dir = t.side === "long" ? 1 : -1;
      const entryCol = CYAN;
      const slImproved = dir === 1 ? t.sl > t.entry : t.sl < t.entry;
      const slCol = slImproved ? MINT : ROSE;

      levelLine(ctx, y(t.entry), padL, w - padR, entryCol, [], 0.75);
      tag(ctx, w - padR + 2, y(t.entry), `IN ${t.entry.toFixed(decimals)}`, "#04060b", entryCol, decimals, true);

      levelLine(ctx, y(t.sl), padL, w - padR, slCol, [2, 3], 0.9);
      tag(ctx, w - padR + 2, y(t.sl), `SL ${t.sl.toFixed(decimals)}`, "#04060b", slCol, decimals, true);

      levelLine(ctx, y(t.tp), padL, w - padR, MINT, [7, 4], 0.6);
      tag(ctx, w - padR + 2, y(t.tp), `TP ${t.tp.toFixed(decimals)}`, "#04060b", MINT, decimals, true);

      // fill between entry and current price
      const yNow = y(last.c);
      const yEntry = y(t.entry);
      const grad = ctx.createLinearGradient(0, Math.min(yNow, yEntry), 0, Math.max(yNow, yEntry));
      const inProfit = (last.c - t.entry) * dir > 0;
      grad.addColorStop(0, inProfit ? "rgba(52,245,162,0.10)" : "rgba(255,84,112,0.10)");
      grad.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = grad;
      ctx.fillRect(padL, Math.min(yNow, yEntry), plotW, Math.abs(yNow - yEntry) || 1);
    }
  });

  return <canvas ref={ref} className="block h-full w-full" />;
}

function levelLine(
  ctx: CanvasRenderingContext2D,
  yy: number,
  x1: number,
  x2: number,
  color: string,
  dash: number[],
  alpha: number,
) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.setLineDash(dash);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x1, yy);
  ctx.lineTo(x2, yy);
  ctx.stroke();
  ctx.restore();
}

function tag(
  ctx: CanvasRenderingContext2D,
  xPos: number,
  yPos: number,
  text: string,
  fg: string,
  bg: string,
  _decimals: number,
  fillTag = false,
) {
    ctx.font = "9px var(--font-jet), monospace";
  const tw = ctx.measureText(text).width;
  const th = 13;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  let yy = yPos - th / 2;
  yy = Math.max(2, Math.min(yy, ctx.canvas.height / dpr - th - 2));
  if (fillTag) {
    ctx.fillStyle = fg;
    roundRect(ctx, xPos, yy, tw + 8, th, 3);
    ctx.fill();
    ctx.fillStyle = bg;
  } else {
    ctx.fillStyle = fg;
  }
  ctx.textAlign = "left";
  ctx.fillText(text, xPos + 4, yy + th - 4);
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function makeSeedCandles(): Candle[] {
  const now = Date.now();
  return [
    { t: now - 2000, o: 1, h: 1, l: 1, c: 1 },
    { t: now - 1000, o: 1, h: 1, l: 1, c: 1 },
  ];
}

export function EquityChart({
  points,
  baseline,
  target,
}: {
  points: { t: number; eq: number }[];
  baseline: number;
  target: number;
}) {
  const ref = useCanvas((ctx, w, h) => {
    const padR = 74;
    const padL = 10;
    const padT = 14;
    const padB = 20;
    const plotW = w - padR - padL;
    const plotH = h - padT - padB;

    const data = points.length > 1 ? points : [{ t: 0, eq: baseline }, { t: 1, eq: baseline }];
    let lo = Math.min(baseline, ...data.map((p) => p.eq));
    let hi = Math.max(target, ...data.map((p) => p.eq));
    const span = hi - lo || 1;
    lo -= span * 0.08;
    hi += span * 0.08;

    const t0 = data[0].t;
    const t1 = data[data.length - 1].t || t0 + 1;
    const x = (t: number) => padL + ((t - t0) / (t1 - t0 || 1)) * plotW;
    const y = (v: number) => padT + (1 - (v - lo) / (hi - lo)) * plotH;

    ctx.font = "10px var(--font-jet), monospace";
    for (const tick of priceTicks(lo, hi)) {
      const yy = y(tick);
      ctx.strokeStyle = GRID;
      ctx.beginPath();
      ctx.moveTo(padL, yy);
      ctx.lineTo(w - padR, yy);
      ctx.stroke();
      ctx.fillStyle = LABEL;
      ctx.textAlign = "left";
      ctx.fillText(`$${tick.toFixed(0)}`, w - padR + 8, yy + 3);
    }

    // baseline + target lines
    levelLine(ctx, y(baseline), padL, w - padR, "rgba(226,232,240,0.5)", [3, 4], 0.6);
    ctx.fillStyle = "rgba(226,232,240,0.55)";
    ctx.fillText("BASE", w - padR + 8, y(baseline) - 4);
    levelLine(ctx, y(target), padL, w - padR, MINT, [6, 4], 0.75);
    ctx.fillStyle = MINT;
    ctx.fillText("+20%", w - padR + 8, y(target) - 4);

    // equity line + area
    const grad = ctx.createLinearGradient(0, padT, 0, h - padB);
    const profit = data[data.length - 1].eq >= baseline;
    grad.addColorStop(0, profit ? "rgba(52,245,162,0.28)" : "rgba(255,84,112,0.26)");
    grad.addColorStop(1, "rgba(0,0,0,0)");

    ctx.beginPath();
    data.forEach((p, i) => {
      const px = x(p.t);
      const py = y(p.eq);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.strokeStyle = profit ? MINT : ROSE;
    ctx.lineWidth = 1.8;
    ctx.shadowColor = profit ? "rgba(52,245,162,0.5)" : "rgba(255,84,112,0.5)";
    ctx.shadowBlur = 10;
    ctx.stroke();
    ctx.shadowBlur = 0;

    ctx.lineTo(x(t1), h - padB);
    ctx.lineTo(x(t0), h - padB);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // last point glow dot
    const lp = data[data.length - 1];
    ctx.fillStyle = profit ? MINT : ROSE;
    ctx.beginPath();
    ctx.arc(x(lp.t), y(lp.eq), 3, 0, Math.PI * 2);
    ctx.fill();
  });

  return <canvas ref={ref} className="block h-full w-full" />;
}
