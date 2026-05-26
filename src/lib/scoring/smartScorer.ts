/**
 * SmartScorer v2 — Opportunity scorer using institutional-grade indicators:
 *   1. Funding Rate (35pts) — crowd positioning via Binance Futures
 *   2. RSI Divergence (35pts) — price vs momentum disagreement
 *   3. VWAP Weekly (30pts) — distance from fair value
 *
 * Total: 100 points max. Signal threshold: 75.
 * All 3 indicators must agree on direction.
 */

import type { Candle } from "@/lib/binance/types";

// ─── Types ───────────────────────────────────────────────

export type Direction = "LONG" | "SHORT" | "NEUTRAL";

export interface FundingRateComponent {
  value: number;       // raw funding rate (e.g. 0.0001 = 0.01%)
  points: number;
  direction: Direction;
}

export interface RSIDivergenceComponent {
  type: "bullish" | "bearish" | "hidden_bullish" | "hidden_bearish" | "none";
  points: number;
  direction: Direction;
}

export interface VWAPComponent {
  vwap: number;
  distancePct: number; // positive = above VWAP, negative = below
  points: number;
  direction: Direction;
}

export interface SmartScoreResult {
  symbol: string;
  direction: Direction;
  scoreFinal: number;
  components: {
    fundingRate: FundingRateComponent;
    rsiDivergence: RSIDivergenceComponent;
    vwapWeekly: VWAPComponent;
  };
  entryZone: { ideal: number; latest: number; type: "pullback" | "momentum" | "late" };
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  positionUSDT: number;
  allAgree: boolean;
  reason: string;
}

// ─── Funding Rate (Indicator 1 — 35pts) ─────────────────

// Use fapi.binance.vision on server (no geo restrictions) and fapi.binance.com on client
const FUNDING_RATE_URL =
  typeof window === "undefined"
    ? "https://fapi.binance.vision/fapi/v1/fundingRate"
    : "https://fapi.binance.com/fapi/v1/fundingRate";

/**
 * Fetch latest funding rates from Binance Futures (public, no API key).
 * Returns the most recent funding rate as a decimal (e.g. 0.0001 = 0.01%).
 */
export async function fetchFundingRate(symbol: string): Promise<number> {
  try {
    const res = await fetch(`${FUNDING_RATE_URL}?symbol=${symbol}&limit=1`);
    if (!res.ok) return 0;
    const data = (await res.json()) as { fundingRate: string }[];
    if (!data.length) return 0;
    return parseFloat(data[0].fundingRate);
  } catch {
    return 0;
  }
}

/**
 * Score the funding rate.
 * FR < -0.0002 → +35 (excess shorts, bounce likely) for LONG
 * FR -0.0002 to +0.0001 → +15 (neutral, acceptable)
 * FR +0.0001 to +0.0005 → 0 (caution)
 * FR > +0.0005 → -20 (overloaded longs, dangerous)
 * For SHORT: inverse logic.
 */
export function scoreFundingRate(fr: number): FundingRateComponent {
  // Determine inherent direction bias from FR
  let direction: Direction = "NEUTRAL";
  if (fr < -0.0001) direction = "LONG";       // negative FR favors longs
  else if (fr > 0.0001) direction = "SHORT";   // positive FR favors shorts

  // Score for LONG perspective
  let longPoints = 0;
  if (fr < -0.0002) longPoints = 35;
  else if (fr < 0.0001) longPoints = 15;
  else if (fr < 0.0005) longPoints = 0;
  else longPoints = -20;

  // Score for SHORT perspective
  let shortPoints = 0;
  if (fr > 0.0005) shortPoints = 35;
  else if (fr > -0.0001) shortPoints = 15;
  else if (fr > -0.0002) shortPoints = 0;
  else shortPoints = -20;

  // Return the best scoring direction
  if (longPoints >= shortPoints) {
    return { value: fr, points: longPoints, direction: longPoints > 0 ? "LONG" : direction };
  }
  return { value: fr, points: shortPoints, direction: shortPoints > 0 ? "SHORT" : direction };
}

// ─── RSI Divergence (Indicator 2 — 35pts) ───────────────

/**
 * Calculate RSI-14 from closing prices.
 */
export function calcRSI(closes: number[], period = 14): number[] {
  const out = new Array(closes.length).fill(NaN);
  if (closes.length < period + 1) return out;
  let ag = 0, al = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) ag += d; else al += Math.abs(d);
  }
  ag /= period;
  al /= period;
  out[period] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + (d > 0 ? d : 0)) / period;
    al = (al * (period - 1) + (d < 0 ? Math.abs(d) : 0)) / period;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}

/**
 * Detect RSI divergence on the last 20 candles.
 * Checks multiple lookback windows (5, 8, 12, 16 bars) for robustness.
 */
export function detectRSIDivergence(
  candles: Candle[],
  rsi: number[],
  currentIndex: number,
): RSIDivergenceComponent {
  const none: RSIDivergenceComponent = { type: "none", points: 0, direction: "NEUTRAL" };
  if (currentIndex < 20) return none;

  const i = currentIndex;
  const lookbacks = [5, 8, 12, 16];

  for (const lb of lookbacks) {
    const j = i - lb;
    if (j < 0 || isNaN(rsi[i]) || isNaN(rsi[j])) continue;

    // Regular bullish divergence: price lower low, RSI higher low → LONG
    if (candles[i].low < candles[j].low && rsi[i] > rsi[j]) {
      return { type: "bullish", points: 35, direction: "LONG" };
    }

    // Regular bearish divergence: price higher high, RSI lower high → SHORT
    if (candles[i].high > candles[j].high && rsi[i] < rsi[j]) {
      return { type: "bearish", points: 35, direction: "SHORT" };
    }
  }

  // Hidden divergences (trend continuation, weaker signal)
  for (const lb of lookbacks) {
    const j = i - lb;
    if (j < 0 || isNaN(rsi[i]) || isNaN(rsi[j])) continue;

    // Hidden bullish: price higher low + RSI lower low → LONG continuation
    if (candles[i].low > candles[j].low && rsi[i] < rsi[j]) {
      return { type: "hidden_bullish", points: 20, direction: "LONG" };
    }

    // Hidden bearish: price lower high + RSI higher high → SHORT continuation
    if (candles[i].high < candles[j].high && rsi[i] > rsi[j]) {
      return { type: "hidden_bearish", points: 20, direction: "SHORT" };
    }
  }

  return none;
}

// ─── VWAP Weekly (Indicator 3 — 30pts) ──────────────────

/**
 * Calculate weekly VWAP from candles.
 * Resets at the start of each UTC week (Monday 00:00).
 */
export function calcWeeklyVWAP(candles: Candle[], currentIndex: number): number {
  if (currentIndex < 0 || currentIndex >= candles.length) return NaN;

  const currentTime = candles[currentIndex].time * 1000;
  const currentDate = new Date(currentTime);
  // Find start of current UTC week (Monday 00:00)
  const dayOfWeek = currentDate.getUTCDay(); // 0=Sun, 1=Mon
  const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const weekStart = new Date(currentDate);
  weekStart.setUTCHours(0, 0, 0, 0);
  weekStart.setUTCDate(weekStart.getUTCDate() - daysSinceMonday);
  const weekStartTs = weekStart.getTime() / 1000;

  let sumPV = 0;
  let sumV = 0;

  for (let k = currentIndex; k >= 0; k--) {
    if (candles[k].time < weekStartTs) break;
    const tp = (candles[k].high + candles[k].low + candles[k].close) / 3;
    sumPV += tp * candles[k].volume;
    sumV += candles[k].volume;
  }

  return sumV > 0 ? sumPV / sumV : candles[currentIndex].close;
}

/**
 * Score distance from weekly VWAP.
 * For LONG: price below VWAP is favorable (buying at value).
 * For SHORT: price above VWAP is favorable.
 */
export function scoreVWAP(price: number, vwap: number): VWAPComponent {
  const distancePct = ((price - vwap) / vwap) * 100;

  // Determine direction bias
  let direction: Direction = "NEUTRAL";
  if (distancePct < -0.5) direction = "LONG";
  else if (distancePct > 0.5) direction = "SHORT";

  // Score for best direction
  const absDist = Math.abs(distancePct);
  let points = 0;
  if (absDist >= 2 && absDist <= 3) points = 30;
  else if (absDist >= 1 && absDist < 2) points = 20;
  else if (absDist >= 0.5 && absDist < 1) points = 10;
  else if (absDist > 3) points = 15; // too far = still some value but less reliable
  else points = 0; // too close to VWAP

  return { vwap, distancePct, points, direction };
}

// ─── ATR helper ─────────────────────────────────────────

export function calcATR(candles: Candle[], period = 14): number[] {
  const out = new Array(candles.length).fill(NaN);
  if (candles.length < period + 1) return out;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    trs.push(Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close),
    ));
  }
  let atr = 0;
  for (let i = 0; i < period; i++) atr += trs[i];
  atr /= period;
  out[period] = atr;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
    out[i + 1] = atr;
  }
  return out;
}

// ─── EMA helper ─────────────────────────────────────────

export function calcEMA(closes: number[], period: number): number[] {
  const out = new Array(closes.length).fill(NaN);
  if (closes.length < period) return out;
  const k = 2 / (period + 1);
  let ema = 0;
  for (let i = 0; i < period; i++) ema += closes[i];
  ema /= period;
  out[period - 1] = ema;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

// ─── Entry Zone ─────────────────────────────────────────

export function calcEntryZone(
  price: number, ema21: number, atr: number, dir: Direction,
): { ideal: number; latest: number; type: "pullback" | "momentum" | "late" } {
  const dist = Math.abs(price - ema21);
  if (dist <= 0.3 * atr) return { ideal: ema21, latest: price, type: "pullback" };
  if (dist <= 1.0 * atr) return { ideal: price, latest: price, type: "momentum" };
  const latestPrice = dir === "LONG" ? ema21 + 1.0 * atr : ema21 - 1.0 * atr;
  return { ideal: ema21, latest: latestPrice, type: "late" };
}

// ─── Main Scorer ────────────────────────────────────────

export interface SmartScorerConfig {
  /** Equity available for position sizing */
  equity: number;
  /** Risk per trade as fraction (0.015 = 1.5%) */
  riskPerTrade: number;
  /** ATR multiplier for stop loss */
  atrSlMult: number;
  /** ATR multiplier for TP1 */
  atrTp1Mult: number;
  /** ATR multiplier for TP2 */
  atrTp2Mult: number;
}

export const DEFAULT_SMART_CONFIG: SmartScorerConfig = {
  equity: 1000,
  riskPerTrade: 0.015,
  atrSlMult: 1.5,
  atrTp1Mult: 2.25,
  atrTp2Mult: 4.5,
};

/**
 * Score a single opportunity using the SmartScorer v2 algorithm.
 * This is the LIVE version that fetches funding rate from the API.
 */
export async function scoreOpportunitySmart(
  symbol: string,
  candles: Candle[],
  config: SmartScorerConfig = DEFAULT_SMART_CONFIG,
): Promise<SmartScoreResult> {
  const i = candles.length - 1;
  const price = candles[i].close;
  const closes = candles.map(c => c.close);

  // Compute indicators
  const rsi = calcRSI(closes);
  const atr = calcATR(candles);
  const ema21 = calcEMA(closes, 21);
  const atrVal = atr[i];
  const ema21Val = ema21[i];

  // 1. Funding Rate
  const frValue = await fetchFundingRate(symbol);
  const frComponent = scoreFundingRate(frValue);

  // 2. RSI Divergence
  const divComponent = detectRSIDivergence(candles, rsi, i);

  // 3. Weekly VWAP
  const vwap = calcWeeklyVWAP(candles, i);
  const vwapComponent = scoreVWAP(price, vwap);

  // Combine scores
  return combineScore(
    symbol, price, ema21Val, atrVal,
    frComponent, divComponent, vwapComponent,
    config,
  );
}

/**
 * Score using pre-computed funding rate (for backtest or when FR is already known).
 */
export function scoreOpportunitySmartSync(
  symbol: string,
  candles: Candle[],
  rsi: number[],
  atr: number[],
  ema21: number[],
  currentIndex: number,
  fundingRate: number,
  config: SmartScorerConfig = DEFAULT_SMART_CONFIG,
): SmartScoreResult {
  const i = currentIndex;
  const price = candles[i].close;
  const atrVal = atr[i];
  const ema21Val = ema21[i];

  const frComponent = scoreFundingRate(fundingRate);
  const divComponent = detectRSIDivergence(candles, rsi, i);
  const vwap = calcWeeklyVWAP(candles, i);
  const vwapComponent = scoreVWAP(price, vwap);

  return combineScore(
    symbol, price, ema21Val, atrVal,
    frComponent, divComponent, vwapComponent,
    config,
  );
}

function combineScore(
  symbol: string,
  price: number,
  ema21Val: number,
  atrVal: number,
  fr: FundingRateComponent,
  div: RSIDivergenceComponent,
  vwap: VWAPComponent,
  config: SmartScorerConfig,
): SmartScoreResult {
  const rawScore = fr.points + div.points + vwap.points;

  // Check directional agreement
  const directions = [fr.direction, div.direction, vwap.direction].filter(d => d !== "NEUTRAL");
  const longCount = directions.filter(d => d === "LONG").length;
  const shortCount = directions.filter(d => d === "SHORT").length;

  let allAgree = false;
  let finalDirection: Direction = "NEUTRAL";

  if (directions.length === 0) {
    finalDirection = "NEUTRAL";
  } else if (longCount > 0 && shortCount === 0) {
    allAgree = true;
    finalDirection = "LONG";
  } else if (shortCount > 0 && longCount === 0) {
    allAgree = true;
    finalDirection = "SHORT";
  } else {
    // Conflicting directions — cap score
    allAgree = false;
    finalDirection = longCount >= shortCount ? "LONG" : "SHORT";
  }

  // If directions conflict, cap score to 60 (won't trigger signal)
  const scoreFinal = allAgree ? Math.max(0, rawScore) : Math.min(60, Math.max(0, rawScore));

  // Entry zone, SL, TP
  const entryZone = !isNaN(ema21Val) && !isNaN(atrVal) && atrVal > 0
    ? calcEntryZone(price, ema21Val, atrVal, finalDirection)
    : { ideal: price, latest: price, type: "momentum" as const };

  let stopLoss = 0, takeProfit1 = 0, takeProfit2 = 0;
  if (!isNaN(atrVal) && atrVal > 0) {
    if (finalDirection === "LONG") {
      stopLoss = price - config.atrSlMult * atrVal;
      takeProfit1 = price + config.atrTp1Mult * atrVal;
      takeProfit2 = price + config.atrTp2Mult * atrVal;
    } else {
      stopLoss = price + config.atrSlMult * atrVal;
      takeProfit1 = price - config.atrTp1Mult * atrVal;
      takeProfit2 = price - config.atrTp2Mult * atrVal;
    }
  }

  const slDist = Math.abs(price - stopLoss);
  const positionUSDT = slDist > 0 ? config.equity * config.riskPerTrade / slDist * price : 0;

  // Build reason string
  const reasons: string[] = [];
  if (fr.points > 0) reasons.push(`FR ${(fr.value * 100).toFixed(4)}% (${fr.points}pts)`);
  if (div.points > 0) reasons.push(`Div ${div.type} (${div.points}pts)`);
  if (vwap.points > 0) reasons.push(`VWAP ${vwap.distancePct.toFixed(2)}% (${vwap.points}pts)`);

  return {
    symbol,
    direction: finalDirection,
    scoreFinal,
    components: {
      fundingRate: fr,
      rsiDivergence: div,
      vwapWeekly: vwap,
    },
    entryZone,
    stopLoss,
    takeProfit1,
    takeProfit2,
    positionUSDT,
    allAgree,
    reason: reasons.length > 0 ? reasons.join(" | ") : "No signal",
  };
}
