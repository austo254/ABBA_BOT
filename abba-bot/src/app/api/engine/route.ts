import { NextResponse } from "next/server";
import { advanceAndSnapshot, controlEngine } from "@/lib/engine";
import type { ControlAction } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const snap = await advanceAndSnapshot();
    return NextResponse.json(snap, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    const message = err instanceof Error ? err.message : "engine error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as ControlAction;
    if (!body || typeof body !== "object" || !("action" in body)) {
      return NextResponse.json({ ok: false, error: "bad action" }, { status: 400 });
    }
    await controlEngine(body);
    const snap = await advanceAndSnapshot();
    return NextResponse.json(snap, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    const message = err instanceof Error ? err.message : "engine error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
