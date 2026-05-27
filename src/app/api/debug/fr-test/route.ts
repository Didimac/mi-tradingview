/**
 * Debug: test funding rate API from Vercel servers
 */
import { NextResponse } from "next/server";

export async function GET() {
  const endpoints = [
    { name: "fapi.binance.com", url: "https://fapi.binance.com/fapi/v1/fundingRate?symbol=BTCUSDT&limit=1" },
    { name: "fapi1.binance.com", url: "https://fapi1.binance.com/fapi/v1/fundingRate?symbol=BTCUSDT&limit=1" },
    { name: "fapi2.binance.com", url: "https://fapi2.binance.com/fapi/v1/fundingRate?symbol=BTCUSDT&limit=1" },
    { name: "fapi3.binance.com", url: "https://fapi3.binance.com/fapi/v1/fundingRate?symbol=BTCUSDT&limit=1" },
    { name: "fapi4.binance.com", url: "https://fapi4.binance.com/fapi/v1/fundingRate?symbol=BTCUSDT&limit=1" },
    { name: "dapi.binance.com", url: "https://dapi.binance.com/dapi/v1/fundingRate?symbol=BTCUSD_PERP&limit=1" },
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
