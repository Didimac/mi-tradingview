/**
 * OpportunityScorer — SmartScorer v2 Variant A
 *
 * Replaces the old 4-component scorer (EMA/RSI/Vol/ATR) with:
 *   1. Funding Rate (35pts) — crowd positioning via Binance Futures
 *   2. RSI Divergence (35pts) — price vs momentum disagreement
 *   3. VWAP Weekly (30pts) — distance from fair value
 *
 * Variant A rules:
 *   - 2 of 3 indicators must agree on direction
 *   - FR contradiction deducts 15pts but doesn't block
 *   - Threshold: 75
 *   - EMA55 trend filter mandatory
 *
 * Backtested: PF 1.18, DD 12.9%, 103 trades over 2 years on BTC+SOL+BNB
 *
 * Maintains backward-compatible OpportunityScore interface.
 */

import type { Candle } from "@/lib/binance/types";
import {
  fetchFundingRate,
  scoreFundingRate,
  detectRSIDivergence,
  calcWeeklyVWAP,
  scoreVWAP,
  calcRSI,
  calcATR,
  calcEMA,
  calcEntryZone as calcEntryZoneRaw,
  type FundingRateComponent,
  type RSIDivergenceComponent,
  type VWAPComponent,
  type Direction,
} from "./smartScorer";

// ─── Public types (backward compatible) ───

export interface ScoreComponents {
  /** Funding Rate points (0-35) */
  fundingRate: number;
  /** RSI Divergence points (0-35) */
  rsiDivergence: number;
  /** VWAP Weekly points (0-30) */
  vwapWeekly: number;
  /** Legacy fields kept for UI compat */
  ema: number;
  rsi: number;
  volume: number;
  atr: number;
}

export type BtcRegime = "BULL" | "BEAR";

export interface EntryZone {
  ideal: number;
  latest: number;
  type: "Retroceso a EMA21" | "Entrada en momentum" | "Entrada tardia";
}

export interface SmartComponents {
  fundingRate: FundingRateComponent;
  rsiDivergence: RSIDivergenceComponent;
  vwapWeekly: VWAPComponent;
}

export interface OpportunityScore {
  symbol: string;
  score: number;
  score1H: number;
  score4H: number;
  direction: "LONG" | "SHORT" | "NEUTRAL";
  components: ScoreComponents;
  smartComponents: SmartComponents;
  reason: string;
  allAgree: boolean;
  // Module 1 — SL/TP
  entry: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  atrValue: number;
  // Module 2 — Lotaje
  qty: number;
  positionUSDT: number;
  // Module 4 — BTC regime
  regime: BtcRegime;
  // Entry zone
  entryZone: EntryZone;
}

// ─── Constants ───

const SCORE_THRESHOLD = 75;
const ATR_SL_MULT = 1.5;
const ATR_TP1_MULT = 2.25;
const ATR_TP2_MULT = 4.5;
const RISK_PER_TRADE = 0.015;

// ─── Module 4: BTC regime ───

export function calcBtcRegime(btcDailyCandles: Candle[]): BtcRegime {
  if (btcDailyCandles.length < 200) return "BULL";
  const closes = btcDailyCandles.map((c) => c.close);
  const ema200 = calcEMA(closes, 200);
  const last = closes.length - 1;
  const ema200v = ema200[last];
  if (isNaN(ema200v)) return "BULL";
  return closes[last] > ema200v ? "BULL" : "BEAR";
}

// ─── Entry zone mapping ───

function mapEntryZoneType(type: "pullback" | "momentum" | "late"): EntryZone["type"] {
  switch (type) {
    case "pullback": return "Retroceso a EMA21";
    case "momentum": return "Entrada en momentum";
    case "late": return "Entrada tardia";
  }
}

// ─── Main scoring function ───

export async function scoreOpportunityDual(
  symbol: string,
  candles1H: Candle[],
  _candles4H: Candle[], // kept for interface compat, not used in SmartScorer
  regime: BtcRegime,
  capital: number,
): Promise<OpportunityScore> {
  const candles = candles1H;
  if (candles.length < 60) {
    return emptyScore(symbol, regime);
  }

  const last = candles.length - 1;
  const price = candles[last].close;
  const closes = candles.map((c) => c.close);

  // Compute indicators
  const rsi = calcRSI(closes);
  const atr = calcATR(candles);
  const ema21 = calcEMA(closes, 21);
  const ema55 = calcEMA(closes, 55);

  const atrVal = atr[last];
  const ema21Val = ema21[last];
  const ema55Val = ema55[last];

  if (isNaN(atrVal) || isNaN(ema21Val) || isNaN(ema55Val) || atrVal <= 0) {
    return emptyScore(symbol, regime);
  }

  // 1. Funding Rate (async fetch from Binance Futures)
  const frValue = await fetchFundingRate(symbol);
  const frComponent = scoreFundingRate(frValue);

  // 2. RSI Divergence
  const divComponent = detectRSIDivergence(candles, rsi, last);

  // 3. Weekly VWAP
  const vwap = calcWeeklyVWAP(candles, last);
  const vwapComponent = scoreVWAP(price, vwap);

  // Directional agreement (Variant A: 2 of 3 must agree)
  const dirs: Direction[] = [frComponent.direction, divComponent.direction, vwapComponent.direction]
    .filter((d) => d !== "NEUTRAL");
  const longCount = dirs.filter((d) => d === "LONG").length;
  const shortCount = dirs.filter((d) => d === "SHORT").length;

  let finalDir: Direction = "NEUTRAL";
  let agreeCount = 0;
  let allAgree = false;

  if (dirs.length === 0) {
    return emptyScore(symbol, regime);
  } else if (longCount > 0 && shortCount === 0) {
    finalDir = "LONG"; agreeCount = longCount; allAgree = true;
  } else if (shortCount > 0 && longCount === 0) {
    finalDir = "SHORT"; agreeCount = shortCount; allAgree = true;
  } else {
    finalDir = longCount >= shortCount ? "LONG" : "SHORT";
    agreeCount = Math.max(longCount, shortCount);
    allAgree = false;
  }

  // Variant A: need at least 2 agreeing
  if (agreeCount < 2) {
    return emptyScore(symbol, regime);
  }

  // Calculate raw score
  let rawScore = frComponent.points + divComponent.points + vwapComponent.points;

  // Variant A: FR contradiction deducts 15pts but doesn't block
  if (frComponent.direction !== "NEUTRAL" && frComponent.direction !== finalDir) {
    rawScore -= 15;
  }

  const scoreFinal = Math.max(0, rawScore);

  // EMA55 trend filter
  if (finalDir === "LONG" && price <= ema55Val) {
    return emptyScore(symbol, regime);
  }
  if (finalDir === "SHORT" && price >= ema55Val) {
    return emptyScore(symbol, regime);
  }

  // Entry zone
  const rawZone = calcEntryZoneRaw(price, ema21Val, atrVal, finalDir);
  const entryZone: EntryZone = {
    ideal: rawZone.ideal,
    latest: rawZone.latest,
    type: mapEntryZoneType(rawZone.type),
  };

  // Late entry penalty
  let adjustedScore = scoreFinal;
  if (rawZone.type === "late") {
    adjustedScore = Math.round(adjustedScore * 0.8);
  }

  // Module 4: penalize LONG in BEAR regime
  if (regime === "BEAR" && finalDir === "LONG") {
    adjustedScore = Math.round(adjustedScore * 0.7);
  }

  // SL/TP from ATR
  let stopLoss = 0, takeProfit1 = 0, takeProfit2 = 0;
  if (finalDir === "LONG") {
    stopLoss = price - ATR_SL_MULT * atrVal;
    takeProfit1 = price + ATR_TP1_MULT * atrVal;
    takeProfit2 = price + ATR_TP2_MULT * atrVal;
  } else {
    stopLoss = price + ATR_SL_MULT * atrVal;
    takeProfit1 = price - ATR_TP1_MULT * atrVal;
    takeProfit2 = price - ATR_TP2_MULT * atrVal;
  }

  // Position sizing
  const riskAmount = capital * RISK_PER_TRADE;
  const slDist = Math.abs(price - stopLoss);
  const qty = slDist > 0 ? riskAmount / slDist : 0;
  const positionUSDT = qty * price;

  // Build reason string
  const reasons: string[] = [];
  if (frComponent.points > 0) reasons.push(`FR ${(frComponent.value * 100).toFixed(3)}%`);
  if (divComponent.points > 0) reasons.push(`Div ${divComponent.type}`);
  if (vwapComponent.points > 0) reasons.push(`VWAP ${vwapComponent.distancePct.toFixed(2)}%`);

  return {
    symbol,
    score: adjustedScore,
    score1H: adjustedScore, // SmartScorer doesn't split by timeframe
    score4H: adjustedScore,
    direction: adjustedScore >= SCORE_THRESHOLD ? finalDir : "NEUTRAL",
    components: {
      fundingRate: frComponent.points,
      rsiDivergence: divComponent.points,
      vwapWeekly: vwapComponent.points,
      // Legacy fields (mapped from new indicators)
      ema: frComponent.points,
      rsi: divComponent.points,
      volume: vwapComponent.points,
      atr: 0,
    },
    smartComponents: {
      fundingRate: frComponent,
      rsiDivergence: divComponent,
      vwapWeekly: vwapComponent,
    },
    reason: reasons.length > 0 ? reasons.join(" | ") : "Sin senales",
    allAgree,
    entry: price,
    stopLoss,
    takeProfit1,
    takeProfit2,
    atrValue: atrVal,
    qty,
    positionUSDT,
    regime,
    entryZone,
  };
}

// ─── Alert eligibility (SmartScorer v2: score >= 75, all indicators aligned) ───

export function isAlertEligible(s: OpportunityScore): boolean {
  return s.score >= SCORE_THRESHOLD && s.direction !== "NEUTRAL";
}

// ─── Empty score helper ───

function emptyScore(symbol: string, regime: BtcRegime): OpportunityScore {
  return {
    symbol,
    score: 0,
    score1H: 0,
    score4H: 0,
    direction: "NEUTRAL",
    components: { fundingRate: 0, rsiDivergence: 0, vwapWeekly: 0, ema: 0, rsi: 0, volume: 0, atr: 0 },
    smartComponents: {
      fundingRate: { value: 0, points: 0, direction: "NEUTRAL" },
      rsiDivergence: { type: "none", points: 0, direction: "NEUTRAL" },
      vwapWeekly: { vwap: 0, distancePct: 0, points: 0, direction: "NEUTRAL" },
    },
    reason: "Sin senales",
    allAgree: false,
    entry: 0,
    stopLoss: 0,
    takeProfit1: 0,
    takeProfit2: 0,
    atrValue: 0,
    qty: 0,
    positionUSDT: 0,
    regime,
    entryZone: { ideal: 0, latest: 0, type: "Entrada en momentum" },
  };
}
