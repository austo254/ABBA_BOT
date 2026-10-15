import { NextResponse } from "next/server";
import { workerTick, buildSnapshot } from "@/lib/engine";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Optional HTTP trigger for environments that cannot run a long-lived
 * process (e.g. some serverless hosts). Prefer `scripts/worker.ts`.
 * Protected by WORKER_SECRET when set.
 */
export async function POST(req: Request) {
  const secret = process.env.WORKER_SECRET;
  if (secret) {
    const hdr = req.headers.get("x-worker-secret");
    if (hdr !== secret) {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
  }
  try {
    const state = await workerTick();
    const snap = await buildSnapshot(state);
    return NextResponse.json(snap, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    const message = err instanceof Error ? err.message : "worker error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
