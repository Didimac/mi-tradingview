import type { Candle } from "@/lib/binance/types";

export interface IndicatorPoint {
  time: number;
  value: number;
}

export interface MACDPoint {
  time: number;
  macd: number;
  signal: number;
  histogram: number;
}

// ─── SSL Hybrid types ───

export interface SSLPoint {
  time: number;
  sslUp: number;
  sslDown: number;
  direction: 1 | -1;  // 1 = bullish (blue), -1 = bearish (red)
}

export interface SSLSignal {
  time: number;
  price: number;
  type: "BUY" | "SELL";
}

/**
 * Simple Moving Average
 */
export function sma(candles: Candle[], period: number): IndicatorPoint[] {
  const out: IndicatorPoint[] = [];
  if (candles.length < period) return out;
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    sum += candles[i].close;
    if (i >= period) sum -= candles[i - period].close;
    if (i >= period - 1) out.push({ time: candles[i].time, value: sum / period });
  }
  return out;
}

/**
 * Exponential Moving Average — seeded with SMA of first `period` candles.
 */
export function ema(candles: Candle[], period: number): IndicatorPoint[] {
  const out: IndicatorPoint[] = [];
  if (candles.length < period) return out;
  const k = 2 / (period + 1);
  let prev = 0;
  for (let i = 0; i < period; i++) prev += candles[i].close;
  prev /= period;
  out.push({ time: candles[period - 1].time, value: prev });
  for (let i = period; i < candles.length; i++) {
    prev = candles[i].close * k + prev * (1 - k);
    out.push({ time: candles[i].time, value: prev });
  }
  return out;
}

/**
 * RSI (Wilder) — period typically 14.
 */
export function rsi(candles: Candle[], period = 14): IndicatorPoint[] {
  const out: IndicatorPoint[] = [];
  if (candles.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  gain /= period;
  loss /= period;
  let rs = loss === 0 ? 100 : gain / loss;
  out.push({ time: candles[period].time, value: 100 - 100 / (1 + rs) });
  for (let i = period + 1; i < candles.length; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    const g = diff > 0 ? diff : 0;
    const l = diff < 0 ? -diff : 0;
    gain = (gain * (period - 1) + g) / period;
    loss = (loss * (period - 1) + l) / period;
    rs = loss === 0 ? 100 : gain / loss;
    out.push({ time: candles[i].time, value: 100 - 100 / (1 + rs) });
  }
  return out;
}

/**
 * MACD — fast EMA, slow EMA, signal EMA of the MACD line.
 * Defaults: 12 / 26 / 9.
 */
export function macd(
  candles: Candle[],
  fast = 12,
  slow = 26,
  signal = 9,
): MACDPoint[] {
  if (candles.length < slow + signal) return [];
  const emaFast = ema(candles, fast);
  const emaSlow = ema(candles, slow);
  // align: emaSlow starts later
  const slowStartTime = emaSlow[0].time;
  const fastByTime = new Map(emaFast.map((p) => [p.time, p.value]));
  const macdLine: IndicatorPoint[] = [];
  for (const p of emaSlow) {
    const f = fastByTime.get(p.time);
    if (f !== undefined) macdLine.push({ time: p.time, value: f - p.value });
  }
  // signal = EMA of MACD line. Build synthetic candles for ema()
  const synth: Candle[] = macdLine.map((p) => ({
    time: p.time,
    open: p.value,
    high: p.value,
    low: p.value,
    close: p.value,
    volume: 0,
  }));
  const sig = ema(synth, signal);
  const sigByTime = new Map(sig.map((p) => [p.time, p.value]));
  const out: MACDPoint[] = [];
  for (const p of macdLine) {
    const s = sigByTime.get(p.time);
    if (s === undefined) continue;
    out.push({ time: p.time, macd: p.value, signal: s, histogram: p.value - s });
  }
  void slowStartTime;
  return out;
}

// ═══════════════════════════════════════════════════════════════════
// SSL Hybrid + RSI Primet (Heikin Ashi) — Unified Strategy Indicator
// ═══════════════════════════════════════════════════════════════════

/**
 * Internal SMA over a number array (not candles).
 */
function smaArray(data: number[], period: number): number[] {
  const out: number[] = new Array(data.length).fill(NaN);
  if (data.length < period) return out;
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    sum += data[i];
    if (i >= period) sum -= data[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/**
 * Internal EMA over a number array.
 */
function emaArray(data: number[], period: number): number[] {
  const out: number[] = new Array(data.length).fill(NaN);
  if (data.length < period) return out;
  const k = 2 / (period + 1);
  let prev = 0;
  for (let i = 0; i < period; i++) prev += data[i];
  prev /= period;
  out[period - 1] = prev;
  for (let i = period; i < data.length; i++) {
    prev = data[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/**
 * SSL Hybrid — computes SSL Up/Down lines and directional state.
 *
 * SSL Channel uses SMA on highs and lows. When close crosses above
 * the high SMA → bullish (blue), below low SMA → bearish (red).
 */
export function sslHybrid(
  candles: Candle[],
  baseline = 65,
): SSLPoint[] {
  if (candles.length < baseline) return [];

  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const closes = candles.map((c) => c.close);

  const sslHighBase = smaArray(highs, baseline);
  const sslLowBase = smaArray(lows, baseline);

  const out: SSLPoint[] = [];
  let hlv = 0; // 1 = bull, -1 = bear

  for (let i = 0; i < candles.length; i++) {
    if (isNaN(sslHighBase[i]) || isNaN(sslLowBase[i])) continue;

    if (closes[i] > sslHighBase[i]) hlv = 1;
    else if (closes[i] < sslLowBase[i]) hlv = -1;

    const dir = hlv as 1 | -1;
    const sslDown = dir < 0 ? sslHighBase[i] : sslLowBase[i];
    const sslUp = dir < 0 ? sslLowBase[i] : sslHighBase[i];

    out.push({
      time: candles[i].time,
      sslUp,
      sslDown,
      direction: dir,
    });
  }

  return out;
}

/**
 * RSI Primet — RSI converted to smoothed Heikin Ashi candles.
 * Returns true/false for each bar: true = green (bullish), false = red.
 */
export function rsiPrimet(
  candles: Candle[],
  rsiLen = 35,
  smooth = 5,
): { time: number; isGreen: boolean }[] {
  if (candles.length <= rsiLen + smooth) return [];

  const closes = candles.map((c) => c.close);

  // Step 1: Calculate RSI
  const rsiArr: number[] = new Array(candles.length).fill(NaN);
  let gain = 0, loss = 0;
  for (let i = 1; i <= rsiLen; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= rsiLen;
  loss /= rsiLen;
  rsiArr[rsiLen] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = rsiLen + 1; i < candles.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (rsiLen - 1) + (d > 0 ? d : 0)) / rsiLen;
    loss = (loss * (rsiLen - 1) + (d < 0 ? -d : 0)) / rsiLen;
    rsiArr[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }

  // Step 2: Build HA candles from RSI
  const haClose: number[] = new Array(candles.length).fill(NaN);
  const haOpen: number[] = new Array(candles.length).fill(NaN);

  for (let i = 0; i < candles.length; i++) {
    if (isNaN(rsiArr[i])) continue;
    const rC = rsiArr[i];
    const rO = i > 0 && !isNaN(rsiArr[i - 1]) ? rsiArr[i - 1] : rC;
    const rH = Math.max(rC, rO);
    const rL = Math.min(rC, rO);

    haClose[i] = (rO + rH + rL + rC) / 4;
    haOpen[i] = i > 0 && !isNaN(haOpen[i - 1]) && !isNaN(haClose[i - 1])
      ? (haOpen[i - 1] + haClose[i - 1]) / 2
      : (rO + rC) / 2;
  }

  // Step 3: Smooth with EMA
  const smClose = emaArray(haClose.map((v) => (isNaN(v) ? 0 : v)), smooth);
  const smOpen = emaArray(haOpen.map((v) => (isNaN(v) ? 0 : v)), smooth);

  // Step 4: Green = smoothClose >= smoothOpen
  const out: { time: number; isGreen: boolean }[] = [];
  for (let i = 0; i < candles.length; i++) {
    if (isNaN(smClose[i]) || isNaN(smOpen[i]) || isNaN(rsiArr[i])) continue;
    out.push({
      time: candles[i].time,
      isGreen: smClose[i] >= smOpen[i],
    });
  }

  return out;
}

/**
 * Unified SSL Strategy — combines EMA200 + SSL Hybrid + RSI Primet.
 * Returns BUY/SELL signal markers.
 */
export function sslStrategy(
  candles: Candle[],
  ema200Period = 200,
  sslBaseline = 65,
  rsiLen = 35,
  rsiSmooth = 5,
): SSLSignal[] {
  if (candles.length < Math.max(ema200Period, sslBaseline, rsiLen + rsiSmooth) + 10) {
    return [];
  }

  // 1. EMA 200 trend filter
  const ema200Data = ema(candles, ema200Period);
  const ema200Map = new Map(ema200Data.map((p) => [p.time, p.value]));

  // 2. SSL Hybrid
  const sslData = sslHybrid(candles, sslBaseline);
  const sslMap = new Map(sslData.map((p) => [p.time, p]));

  // 3. RSI Primet
  const rsiData = rsiPrimet(candles, rsiLen, rsiSmooth);
  const rsiMap = new Map(rsiData.map((p) => [p.time, p.isGreen]));

  const signals: SSLSignal[] = [];
  let lastSignalDir = 0; // 1 = BUY, -1 = SELL

  // Track SSL direction changes
  let prevSslDir = 0;
  // Track RSI Primet color changes
  let prevRsiGreen: boolean | null = null;

  // Window: SSL change and RSI change within 3 bars
  let barsSinceSslBull = 999;
  let barsSinceSslBear = 999;
  let barsSinceRsiBull = 999;
  let barsSinceRsiBear = 999;

  for (const candle of candles) {
    const ema200Val = ema200Map.get(candle.time);
    const sslPoint = sslMap.get(candle.time);
    const rsiGreen = rsiMap.get(candle.time);

    if (ema200Val === undefined || !sslPoint || rsiGreen === undefined) {
      prevSslDir = sslPoint?.direction ?? prevSslDir;
      prevRsiGreen = rsiGreen ?? prevRsiGreen;
      continue;
    }

    // Detect SSL direction change
    if (sslPoint.direction === 1 && prevSslDir !== 1) barsSinceSslBull = 0;
    else barsSinceSslBull++;
    if (sslPoint.direction === -1 && prevSslDir !== -1) barsSinceSslBear = 0;
    else barsSinceSslBear++;

    // Detect RSI Primet color change
    if (rsiGreen && prevRsiGreen === false) barsSinceRsiBull = 0;
    else barsSinceRsiBull++;
    if (!rsiGreen && prevRsiGreen === true) barsSinceRsiBear = 0;
    else barsSinceRsiBear++;

    prevSslDir = sslPoint.direction;
    prevRsiGreen = rsiGreen;

    const price = candle.close;
    const priceBull = price > ema200Val;
    const priceBear = price < ema200Val;

    // BUY: price > EMA200 + SSL recently turned blue + RSI Primet recently turned green
    if (priceBull && barsSinceSslBull <= 3 && barsSinceRsiBull <= 3 && rsiGreen && lastSignalDir !== 1) {
      signals.push({ time: candle.time, price: candle.low, type: "BUY" });
      lastSignalDir = 1;
    }

    // SELL: price < EMA200 + SSL recently turned red + RSI Primet recently turned red
    if (priceBear && barsSinceSslBear <= 3 && barsSinceRsiBear <= 3 && !rsiGreen && lastSignalDir !== -1) {
      signals.push({ time: candle.time, price: candle.high, type: "SELL" });
      lastSignalDir = -1;
    }
  }

  return signals;
}
