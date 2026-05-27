/**
 * Debug: test funding rate APIs from Vercel servers
 */
import { NextResponse } from "next/server";

export async function GET() {
  const endpoints = [
    { name: "OKX", url: "https://www.okx.com/api/v5/public/funding-rate?instId=BTC-USDT-SWAP" },
    { name: "Bitget", url: "https://api.bitget.com/api/v2/mix/market/current-fund-rate?symbol=BTCUSDT&productType=USDT-FUTURES" },
    { name: "Gate.io", url: "https://api.gateio.ws/api/v4/futures/usdt/contracts/BTC_USDT" },
    { name: "Bybit", url: "https://api.bybit.com/v5/market/tickers?category=linear&symbol=BTCUSDT" },
    { name: "Binance Futures", url: "https://fapi.binance.com/fapi/v1/fundingRate?symbol=BTCUSDT&limit=1" },
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
        body: text.slice(0, 300),
        works: res.ok,
      });
    } catch (e) {
      results.push({ name: ep.name, status: "ERROR", error: String(e), works: false });
    }
  }

  return NextResponse.json({ region: process.env.VERCEL_REGION || "unknown", results });
}
