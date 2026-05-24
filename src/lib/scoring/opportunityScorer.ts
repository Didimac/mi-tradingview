import type { Candle } from "@/lib/binance/types";

export interface ScoreComponents {
  ema: number;
  rsi: number;
  volume: number;
  atr: number;
}

export type BtcRegime = "BULL" | "BEAR";

export interface OpportunityScore {
  symbol: string;
  score: number;
  score1H: number;
  score4H: number;
  direction: "LONG" | "SHORT" | "NEUTRAL";
  components: ScoreComponents;
  reason: string;
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
}

// ─── Indicator helpers ───

function calcEMA(closes: number[], period: number): number[] {
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

function calcRSI(closes: number[], period: number): number {
  if (closes.length < period + 1) return NaN;
  let ag = 0;
  let al = 0;
  const start = closes.length - period - 1;
  for (let i = start + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) ag += d;
    else al += Math.abs(d);
  }
  ag /= period;
  al /= period;
  if (al === 0) return 100;
  return 100 - 100 / (1 + ag / al);
}

function calcATR(candles: Candle[], period: number): number[] {
  const out = new Array(candles.length).fill(NaN);
  if (candles.length < period + 1) return out;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    trs.push(
      Math.max(
        candles[i].high - candles[i].low,
        Math.abs(candles[i].high - candles[i - 1].close),
        Math.abs(candles[i].low - candles[i - 1].close),
      ),
    );
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

// ─── Single-timeframe raw score (0-100) ───

interface RawScore {
  score: number;
  direction: "LONG" | "SHORT" | "NEUTRAL";
  components: ScoreComponents;
  reason: string;
  atrValue: number;
  entry: number;
}

function scoreCandles(candles: Candle[]): RawScore {
  const zero: RawScore = {
    score: 0,
    direction: "NEUTRAL",
    components: { ema: 0, rsi: 0, volume: 0, atr: 0 },
    reason: "Datos insuficientes",
    atrValue: 0,
    entry: 0,
  };
  if (candles.length < 60) return zero;

  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const last = candles.length - 1;

  const ema21 = calcEMA(closes, 21);
  const ema55 = calcEMA(closes, 55);
  const ema21v = ema21[last];
  const ema55v = ema55[last];
  if (isNaN(ema21v) || isNaN(ema55v)) return zero;

  const isLong = ema21v > ema55v;
  const direction: "LONG" | "SHORT" = isLong ? "LONG" : "SHORT";

  const emaSep = (Math.abs(ema21v - ema55v) / ema55v) * 100;
  const emaScore = emaSep > 0.1 ? 25 : 0;

  const rsi = calcRSI(closes, 14);
  const rsiScore = !isNaN(rsi) && rsi >= 45 && rsi <= 65 ? 25 : 0;

  let volScore = 0;
  if (volumes.length >= 20) {
    const volAvg = volumes.slice(-20).reduce((s, v) => s + v, 0) / 20;
    if (volumes[last] > volAvg * 1.3) volScore = 25;
  }

  let atrScore = 0;
  const atrArr = calcATR(candles, 14);
  const atrCurrent = atrArr[last];
  if (!isNaN(atrCurrent)) {
    const atrValues = atrArr.filter((v) => !isNaN(v));
    if (atrValues.length >= 20) {
      const atrAvg = atrValues.slice(-20).reduce((s, v) => s + v, 0) / 20;
      if (atrCurrent > atrAvg * 0.8) atrScore = 25;
    }
  }

  const score = emaScore + rsiScore + volScore + atrScore;
  const parts: string[] = [];
  if (emaScore > 0) parts.push(`EMA21${isLong ? ">" : "<"}EMA55`);
  if (rsiScore > 0) parts.push(`RSI ${rsi.toFixed(0)}`);
  if (volScore > 0) parts.push("Vol alto");
  if (atrScore > 0) parts.push("ATR activo");

  return {
    score,
    direction: score >= 25 ? direction : "NEUTRAL",
    components: { ema: emaScore, rsi: rsiScore, volume: volScore, atr: atrScore },
    reason: parts.length > 0 ? parts.join(" | ") : "Sin senales",
    atrValue: isNaN(atrCurrent) ? 0 : atrCurrent,
    entry: closes[last],
  };
}

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

// ─── Module 5: Dual timeframe scoring ───

export function scoreOpportunityDual(
  symbol: string,
  candles1H: Candle[],
  candles4H: Candle[],
  regime: BtcRegime,
  capital: number,
): OpportunityScore {
  const raw1H = scoreCandles(candles1H);
  const raw4H = scoreCandles(candles4H);

  const scoreFinal = Math.round(raw1H.score * 0.4 + raw4H.score * 0.6);

  // Use 1H for entry/direction (more responsive)
  const dir = raw1H.direction !== "NEUTRAL" ? raw1H.direction : raw4H.direction;
  const entry = raw1H.entry || raw4H.entry;
  const atrValue = raw1H.atrValue || raw4H.atrValue;

  // Module 4: penalize LONG in BEAR regime
  let adjustedScore = scoreFinal;
  if (regime === "BEAR" && dir === "LONG") {
    adjustedScore = Math.round(scoreFinal * 0.7);
  }

  // Module 1: SL/TP from ATR
  let stopLoss = 0;
  let takeProfit1 = 0;
  let takeProfit2 = 0;
  if (atrValue > 0 && entry > 0) {
    if (dir === "LONG") {
      stopLoss = entry - 1.8 * atrValue;
      takeProfit1 = entry + 1.8 * atrValue;
      takeProfit2 = entry + 3.6 * atrValue;
    } else {
      stopLoss = entry + 1.8 * atrValue;
      takeProfit1 = entry - 1.8 * atrValue;
      takeProfit2 = entry - 3.6 * atrValue;
    }
  }

  // Module 2: Lotaje
  const riskAmount = capital * 0.015;
  const slDist = Math.abs(entry - stopLoss);
  const qty = slDist > 0 ? riskAmount / slDist : 0;
  const positionUSDT = qty * entry;

  const combinedReason = [raw1H.reason, raw4H.reason !== raw1H.reason ? `4H: ${raw4H.reason}` : ""].filter(Boolean).join(" | ");

  return {
    symbol,
    score: adjustedScore,
    score1H: raw1H.score,
    score4H: raw4H.score,
    direction: adjustedScore >= 25 ? dir : "NEUTRAL",
    components: raw1H.components,
    reason: combinedReason,
    entry,
    stopLoss,
    takeProfit1,
    takeProfit2,
    atrValue,
    qty,
    positionUSDT,
    regime,
  };
}

// ─── Alert eligibility (Module 3+5 combined) ───

export function isAlertEligible(s: OpportunityScore): boolean {
  return s.score >= 70 && s.score1H >= 50 && s.score4H >= 50;
}
