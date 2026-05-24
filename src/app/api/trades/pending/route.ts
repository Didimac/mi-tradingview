import { NextResponse } from "next/server";
import { getPendingTrades, clearPendingTrades } from "@/lib/trades/pendingStore";

export async function GET() {
  const trades = clearPendingTrades();
  return NextResponse.json({ trades });
}
