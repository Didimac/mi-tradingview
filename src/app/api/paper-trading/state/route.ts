/**
 * API: Server-side paper trading state
 *
 * GET  → returns current state (for browser UI)
 * POST → updates settings (autoMode, reset)
 */

import { NextResponse } from "next/server";
import { loadState, saveState } from "@/lib/server/tradingState";

export async function GET() {
  try {
    const state = await loadState();
    return NextResponse.json({
      ok: true,
      capital: state.capital,
      startCapital: state.startCapital,
      position: state.positions[0] ?? null,
      positions: state.positions,
      history: state.history,
      autoMode: state.autoMode,
      lastScanTime: state.lastScanTime,
      lastScanResults: state.lastScanResults,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const state = await loadState();

    // Toggle autoMode
    if (typeof body.autoMode === "boolean") {
      state.autoMode = body.autoMode;
    }

    // Reset
    if (body.reset === true) {
      state.capital = state.startCapital;
      state.position = null;
      state.positions = [];
      state.history = [];
      state.lastSignalTimes = {};
    }

    await saveState(state);
    return NextResponse.json({ ok: true, autoMode: state.autoMode });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
