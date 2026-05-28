/**
 * Debug endpoint: shows raw SmartScorer values for all pairs
 * without early-exit gates. For diagnostics only.
 */

import { NextResponse } from "next/server";
import { fetchKlines } from "@/lib/binance/rest";
import {
  fetchFundingRate,
  scoreFundingRate,
  detectRSIDivergence,
  calcWeeklyVWAP,
  scoreVWAP,
  calcRSI,
  calcATR,
  calcEMA,
} from "@/lib/scoring/smartScorer";
import { calcBtcRegime } from "@/lib/scoring/opportunityScorer";

const PAIRS = ["BTCUSDT", "SOLUSDT", "BNBUSDT"];

export async function GET(req: Request) {
  const url = new URL(req.url);
  const secret = url.searchParams.get("secret");
  if (secret !== process.env.CRON_SECRET && !req.headers.get("x-vercel-cron")) {
    if (process.env.NODE_ENV !== "development") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const results: Record<string, unknown>[] = [];

  // BTC regime
  const btcDaily = await fetchKlines("BTCUSDT", "1d", 210);
  const regime = calcBtcRegime(btcDaily);
  const btcCloses = btcDaily.map((c) => c.close);
  const ema200 = calcEMA(btcCloses, 200);
  const btcLast = btcCloses.length - 1;

  for (const symbol of PAIRS) {
    try {
      const candles = await fetchKlines(symbol, "1h", 100);
      const last = candles.length - 1;
      const price = candles[last].close;
      const closes = candles.map((c) => c.close);

      const rsi = calcRSI(closes);
      const atr = calcATR(candles);
      const ema21 = calcEMA(closes, 21);
      const ema55 = calcEMA(closes, 55);

      const atrVal = atr[last];
      const ema21Val = ema21[last];
      const ema55Val = ema55[last];
      const rsiVal = rsi[last];

      // 1. Funding Rate
      const frValue = await fetchFundingRate(symbol);
      const frComponent = scoreFundingRate(frValue);

      // 2. RSI Divergence
      const divComponent = detectRSIDivergence(candles, rsi, last);

      // 3. Weekly VWAP
      const vwap = calcWeeklyVWAP(candles, last);
      const vwapComponent = scoreVWAP(price, vwap);

      // Directional check
      const dirs = [frComponent.direction, divComponent.direction, vwapComponent.direction]
        .filter((d) => d !== "NEUTRAL");
      const longCount = dirs.filter((d) => d === "LONG").length;
      const shortCount = dirs.filter((d) => d === "SHORT").length;

      // EMA55 trend
      const trendDirection = price > ema55Val ? "BULLISH" : "BEARISH";

      // Raw score (no gates)
      const rawScore = frComponent.points + divComponent.points + vwapComponent.points;

      // Simulate adjusted score (matching opportunityScorer logic)
      const bestDir = longCount >= shortCount ? "LONG" : "SHORT";
      let frContradiction = false;
      let simScore = rawScore;
      if (frComponent.direction !== "NEUTRAL" && frComponent.direction !== bestDir) {
        simScore -= 15;
        frContradiction = true;
      }
      simScore = Math.max(0, simScore);
      const ema55Penalty = (bestDir === "LONG" && price <= ema55Val) || (bestDir === "SHORT" && price >= ema55Val);
      if (ema55Penalty) simScore = Math.round(simScore * 0.9);
      if (regime === "BEAR" && bestDir === "LONG") simScore = Math.round(simScore * 0.85);

      // Gate analysis
      const gates: string[] = [];
      if (candles.length < 60) gates.push("BLOCKED: candles < 60");
      if (isNaN(atrVal) || atrVal <= 0) gates.push("BLOCKED: ATR invalid");
      if (dirs.length === 0) gates.push("BLOCKED: all indicators NEUTRAL");
      if (Math.max(longCount, shortCount) < 2) gates.push(`BLOCKED: only ${Math.max(longCount, shortCount)} agree (need 2)`);
      if (frContradiction) gates.push("PENALTY: FR contradiction -15pts");
      if (ema55Penalty) gates.push("PENALTY: -10% below EMA55");
      if (regime === "BEAR" && bestDir === "LONG") gates.push("PENALTY: -15% BEAR regime on LONG");
      if (simScore < 70) gates.push(`BELOW THRESHOLD: adjusted score ${simScore} < 70`);
      if (simScore >= 70) gates.push(`✅ SIGNAL ELIGIBLE: adjusted score ${simScore} >= 70`);
      if (gates.length === 0) gates.push("ALL GATES PASSED ✓");

      results.push({
        symbol,
        price,
        candleCount: candles.length,
        regime,
        adjustedScore: simScore,
        rsi: rsiVal ? +rsiVal.toFixed(2) : null,
        atr: atrVal ? +atrVal.toFixed(2) : null,
        ema21: ema21Val ? +ema21Val.toFixed(2) : null,
        ema55: ema55Val ? +ema55Val.toFixed(2) : null,
        trendDirection,
        fundingRate: {
          rawValue: frComponent.value,
          pct: `${(frComponent.value * 100).toFixed(4)}%`,
          points: frComponent.points,
          direction: frComponent.direction,
          note: frComponent.value === 0 ? "⚠️ FR=0 — API probably failed!" : "OK",
        },
        rsiDivergence: {
          type: divComponent.type,
          points: divComponent.points,
          direction: divComponent.direction,
          rsiNow: rsiVal ? +rsiVal.toFixed(2) : null,
        },
        vwapWeekly: {
          vwap: vwapComponent.vwap ? +vwapComponent.vwap.toFixed(2) : null,
          distancePct: `${vwapComponent.distancePct.toFixed(3)}%`,
          points: vwapComponent.points,
          direction: vwapComponent.direction,
          note: Math.abs(vwapComponent.distancePct) < 0.5
            ? "⚠️ Too close to VWAP (< 0.5%)"
            : `${Math.abs(vwapComponent.distancePct).toFixed(2)}% from VWAP`,
        },
        rawScore,
        directionalAgreement: {
          directions: [
            `FR: ${frComponent.direction}`,
            `Div: ${divComponent.direction}`,
            `VWAP: ${vwapComponent.direction}`,
          ],
          longCount,
          shortCount,
          neutralCount: 3 - dirs.length,
        },
        gates,
      });
    } catch (e) {
      results.push({ symbol, error: String(e) });
    }
  }

  return NextResponse.json({
    timestamp: new Date().toISOString(),
    regime,
    btcPrice: btcCloses[btcLast],
    btcEma200: ema200[btcLast] ? +ema200[btcLast].toFixed(2) : null,
    pairs: results,
  });
}
