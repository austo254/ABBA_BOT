/**
 * ABBA · Position reconciliation
 *
 * On startup (and periodically) the live engine must treat the broker as
 * the source of truth. DB open trades that no longer exist at the broker
 * are closed from deal history; broker positions missing from the DB are
 * imported so a restart never opens a duplicate.
 */

import { db } from "@/db";
import { trades, events } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import type { EngineState } from "@/lib/engine-state";
import type { OpenTrade, TradeSide, SetupType } from "@/lib/types";
import type { SymbolCode } from "@/lib/market";
import {
  getPositions,
  getDeals,
  type BridgePosition,
  type BridgeDeal,
} from "./mt5-client";

export interface ReconcileReport {
  closedFromBroker: number;
  importedFromBroker: number;
  matched: number;
  orphansClosed: number;
  details: string[];
}

function ticketOf(t: OpenTrade): number | undefined {
  // live trades store the broker ticket in the DB row; we keep it on the
  // in-memory OpenTrade via a side channel (see openTrade live path).
  return (t as OpenTrade & { brokerTicket?: number }).brokerTicket;
}

export async function reconcilePositions(state: EngineState): Promise<ReconcileReport> {
  const report: ReconcileReport = {
    closedFromBroker: 0,
    importedFromBroker: 0,
    matched: 0,
    orphansClosed: 0,
    details: [],
  };

  let brokerPos: BridgePosition[] = [];
  try {
    brokerPos = await getPositions({ magicOnly: true });
  } catch (err) {
    report.details.push(`positions fetch failed: ${err instanceof Error ? err.message : err}`);
    return report;
  }

  const brokerByTicket = new Map(brokerPos.map((p) => [p.ticket, p]));

  // 1) DB open trades → still on broker?
  const stillOpen: OpenTrade[] = [];
  for (const t of state.openTrades) {
    const ticket = ticketOf(t);
    if (ticket != null && brokerByTicket.has(ticket)) {
      // sync SL/TP/qty from broker (broker is authoritative)
      const bp = brokerByTicket.get(ticket)!;
      t.sl = bp.sl || t.sl;
      t.tp = bp.tp || t.tp;
      t.qty = bp.volume;
      stillOpen.push(t);
      brokerByTicket.delete(ticket);
      report.matched += 1;
      continue;
    }

    // No matching broker position → it was closed while we were down.
    // Try to recover exit from deal history.
    let exitPrice = t.entry;
    let pnl = 0;
    let closedAt = Date.now();
    if (ticket != null) {
      try {
        const deals = await getDeals({
          fromMs: t.openedSim - 60_000,
          toMs: Date.now() + 60_000,
          magicOnly: true,
        });
        const outs = deals.filter(
          (d: BridgeDeal) => d.position_id === ticket && d.entry === 1,
        );
        if (outs.length) {
          const last = outs[outs.length - 1];
          exitPrice = last.price;
          pnl = outs.reduce((s, d) => s + d.profit + d.commission + d.swap, 0);
          closedAt = last.time_msc;
        }
      } catch {
        /* best-effort */
      }
    }

    await db
      .update(trades)
      .set({
        status: "closed",
        exitPrice,
        slFinal: t.sl,
        pnl: Math.round(pnl * 100) / 100,
        exitReason: "Reconciled — closed at broker while offline",
        closedSim: closedAt,
      })
      .where(eq(trades.id, t.id));

    state.account = Math.round((state.account + pnl) * 100) / 100;
    report.closedFromBroker += 1;
    report.details.push(`closed DB#${t.id} ticket=${ticket ?? "?"} pnl=${pnl.toFixed(2)}`);
  }
  state.openTrades = stillOpen;

  // 2) Remaining broker positions → import into DB (orphan recovery)
  for (const bp of brokerByTicket.values()) {
    const symbol = bp.symbol as SymbolCode;
    const side = bp.side as TradeSide;
    const sessionKey = state.sessions.find((s) => s.status === "trading")?.key ?? `orphan|${state.dayKey}`;
    const sessionName = state.sessions.find((s) => s.key === sessionKey)?.name ?? "London";

    const inserted = await db
      .insert(trades)
      .values({
        sessionKey,
        session: sessionName,
        symbol,
        side,
        qty: bp.volume,
        entryPrice: bp.price_open,
        sl: bp.sl,
        tp: bp.tp,
        slFinal: bp.sl,
        riskPct: 0,
        status: "open",
        setup: "Reconciled",
        openedSim: bp.time_msc,
      })
      .returning({ id: trades.id });

    const id = inserted[0]?.id ?? -1;
    const ot: OpenTrade & { brokerTicket?: number } = {
      id,
      sessionKey,
      session: sessionName as OpenTrade["session"],
      symbol,
      side,
      qty: bp.volume,
      entry: bp.price_open,
      sl: bp.sl,
      slInit: bp.sl,
      tp: bp.tp,
      riskPct: 0,
      setup: "Reconciled" as SetupType,
      openedSim: bp.time_msc,
      beDone: false,
      brokerTicket: bp.ticket,
    };
    state.openTrades.push(ot);
    report.importedFromBroker += 1;
    report.details.push(`imported ticket=${bp.ticket} ${side} ${bp.volume} ${symbol}`);
  }

  if (report.closedFromBroker || report.importedFromBroker) {
    await db.insert(events).values({
      simTime: Date.now(),
      type: "reconcile",
      level: "warn",
      message: `Reconcile: matched=${report.matched} closed=${report.closedFromBroker} imported=${report.importedFromBroker}`,
    });
  }

  return report;
}

/**
 * Mark any DB rows still "open" that are not in state.openTrades as closed
 * (safety net after a partial reconcile failure).
 */
export async function closeOrphanDbTrades(state: EngineState): Promise<number> {
  const openIds = new Set(state.openTrades.map((t) => t.id));
  const rows = await db.select().from(trades).where(eq(trades.status, "open"));
  let n = 0;
  for (const row of rows) {
    if (openIds.has(row.id)) continue;
    await db
      .update(trades)
      .set({
        status: "closed",
        exitReason: "Orphan DB row closed on reconcile",
        closedSim: Date.now(),
      })
      .where(and(eq(trades.id, row.id), eq(trades.status, "open")));
    n += 1;
  }
  return n;
}
