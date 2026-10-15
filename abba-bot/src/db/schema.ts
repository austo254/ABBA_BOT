import {
  pgTable,
  serial,
  integer,
  real,
  text,
  bigint,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import type { EngineState } from "@/lib/engine-state";

// Every executed scalp: entry, trailing stop lifecycle, exit & P&L
export const trades = pgTable(
  "trades",
  {
    id: serial("id").primaryKey(),
    sessionKey: text("session_key").notNull(),
    session: text("session").notNull(),
    symbol: text("symbol").notNull(),
    side: text("side").notNull(), // long | short
    qty: real("qty").notNull(), // lots
    entryPrice: real("entry_price").notNull(),
    exitPrice: real("exit_price").notNull().default(0),
    sl: real("sl").notNull(), // initial stop loss
    tp: real("tp").notNull(),
    slFinal: real("sl_final").notNull().default(0),
    pnl: real("pnl").notNull().default(0),
    pips: real("pips").notNull().default(0),
    riskPct: real("risk_pct").notNull(),
    status: text("status").notNull().default("open"), // open | closed
    setup: text("setup").notNull(),
    exitReason: text("exit_reason"),
    openedSim: bigint("opened_sim", { mode: "number" }).notNull(),
    closedSim: bigint("closed_sim", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("trades_closed_sim_idx").on(t.closedSim)],
);

// End-of-session report card (P&L, trades, win rate, target flag)
export const sessionLogs = pgTable("session_logs", {
  id: serial("id").primaryKey(),
  key: text("key").notNull().unique(), // `${name}|${simDate}`
  name: text("name").notNull(),
  simDate: text("sim_date").notNull(),
  startEquity: real("start_equity").notNull(),
  endEquity: real("end_equity"),
  targetPct: real("target_pct").notNull(),
  status: text("status").notNull(), // target_hit | closed | stopped
  tradesCount: integer("trades_count").notNull().default(0),
  wins: integer("wins").notNull().default(0),
  losses: integer("losses").notNull().default(0),
  startedSim: bigint("started_sim", { mode: "number" }).notNull(),
  endedSim: bigint("ended_sim", { mode: "number" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// Real-time event / alert feed
export const events = pgTable(
  "events",
  {
    id: serial("id").primaryKey(),
    simTime: bigint("sim_time", { mode: "number" }).notNull(),
    type: text("type").notNull(),
    level: text("level").notNull().default("info"), // info | success | warn | danger
    message: text("message").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("events_id_idx").on(t.id)],
);

// Single-row JSON engine state (id = 1)
export const botState = pgTable("bot_state", {
  id: integer("id").primaryKey(),
  state: jsonb("state").$type<EngineState>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
