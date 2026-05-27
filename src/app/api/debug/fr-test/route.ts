/**
 * Debug: test funding rate API from Vercel servers
 */
import { NextResponse } from "next/server";

export async function GET() {
  const endpoints = [
    { name: "Bybit (BTCUSDT)", url: "https://api.bybit.com/v5/market/tickers?category=linear&symbol=BTCUSDT" },
    { name: "Bybit (SOLUSDT)", url: "https://api.bybit.com/v5/market/tickers?category=linear&symbol=SOLUSDT" },
    { name: "Bybit (BNBUSDT)", url: "https://api.bybit.com/v5/market/tickers?category=linear&symbol=BNBUSDT" },
    { name: "fapi.binance.com", url: "https://fapi.binance.com/fapi/v1/fundingRate?symbol=BTCUSDT&limit=1" },
  ];

  const results = [];
  for (const ep of endpoints) {
    try {
      const start = Date.now();
      const res = await fetch(ep.url, { cache: "no-store" });
      const elapsed = Date.now() - start;
      const text = await res.text();
      results.push({
        name: ep.name,
        status: res.status,
        elapsed: `${elapsed}ms`,
        body: text.slice(0, 200),
      });
    } catch (e) {
      results.push({ name: ep.name, status: "ERROR", error: String(e) });
    }
  }

  return NextResponse.json({ region: process.env.VERCEL_REGION || "unknown", results });
}
