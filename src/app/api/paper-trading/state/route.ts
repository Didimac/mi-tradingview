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

    // Sync a client-opened position to server
    if (body.syncPosition) {
      const p = body.syncPosition;
      if (state.positions.length < 3 && !state.positions.some((x: { symbol: string }) => x.symbol === p.symbol)) {
        state.positions.push(p);
        state.position = state.positions[0] ?? null;
      }
    }

    // Close a specific position at market price
    if (body.closePosition) {
      const { positionId, exitPrice } = body.closePosition;
      const pos = state.positions.find((p: { id: string }) => p.id === positionId);
      if (pos) {
        const pnlPerUnit = pos.side === "long"
          ? exitPrice - pos.entryPrice
          : pos.entryPrice - exitPrice;
        const pnl = pnlPerUnit * pos.qty;
        const pnlPct = (pnl / state.capital) * 100;
        state.history.push({
          id: pos.id, symbol: pos.symbol, side: pos.side,
          entryPrice: pos.entryPrice, exitPrice, qty: pos.qty,
          pnl, pnlPct, entryTime: pos.entryTime, exitTime: Date.now(),
          reason: pos.reason, exitReason: "Cierre manual",
        });
        state.capital += pnl;
        state.positions = state.positions.filter((p: { id: string }) => p.id !== positionId);
        state.position = state.positions[0] ?? null;
      }
    }

    // Reload capital to initial amount (keep history)
    if (body.reloadCapital === true) {
      state.capital = state.startCapital;
    }

    // Reset (full — clears everything)
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
