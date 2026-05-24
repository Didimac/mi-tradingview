// src/lib/backtest/strategies/pulseScalper1H.ts
//
// ================================================================
// Pulse Scalper 1H
// ================================================================
//
// Scalper intradía para timeframe 1H con filtros de sesión y VWAP.
//
//   - EMA 8/21, RSI 9, ATR 10, VWAP diario
//   - Solo opera en sesiones Asia/Europa/USA (UTC)
//   - VWAP soft bias: coincide => 1% riesgo, no coincide => 0.5% riesgo
//   - Filtro volatilidad: ATR > SMA(ATR,20) × 0.8
//   - SL 1.6×ATR, TP 3.2×ATR (ratio 1:2)
//   - Timeout: 12 velas sin SL/TP => cierre a mercado
//   - Trailing: a 1×ATR avance, SL -> entry ± 0.2×ATR
//   - Riesgo 1% por trade, max 2 trades/par/día, circuit breaker 3%
//
// ================================================================

import type { Candle } from "@/lib/binance/types";

// -----------------------------------------------------------------
// Types & Config
// -----------------------------------------------------------------

export type ScalperSignal = "LONG" | "SHORT" | "NONE";

export interface PulseScalperConfig {
  emaFast: number;        // 8
  emaSlow: number;        // 21
  rsiPeriod: number;      // 9
  atrPeriod: number;      // 10

  // ATR multipliers
  atrSlMult: number;      // 1.6
  atrTpMult: number;      // 3.2

  // Volatility filter
  atrSmaLookback: number; // 20 — lookback for ATR moving average
  atrVolMinMult: number;  // 0.8 — ATR must be > SMA(ATR) × this

  // Trailing
  trailingActivation: number;  // 1.0 (×ATR)
  trailingNewSL: number;       // 0.2 (×ATR offset from entry)

  // Time & risk
  maxBarsInTrade: number;      // 8
  riskPerTrade: number;        // 0.01
  maxTradesPerDay: number;     // 2
  circuitBreakerPct: number;   // 0.03

  // Costs
  commissionPct: number;       // 0.001
  slippagePct: number;         // 0.0005
}

export const DEFAULT_SCALPER_CONFIG: PulseScalperConfig = {
  emaFast: 8,
  emaSlow: 21,
  rsiPeriod: 9,
  atrPeriod: 10,
  atrSlMult: 1.6,
  atrTpMult: 3.2,
  atrSmaLookback: 20,
  atrVolMinMult: 0.8,
  trailingActivation: 1.0,
  trailingNewSL: 0.2,
  maxBarsInTrade: 12,
  riskPerTrade: 0.01,
  maxTradesPerDay: 2,
  circuitBreakerPct: 0.03,
  commissionPct: 0.001,
  slippagePct: 0.0005,
};

// -----------------------------------------------------------------
// Indicators
// -----------------------------------------------------------------

export interface ScalperIndicators {
  emaFast: number[];
  emaSlow: number[];
  rsi: number[];
  atr: number[];
  atrSma: number[];  // SMA of ATR for volatility filter
  vwap: number[];    // daily VWAP
}

function calcEMA(candles: Candle[], period: number): number[] {
  const out = new Array(candles.length).fill(NaN);
  if (candles.length < period) return out;
  const k = 2 / (period + 1);
  let ema = candles.slice(0, period).reduce((s, c) => s + c.close, 0) / period;
  out[period - 1] = ema;
  for (let i = period; i < candles.length; i++) {
    ema = candles[i].close * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

function calcRSI(candles: Candle[], period: number): number[] {
  const out = new Array(candles.length).fill(NaN);
  if (candles.length < period + 1) return out;
  let ag = 0, al = 0;
  for (let i = 1; i <= period; i++) {
    const d = candles[i].close - candles[i - 1].close;
    if (d > 0) ag += d; else al += Math.abs(d);
  }
  ag /= period; al /= period;
  out[period] = 100 - 100 / (1 + (al === 0 ? 100 : ag / al));
  for (let i = period + 1; i < candles.length; i++) {
    const d = candles[i].close - candles[i - 1].close;
    ag = (ag * (period - 1) + Math.max(d, 0)) / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = 100 - 100 / (1 + (al === 0 ? 100 : ag / al));
  }
  return out;
}

function calcATR(candles: Candle[], period: number): number[] {
  const out = new Array(candles.length).fill(NaN);
  if (candles.length < period + 1) return out;
  const trs = candles.slice(1).map((c, i) => Math.max(
    c.high - c.low,
    Math.abs(c.high - candles[i].close),
    Math.abs(c.low - candles[i].close),
  ));
  let atr = trs.slice(0, period).reduce((s, t) => s + t, 0) / period;
  out[period] = atr;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
    out[i + 1] = atr;
  }
  return out;
}

/**
 * Daily VWAP: resets at UTC midnight.
 * VWAP = cumulative(typical_price * volume) / cumulative(volume)
 * typical_price = (high + low + close) / 3
 */
function calcVWAP(candles: Candle[]): number[] {
  const out = new Array(candles.length).fill(NaN);
  let cumPV = 0;
  let cumVol = 0;
  let currentDay = -1;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const d = new Date(c.time * 1000);
    const dayKey = d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();

    if (dayKey !== currentDay) {
      // New day: reset accumulators
      cumPV = 0;
      cumVol = 0;
      currentDay = dayKey;
    }

    const tp = (c.high + c.low + c.close) / 3;
    cumPV += tp * c.volume;
    cumVol += c.volume;
    out[i] = cumVol > 0 ? cumPV / cumVol : tp;
  }
  return out;
}

// -----------------------------------------------------------------
// Precompute all indicators
// -----------------------------------------------------------------

/** Simple moving average of the ATR array */
function calcATRSma(atr: number[], lookback: number): number[] {
  const out = new Array(atr.length).fill(NaN);
  for (let i = lookback - 1; i < atr.length; i++) {
    let sum = 0, count = 0;
    for (let j = i - lookback + 1; j <= i; j++) {
      if (!isNaN(atr[j])) { sum += atr[j]; count++; }
    }
    if (count === lookback) out[i] = sum / count;
  }
  return out;
}

export function precomputeScalper(
  candles: Candle[],
  cfg: PulseScalperConfig = DEFAULT_SCALPER_CONFIG,
): ScalperIndicators {
  const atr = calcATR(candles, cfg.atrPeriod);
  return {
    emaFast: calcEMA(candles, cfg.emaFast),
    emaSlow: calcEMA(candles, cfg.emaSlow),
    rsi: calcRSI(candles, cfg.rsiPeriod),
    atr,
    atrSma: calcATRSma(atr, cfg.atrSmaLookback),
    vwap: calcVWAP(candles),
  };
}

// -----------------------------------------------------------------
// Session filter (UTC hours)
// -----------------------------------------------------------------

function isInSession(unixSec: number): boolean {
  const h = new Date(unixSec * 1000).getUTCHours();
  // Asia:   01:00-08:00
  // Europa: 08:00-16:00
  // USA:    13:00-21:00
  // Combined: 01:00-21:00 (all sessions cover this range)
  return h >= 1 && h < 21;
}

// -----------------------------------------------------------------
// UTC day key helper
// -----------------------------------------------------------------

function utcDayKey(unixSec: number): number {
  const d = new Date(unixSec * 1000);
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

// -----------------------------------------------------------------
// Evaluate signal at closed bar
// -----------------------------------------------------------------

export interface ScalperSignalResult {
  signal: ScalperSignal;
  entry: number;
  sl: number;
  tp: number;
  atr: number;
  reason: string;
  vwapAligned: boolean;  // true = price agrees with VWAP direction
}

export function evaluateBarScalper(
  candles: Candle[],
  ind: ScalperIndicators,
  i: number,
  cfg: PulseScalperConfig = DEFAULT_SCALPER_CONFIG,
): ScalperSignalResult {
  const none: ScalperSignalResult = {
    signal: "NONE", entry: 0, sl: 0, tp: 0, atr: 0, reason: "Sin senal", vwapAligned: false,
  };

  const minI = Math.max(cfg.emaSlow, cfg.rsiPeriod, cfg.atrPeriod) + 2;
  if (i < minI) return { ...none, reason: `Warmup (${i}/${minI})` };

  const ef = ind.emaFast[i];
  const efP = ind.emaFast[i - 1];
  const es = ind.emaSlow[i];
  const esP = ind.emaSlow[i - 1];
  const rsi = ind.rsi[i];
  const rsiP = ind.rsi[i - 1];
  const atr = ind.atr[i];
  const atrSma = ind.atrSma[i];
  const vwap = ind.vwap[i];

  if ([ef, efP, es, esP, rsi, rsiP, atr, vwap].some(isNaN) || atr === 0) {
    return { ...none, reason: "Indicadores no disponibles" };
  }

  const c = candles[i];

  // Session filter
  if (!isInSession(c.time)) {
    return { ...none, reason: "Fuera de sesion" };
  }

  // Volatility filter: ATR must be above its SMA × threshold
  if (!isNaN(atrSma) && atr < atrSma * cfg.atrVolMinMult) {
    return { ...none, reason: "Volatilidad baja (ATR < SMA×0.8)" };
  }

  const slDist = atr * cfg.atrSlMult;
  const tpDist = atr * cfg.atrTpMult;

  // LONG: EMA8 cruza EMA21 arriba + RSI cruza 50 arriba
  if (
    efP <= esP && ef > es &&      // EMA cross up
    rsiP < 50 && rsi >= 50        // RSI crosses 50 up
  ) {
    const aligned = c.close > vwap;
    return {
      signal: "LONG",
      entry: c.close,
      sl: parseFloat((c.close - slDist).toFixed(4)),
      tp: parseFloat((c.close + tpDist).toFixed(4)),
      atr,
      reason: `LONG | EMA8x21 | RSI ${rsiP.toFixed(0)}->${rsi.toFixed(0)} | VWAP ${aligned ? "+" : "-"}`,
      vwapAligned: aligned,
    };
  }

  // SHORT: EMA8 cruza EMA21 abajo + RSI cruza 50 abajo
  if (
    efP >= esP && ef < es &&      // EMA cross down
    rsiP > 50 && rsi <= 50        // RSI crosses 50 down
  ) {
    const aligned = c.close < vwap;
    return {
      signal: "SHORT",
      entry: c.close,
      sl: parseFloat((c.close + slDist).toFixed(4)),
      tp: parseFloat((c.close - tpDist).toFixed(4)),
      atr,
      reason: `SHORT | EMA8x21 | RSI ${rsiP.toFixed(0)}->${rsi.toFixed(0)} | VWAP ${aligned ? "+" : "-"}`,
      vwapAligned: aligned,
    };
  }

  return none;
}

// -----------------------------------------------------------------
// Check exit
// -----------------------------------------------------------------

export interface ScalperOpenPosition {
  direction: "LONG" | "SHORT";
  entryPrice: number;
  sl: number;
  tp: number;
  atrAtEntry: number;
  trailingActivated: boolean;
  entryBarIndex: number;
}

export interface ScalperExitResult {
  shouldExit: boolean;
  exitPrice: number;
  reason: string;
  updatedSL?: number;   // trailing without closing
}

export function checkExitScalper(
  candle: Candle,
  pos: ScalperOpenPosition,
  barIndex: number,
  cfg: PulseScalperConfig = DEFAULT_SCALPER_CONFIG,
): ScalperExitResult {
  const hold: ScalperExitResult = { shouldExit: false, exitPrice: 0, reason: "Mantener" };
  const barsHeld = barIndex - pos.entryBarIndex;

  if (pos.direction === "LONG") {
    // Stop Loss
    if (candle.low <= pos.sl)
      return { shouldExit: true, exitPrice: pos.sl, reason: "SL" };
    // Take Profit
    if (candle.high >= pos.tp)
      return { shouldExit: true, exitPrice: pos.tp, reason: "TP" };
    // Timeout
    if (barsHeld >= cfg.maxBarsInTrade)
      return { shouldExit: true, exitPrice: candle.close, reason: `Timeout ${cfg.maxBarsInTrade} bars` };
    // Trailing
    if (!pos.trailingActivated &&
        candle.close >= pos.entryPrice + pos.atrAtEntry * cfg.trailingActivation) {
      const newSL = parseFloat((pos.entryPrice + pos.atrAtEntry * cfg.trailingNewSL).toFixed(4));
      return { shouldExit: false, exitPrice: 0, reason: `Trail SL -> ${newSL}`, updatedSL: newSL };
    }
  } else {
    // Stop Loss
    if (candle.high >= pos.sl)
      return { shouldExit: true, exitPrice: pos.sl, reason: "SL" };
    // Take Profit
    if (candle.low <= pos.tp)
      return { shouldExit: true, exitPrice: pos.tp, reason: "TP" };
    // Timeout
    if (barsHeld >= cfg.maxBarsInTrade)
      return { shouldExit: true, exitPrice: candle.close, reason: `Timeout ${cfg.maxBarsInTrade} bars` };
    // Trailing
    if (!pos.trailingActivated &&
        candle.close <= pos.entryPrice - pos.atrAtEntry * cfg.trailingActivation) {
      const newSL = parseFloat((pos.entryPrice - pos.atrAtEntry * cfg.trailingNewSL).toFixed(4));
      return { shouldExit: false, exitPrice: 0, reason: `Trail SL -> ${newSL}`, updatedSL: newSL };
    }
  }

  return hold;
}

// -----------------------------------------------------------------
// Position sizing
// -----------------------------------------------------------------

export function calcPositionScalper(
  capital: number,
  entry: number,
  sl: number,
  vwapAligned: boolean = true,
  cfg: PulseScalperConfig = DEFAULT_SCALPER_CONFIG,
): { qty: number; riskAmt: number } {
  // VWAP soft bias: full risk when aligned, half risk when misaligned
  const riskMult = vwapAligned ? 1.0 : 0.5;
  const riskAmt = capital * cfg.riskPerTrade * riskMult;
  const stopDist = Math.abs(entry - sl);
  if (stopDist === 0) return { qty: 0, riskAmt };
  const qty = riskAmt / stopDist;
  return { qty: parseFloat(qty.toFixed(8)), riskAmt: parseFloat(riskAmt.toFixed(2)) };
}

// -----------------------------------------------------------------
// Full standalone backtest runner
// -----------------------------------------------------------------

export interface ScalperTrade {
  side: "long" | "short";
  entry: number;
  exit: number;
  pnl: number;
  pnlPct: number;
  reason: string;
  bars: number;
  trailing: boolean;
}

export interface ScalperBacktestResult {
  totalTrades: number;
  winRate: string;
  profitFactor: string;
  totalReturn: string;
  maxDrawdown: string;
  finalEquity: string;
  trailingUsed: number;
  tradesPerDay: string;
  trades: ScalperTrade[];
}

export function runScalperBacktest(
  candles: Candle[],
  startCap: number = 10000,
  cfg: PulseScalperConfig = DEFAULT_SCALPER_CONFIG,
): ScalperBacktestResult {
  const ind = precomputeScalper(candles, cfg);
  const trades: ScalperTrade[] = [];
  let cash = startCap;
  let peak = cash;

  // Daily tracking
  let currentDayKey = -1;
  let dayTradeCount = 0;
  let dayStartEquity = startCap;

  const minI = Math.max(cfg.emaSlow, cfg.rsiPeriod, cfg.atrPeriod) + 2;

  let pos: {
    side: "long" | "short";
    entry: number;
    sl: number;
    tp: number;
    atr: number;
    idx: number;
    trailing: boolean;
    qty: number;
  } | null = null;

  for (let i = minI; i < candles.length; i++) {
    const cn = candles[i];
    const dayKey = utcDayKey(cn.time);

    // Reset daily counters on new day
    if (dayKey !== currentDayKey) {
      currentDayKey = dayKey;
      dayTradeCount = 0;
      dayStartEquity = cash;
    }

    // Circuit breaker: if day losses exceed threshold, skip
    const dayLossPct = (dayStartEquity - cash) / dayStartEquity;
    const circuitBroken = dayLossPct >= cfg.circuitBreakerPct;

    // Check exit on open position
    if (pos) {
      const openPos: ScalperOpenPosition = {
        direction: pos.side === "long" ? "LONG" : "SHORT",
        entryPrice: pos.entry,
        sl: pos.sl,
        tp: pos.tp,
        atrAtEntry: pos.atr,
        trailingActivated: pos.trailing,
        entryBarIndex: pos.idx,
      };

      const ex = checkExitScalper(cn, openPos, i, cfg);

      if (ex.updatedSL !== undefined && !ex.shouldExit) {
        pos.sl = ex.updatedSL;
        pos.trailing = true;
      } else if (ex.shouldExit) {
        // Apply slippage
        const slipped = pos.side === "long"
          ? ex.exitPrice * (1 - cfg.slippagePct)
          : ex.exitPrice * (1 + cfg.slippagePct);

        const pnlPU = pos.side === "long" ? slipped - pos.entry : pos.entry - slipped;
        const gross = pnlPU * pos.qty;
        const comm = (pos.entry + slipped) * pos.qty * cfg.commissionPct;
        const net = gross - comm;
        cash += net;

        trades.push({
          side: pos.side,
          entry: pos.entry,
          exit: slipped,
          pnl: net,
          pnlPct: (net / (cash - net)) * 100,
          reason: ex.reason,
          bars: i - pos.idx,
          trailing: pos.trailing,
        });

        if (cash > peak) peak = cash;
        pos = null;
      }
    }

    // Evaluate new entry (only if flat + day limits OK)
    if (!pos && !circuitBroken && dayTradeCount < cfg.maxTradesPerDay) {
      const ev = evaluateBarScalper(candles, ind, i, cfg);

      if (ev.signal !== "NONE") {
        const side = ev.signal === "LONG" ? "long" as const : "short" as const;
        const entrySlip = ev.signal === "LONG"
          ? ev.entry * (1 + cfg.slippagePct)
          : ev.entry * (1 - cfg.slippagePct);

        const { qty } = calcPositionScalper(cash, entrySlip, ev.sl, ev.vwapAligned, cfg);
        if (qty <= 0) continue;

        pos = {
          side,
          entry: entrySlip,
          sl: ev.sl,
          tp: ev.tp,
          atr: ev.atr,
          idx: i,
          trailing: false,
          qty,
        };
        dayTradeCount++;
      }
    }
  }

  // Close remaining position
  if (pos) {
    const last = candles[candles.length - 1];
    const pnlPU = pos.side === "long" ? last.close - pos.entry : pos.entry - last.close;
    const net = pnlPU * pos.qty;
    cash += net;
    trades.push({
      side: pos.side, entry: pos.entry, exit: last.close,
      pnl: net, pnlPct: (net / (cash - net)) * 100,
      reason: "EOD", bars: candles.length - 1 - pos.idx, trailing: pos.trailing,
    });
  }

  // Metrics
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const gp = wins.reduce((s, t) => s + t.pnl, 0);
  const gl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  let eq = startCap, eqP = startCap, maxDD = 0;
  for (const t of trades) {
    eq += t.pnl;
    if (eq > eqP) eqP = eq;
    const dd = (eqP - eq) / eqP * 100;
    if (dd > maxDD) maxDD = dd;
  }

  // Trades per day
  const firstTime = candles[minI]?.time ?? candles[0]?.time;
  const lastTime = candles[candles.length - 1]?.time ?? firstTime;
  const totalDays = Math.max(1, (lastTime - firstTime) / 86400);

  return {
    totalTrades: trades.length,
    winRate: trades.length > 0 ? (wins.length / trades.length * 100).toFixed(1) : "0.0",
    profitFactor: gl > 0 ? (gp / gl).toFixed(2) : gp > 0 ? "Inf" : "0.00",
    totalReturn: ((cash - startCap) / startCap * 100).toFixed(2),
    maxDrawdown: maxDD.toFixed(2),
    finalEquity: cash.toFixed(2),
    trailingUsed: trades.filter(t => t.trailing).length,
    tradesPerDay: (trades.length / totalDays).toFixed(2),
    trades,
  };
}
