// src/lib/backtest/strategies/twoPhaseScorer.ts
//
// Two-Phase Scorer Backtest (2 years 1H)
//
// Replicates the live two-phase alert system over historical data:
//   Phase 1: Detect opportunity (score >= 70)
//   Phase 2: Wait for price to reach ideal entry zone
//   Trade management: SL, TP1 (50% close + BE), TP2, timeout 48h
//
// Multi-pair with compounding capital, max 3 simultaneous positions.

import type { Candle } from "@/lib/binance/types";

// ─── Config ───

export interface TwoPhaseConfig {
  scoreThreshold: number;       // 70
  scoreCancelThreshold: number; // 60
  riskPerTrade: number;         // 0.015 (1.5%)
  maxOpenPositions: number;     // 3
  expiryBars: number;           // 2 (2 hours at 1H)
  timeoutBars: number;          // 48 (48 hours)
  idealZoneTolerance: number;   // 0.001 (0.1%)
  cooldownBars: number;         // 2 (2h anti-spam per pair)
  // ATR multipliers (match live system)
  atrSlMult: number;            // 1.8
  atrTp1Mult: number;           // 1.8
  atrTp2Mult: number;           // 3.6
  // EMA periods (match scorer)
  emaFast: number;              // 21
  emaSlow: number;              // 55
  rsiPeriod: number;            // 14
  atrPeriod: number;            // 14
}

export const DEFAULT_TWO_PHASE_CONFIG: TwoPhaseConfig = {
  scoreThreshold: 70,
  scoreCancelThreshold: 60,
  riskPerTrade: 0.015,
  maxOpenPositions: 3,
  expiryBars: 2,
  timeoutBars: 48,
  idealZoneTolerance: 0.001,
  cooldownBars: 2,
  atrSlMult: 1.8,
  atrTp1Mult: 1.8,
  atrTp2Mult: 3.6,
  emaFast: 21,
  emaSlow: 55,
  rsiPeriod: 14,
  atrPeriod: 14,
};

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

function calcRSI(closes: number[], period: number): number[] {
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

function calcATR(candles: Candle[], period: number): number[] {
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

// ─── Precompute indicators for a single pair ───

export interface TwoPhaseIndicators {
  ema21: number[];
  ema55: number[];
  rsi14: number[];
  atr14: number[];
  volSma20: number[];
}

export function precomputeTwoPhase(candles: Candle[], cfg: TwoPhaseConfig): TwoPhaseIndicators {
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);

  const ema21 = calcEMA(closes, cfg.emaFast);
  const ema55 = calcEMA(closes, cfg.emaSlow);
  const rsi14 = calcRSI(closes, cfg.rsiPeriod);
  const atr14 = calcATR(candles, cfg.atrPeriod);

  // Volume SMA 20
  const volSma20 = new Array(candles.length).fill(NaN);
  for (let i = 19; i < volumes.length; i++) {
    let sum = 0;
    for (let j = i - 19; j <= i; j++) sum += volumes[j];
    volSma20[i] = sum / 20;
  }

  return { ema21, ema55, rsi14, atr14, volSma20 };
}

// ─── Score a single bar (same logic as opportunityScorer) ───

interface BarScore {
  score: number;
  direction: "LONG" | "SHORT" | "NEUTRAL";
  ema21Value: number;
  atrValue: number;
}

function scoreBar(
  candles: Candle[],
  ind: TwoPhaseIndicators,
  i: number,
  _cfg: TwoPhaseConfig,
): BarScore {
  const zero: BarScore = { score: 0, direction: "NEUTRAL", ema21Value: 0, atrValue: 0 };

  const ema21v = ind.ema21[i];
  const ema55v = ind.ema55[i];
  if (isNaN(ema21v) || isNaN(ema55v)) return zero;

  const isLong = ema21v > ema55v;
  const dir: "LONG" | "SHORT" = isLong ? "LONG" : "SHORT";

  // EMA separation score (25 pts)
  const emaSep = (Math.abs(ema21v - ema55v) / ema55v) * 100;
  const emaScore = emaSep > 0.1 ? 25 : 0;

  // RSI score (25 pts)
  const rsiVal = ind.rsi14[i];
  const rsiScore = !isNaN(rsiVal) && rsiVal >= 45 && rsiVal <= 65 ? 25 : 0;

  // Volume score (25 pts)
  let volScore = 0;
  const vol = candles[i].volume;
  const volAvg = ind.volSma20[i];
  if (!isNaN(volAvg) && vol > volAvg * 1.3) volScore = 25;

  // ATR score (25 pts)
  let atrScore = 0;
  const atrCurrent = ind.atr14[i];
  if (!isNaN(atrCurrent) && i >= 34) {
    // ATR SMA over last 20 values
    let atrSum = 0, atrCount = 0;
    for (let j = Math.max(0, i - 19); j <= i; j++) {
      if (!isNaN(ind.atr14[j])) { atrSum += ind.atr14[j]; atrCount++; }
    }
    if (atrCount >= 10) {
      const atrAvg = atrSum / atrCount;
      if (atrCurrent > atrAvg * 0.8) atrScore = 25;
    }
  }

  const score = emaScore + rsiScore + volScore + atrScore;

  return {
    score: score >= 25 ? score : 0,
    direction: score >= 25 ? dir : "NEUTRAL",
    ema21Value: ema21v,
    atrValue: isNaN(atrCurrent) ? 0 : atrCurrent,
  };
}

// ─── Entry zone calculation ───

export interface EntryZoneResult {
  ideal: number;
  latest: number;
  type: "pullback" | "momentum" | "late";
}

function calcEntryZone(
  price: number,
  ema21: number,
  atr: number,
  direction: "LONG" | "SHORT",
): EntryZoneResult {
  const dist = Math.abs(price - ema21);

  if (dist <= 0.3 * atr) {
    return { ideal: ema21, latest: price, type: "pullback" };
  } else if (dist <= 1.0 * atr) {
    return { ideal: price, latest: price, type: "momentum" };
  } else {
    // Late entry — latest is the max acceptable price
    const latestPrice = direction === "LONG"
      ? ema21 + 1.0 * atr
      : ema21 - 1.0 * atr;
    return { ideal: ema21, latest: latestPrice, type: "late" };
  }
}

// ─── Result types ───

export interface TwoPhaseSignal {
  barIndex: number;
  time: number;
  symbol: string;
  score: number;
  direction: "LONG" | "SHORT";
  entryIdeal: number;
  entryLatest: number;
  entryType: string;
  sl: number;
  tp1: number;
  tp2: number;
  outcome: "entered" | "expired" | "escaped" | "cancelled";
  // If entered:
  entryPrice?: number;
  entryBarIndex?: number;
  exitPrice?: number;
  exitBarIndex?: number;
  exitReason?: string;
  pnl?: number;
  pnlPct?: number;
  barsToEntry?: number;
  tp1Hit?: boolean;
}

export interface TwoPhasePerPairResult {
  symbol: string;
  signalsF1: number;
  entriesF2: number;
  pctReachedZone: number;
  tp1Count: number;
  tp2Count: number;
  slCount: number;
  expired: number;
  escaped: number;
  cancelled: number;
  winRate: number;
  profitFactor: number;
  returnPct: number;
  maxDrawdownPct: number;
  signals: TwoPhaseSignal[];
}

export interface TwoPhaseResult {
  perPair: TwoPhasePerPairResult[];
  // Global summary
  totalSignalsF1: number;
  totalEntriesF2: number;
  pctReachedZone: number;
  avgTimeF1toF2Minutes: number;
  winRateGlobal: number;
  profitFactorGlobal: number;
  totalReturnPct: number;
  maxDrawdownPct: number;
  tradesPerWeek: number;
  bestPair: string;
  worstPair: string;
  finalEquity: number;
  startEquity: number;
  // For equity curve
  equityCurve: { time: number; equity: number; drawdown: number }[];
  allSignals: TwoPhaseSignal[];
}

// ─── Main backtest runner ───

export function runTwoPhaseBacktest(
  allCandles: Map<string, Candle[]>,
  cfg: TwoPhaseConfig,
  startEquity: number,
): TwoPhaseResult {
  // Precompute indicators for all pairs
  const indicators = new Map<string, TwoPhaseIndicators>();
  const symbols: string[] = [];

  for (const [symbol, candles] of allCandles) {
    indicators.set(symbol, precomputeTwoPhase(candles, cfg));
    symbols.push(symbol);
  }

  // Find common bar range (all pairs have same length for 1H)
  const firstCandles = allCandles.get(symbols[0])!;
  const totalBars = firstCandles.length;
  const minStart = Math.max(cfg.emaSlow, cfg.atrPeriod + 1, cfg.rsiPeriod + 1, 60);

  // State
  let capital = startEquity;
  let peak = startEquity;

  interface ActiveSignal {
    symbol: string;
    barIndex: number;
    score: number;
    direction: "LONG" | "SHORT";
    entryIdeal: number;
    entryLatest: number;
    entryType: string;
    sl: number;
    tp1: number;
    tp2: number;
    // Tracking
    barsWaiting: number;
  }

  interface OpenPosition {
    symbol: string;
    signalBarIndex: number;
    entryBarIndex: number;
    entryPrice: number;
    direction: "LONG" | "SHORT";
    sl: number;
    tp1: number;
    tp2: number;
    qty: number;
    capitalAtEntry: number;
    tp1Hit: boolean;
    remainingQty: number;
    barsInTrade: number;
  }

  const activeSignals = new Map<string, ActiveSignal>();
  const openPositions = new Map<string, OpenPosition>();
  const lastSignalBar = new Map<string, number>();  // anti-spam
  const allSignals: TwoPhaseSignal[] = [];
  const equityCurve: { time: number; equity: number; drawdown: number }[] = [];

  // Per-pair tracking
  const pairStats = new Map<string, {
    signalsF1: number;
    entriesF2: number;
    tp1: number;
    tp2: number;
    sl: number;
    expired: number;
    escaped: number;
    cancelled: number;
    grossProfit: number;
    grossLoss: number;
    timesToEntry: number[];  // bars
  }>();

  for (const sym of symbols) {
    pairStats.set(sym, {
      signalsF1: 0, entriesF2: 0,
      tp1: 0, tp2: 0, sl: 0,
      expired: 0, escaped: 0, cancelled: 0,
      grossProfit: 0, grossLoss: 0,
      timesToEntry: [],
    });
  }

  // Simulate bar by bar
  for (let i = minStart; i < totalBars; i++) {
    const timeAtBar = firstCandles[i].time;

    // 1. Check open positions for SL/TP/Timeout
    for (const [sym, pos] of openPositions) {
      const candles = allCandles.get(sym)!;
      const c = candles[i];
      const stats = pairStats.get(sym)!;
      pos.barsInTrade++;

      let exitPrice: number | null = null;
      let exitReason = "";

      if (pos.direction === "LONG") {
        // Check SL first
        if (c.low <= pos.sl) {
          exitPrice = pos.sl;
          exitReason = pos.tp1Hit ? "Trailing Stop (BE)" : "Stop Loss";
        }
        // Check TP1 (if not hit yet)
        else if (!pos.tp1Hit && c.high >= pos.tp1) {
          // Close 50%, move SL to breakeven
          const halfPnl = (pos.tp1 - pos.entryPrice) * (pos.qty / 2);
          capital += halfPnl;
          if (halfPnl > 0) stats.grossProfit += halfPnl;
          else stats.grossLoss += Math.abs(halfPnl);

          pos.tp1Hit = true;
          pos.remainingQty = pos.qty / 2;
          pos.sl = pos.entryPrice; // move to breakeven
          stats.tp1++;
        }
        // Check TP2
        else if (pos.tp1Hit && c.high >= pos.tp2) {
          exitPrice = pos.tp2;
          exitReason = "Take Profit 2";
          stats.tp2++;
        }
      } else {
        // SHORT
        if (c.high >= pos.sl) {
          exitPrice = pos.sl;
          exitReason = pos.tp1Hit ? "Trailing Stop (BE)" : "Stop Loss";
        } else if (!pos.tp1Hit && c.low <= pos.tp1) {
          const halfPnl = (pos.entryPrice - pos.tp1) * (pos.qty / 2);
          capital += halfPnl;
          if (halfPnl > 0) stats.grossProfit += halfPnl;
          else stats.grossLoss += Math.abs(halfPnl);

          pos.tp1Hit = true;
          pos.remainingQty = pos.qty / 2;
          pos.sl = pos.entryPrice;
          stats.tp1++;
        } else if (pos.tp1Hit && c.low <= pos.tp2) {
          exitPrice = pos.tp2;
          exitReason = "Take Profit 2";
          stats.tp2++;
        }
      }

      // Timeout
      if (!exitPrice && pos.barsInTrade >= cfg.timeoutBars) {
        exitPrice = c.close;
        exitReason = "Timeout 48h";
      }

      if (exitPrice !== null) {
        const remainQty = pos.remainingQty;
        const pnlPerUnit = pos.direction === "LONG"
          ? exitPrice - pos.entryPrice
          : pos.entryPrice - exitPrice;
        const pnl = pnlPerUnit * remainQty;
        capital += pnl;

        if (pnl > 0) stats.grossProfit += pnl;
        else stats.grossLoss += Math.abs(pnl);

        if (!exitReason.includes("Trailing") && exitReason.includes("Stop")) {
          stats.sl++;
        }

        // Find the matching signal and update it
        const sig = allSignals.find(
          s => s.symbol === sym && s.barIndex === pos.signalBarIndex && s.outcome === "entered"
        );
        if (sig) {
          sig.exitPrice = exitPrice;
          sig.exitBarIndex = i;
          sig.exitReason = exitReason;
          // Total P&L including TP1 partial close
          const totalPnl = pos.tp1Hit
            ? (pos.tp1 - pos.entryPrice) * (pos.qty / 2) * (pos.direction === "LONG" ? 1 : -1) + pnl
            : pnl;
          sig.pnl = totalPnl;
          sig.pnlPct = (totalPnl / pos.capitalAtEntry) * 100;
          sig.tp1Hit = pos.tp1Hit;
        }

        openPositions.delete(sym);
      }
    }

    // 2. Check active Phase 1 signals waiting for entry
    for (const [sym, active] of activeSignals) {
      const candles = allCandles.get(sym)!;
      const c = candles[i];
      const stats = pairStats.get(sym)!;
      const ind = indicators.get(sym)!;
      active.barsWaiting++;

      // Check score cancellation
      const currentScore = scoreBar(candles, ind, i, cfg);
      if (currentScore.score < cfg.scoreCancelThreshold) {
        // Signal cancelled
        activeSignals.delete(sym);
        stats.cancelled++;
        const sig = allSignals.find(
          s => s.symbol === sym && s.barIndex === active.barIndex && s.outcome === "entered"
        );
        if (sig) sig.outcome = "cancelled";
        else {
          allSignals.push({
            barIndex: active.barIndex,
            time: candles[active.barIndex].time,
            symbol: sym,
            score: active.score,
            direction: active.direction,
            entryIdeal: active.entryIdeal,
            entryLatest: active.entryLatest,
            entryType: active.entryType,
            sl: active.sl, tp1: active.tp1, tp2: active.tp2,
            outcome: "cancelled",
          });
        }
        continue;
      }

      // Check price reached ideal zone
      const idealPrice = active.entryIdeal;
      const reachedIdeal = active.direction === "LONG"
        ? c.low <= idealPrice * (1 + cfg.idealZoneTolerance)
        : c.high >= idealPrice * (1 - cfg.idealZoneTolerance);

      if (reachedIdeal && openPositions.size < cfg.maxOpenPositions && !openPositions.has(sym)) {
        // PHASE 2: Enter trade
        const entryPrice = idealPrice;
        const slDist = Math.abs(entryPrice - active.sl);
        const riskAmt = capital * cfg.riskPerTrade;
        const qty = slDist > 0 ? riskAmt / slDist : 0;

        if (qty > 0) {
          openPositions.set(sym, {
            symbol: sym,
            signalBarIndex: active.barIndex,
            entryBarIndex: i,
            entryPrice,
            direction: active.direction,
            sl: active.sl,
            tp1: active.tp1,
            tp2: active.tp2,
            qty,
            capitalAtEntry: capital,
            tp1Hit: false,
            remainingQty: qty,
            barsInTrade: 0,
          });
          stats.entriesF2++;
          stats.timesToEntry.push(active.barsWaiting);

          // Update signal record
          const sig = allSignals.find(
            s => s.symbol === sym && s.barIndex === active.barIndex
          );
          if (sig) {
            sig.outcome = "entered";
            sig.entryPrice = entryPrice;
            sig.entryBarIndex = i;
            sig.barsToEntry = active.barsWaiting;
          }
        }
        activeSignals.delete(sym);
        continue;
      }

      // Check price escaped
      const escaped = active.direction === "LONG"
        ? c.high > active.entryLatest
        : c.low < active.entryLatest;

      if (escaped) {
        activeSignals.delete(sym);
        stats.escaped++;
        const sig = allSignals.find(
          s => s.symbol === sym && s.barIndex === active.barIndex
        );
        if (sig) sig.outcome = "escaped";
        continue;
      }

      // Check expiry
      if (active.barsWaiting >= cfg.expiryBars) {
        activeSignals.delete(sym);
        stats.expired++;
        const sig = allSignals.find(
          s => s.symbol === sym && s.barIndex === active.barIndex
        );
        if (sig) sig.outcome = "expired";
        continue;
      }
    }

    // 3. Scan all pairs for new Phase 1 signals
    for (const sym of symbols) {
      // Skip if already watching or in position
      if (activeSignals.has(sym) || openPositions.has(sym)) continue;

      // Anti-spam cooldown
      const lastBar = lastSignalBar.get(sym) ?? -999;
      if (i - lastBar < cfg.cooldownBars) continue;

      const candles = allCandles.get(sym)!;
      const ind = indicators.get(sym)!;
      const barScore = scoreBar(candles, ind, i, cfg);

      if (barScore.score < cfg.scoreThreshold || barScore.direction === "NEUTRAL") continue;

      const stats = pairStats.get(sym)!;
      const price = candles[i].close;
      const atr = barScore.atrValue;

      if (atr <= 0) continue;

      // Calculate entry zone
      const zone = calcEntryZone(price, barScore.ema21Value, atr, barScore.direction);

      // Late entries get 20% score penalty
      let adjustedScore = barScore.score;
      if (zone.type === "late") adjustedScore = Math.round(adjustedScore * 0.8);
      if (adjustedScore < cfg.scoreThreshold) continue;

      // Calculate SL/TP
      let sl: number, tp1: number, tp2: number;
      if (barScore.direction === "LONG") {
        sl = price - cfg.atrSlMult * atr;
        tp1 = price + cfg.atrTp1Mult * atr;
        tp2 = price + cfg.atrTp2Mult * atr;
      } else {
        sl = price + cfg.atrSlMult * atr;
        tp1 = price - cfg.atrTp1Mult * atr;
        tp2 = price - cfg.atrTp2Mult * atr;
      }

      // Register Phase 1 signal
      stats.signalsF1++;
      lastSignalBar.set(sym, i);

      const signal: TwoPhaseSignal = {
        barIndex: i,
        time: candles[i].time,
        symbol: sym,
        score: adjustedScore,
        direction: barScore.direction,
        entryIdeal: zone.ideal,
        entryLatest: zone.latest,
        entryType: zone.type,
        sl, tp1, tp2,
        outcome: "expired", // default; updated later
      };
      allSignals.push(signal);

      // For momentum entries, price is already in the ideal zone
      if (zone.type === "momentum" && openPositions.size < cfg.maxOpenPositions) {
        // Direct entry at current price
        const slDist = Math.abs(price - sl);
        const riskAmt = capital * cfg.riskPerTrade;
        const qty = slDist > 0 ? riskAmt / slDist : 0;

        if (qty > 0) {
          openPositions.set(sym, {
            symbol: sym,
            signalBarIndex: i,
            entryBarIndex: i,
            entryPrice: price,
            direction: barScore.direction,
            sl, tp1, tp2,
            qty,
            capitalAtEntry: capital,
            tp1Hit: false,
            remainingQty: qty,
            barsInTrade: 0,
          });
          stats.entriesF2++;
          stats.timesToEntry.push(0);
          signal.outcome = "entered";
          signal.entryPrice = price;
          signal.entryBarIndex = i;
          signal.barsToEntry = 0;
        }
      } else if (zone.type !== "momentum") {
        // Register as active signal waiting for pullback
        activeSignals.set(sym, {
          symbol: sym,
          barIndex: i,
          score: adjustedScore,
          direction: barScore.direction,
          entryIdeal: zone.ideal,
          entryLatest: zone.latest,
          entryType: zone.type,
          sl, tp1, tp2,
          barsWaiting: 0,
        });
      }
    }

    // Update equity curve every bar
    if (capital > peak) peak = capital;
    equityCurve.push({
      time: timeAtBar,
      equity: capital,
      drawdown: peak > 0 ? ((peak - capital) / peak) * 100 : 0,
    });
  }

  // Close remaining open positions at market
  for (const [sym, pos] of openPositions) {
    const candles = allCandles.get(sym)!;
    const lastPrice = candles[totalBars - 1].close;
    const pnlPerUnit = pos.direction === "LONG"
      ? lastPrice - pos.entryPrice
      : pos.entryPrice - lastPrice;
    const pnl = pnlPerUnit * pos.remainingQty;
    capital += pnl;

    const stats = pairStats.get(sym)!;
    if (pnl > 0) stats.grossProfit += pnl;
    else stats.grossLoss += Math.abs(pnl);
  }

  // Build per-pair results
  const perPair: TwoPhasePerPairResult[] = [];
  for (const sym of symbols) {
    const stats = pairStats.get(sym)!;
    const pairSignals = allSignals.filter(s => s.symbol === sym);
    const enteredSignals = pairSignals.filter(s => s.outcome === "entered");
    const wins = enteredSignals.filter(s => (s.pnl ?? 0) > 0).length;
    const totalEntered = enteredSignals.length;

    // Per-pair return
    let pairGrossProfit = stats.grossProfit;
    let pairGrossLoss = stats.grossLoss;

    // Per-pair max drawdown (approximate)
    const pairEquity = equityCurve; // simplified — use global

    perPair.push({
      symbol: sym,
      signalsF1: stats.signalsF1,
      entriesF2: stats.entriesF2,
      pctReachedZone: stats.signalsF1 > 0 ? (stats.entriesF2 / stats.signalsF1) * 100 : 0,
      tp1Count: stats.tp1,
      tp2Count: stats.tp2,
      slCount: stats.sl,
      expired: stats.expired,
      escaped: stats.escaped,
      cancelled: stats.cancelled,
      winRate: totalEntered > 0 ? (wins / totalEntered) * 100 : 0,
      profitFactor: pairGrossLoss > 0 ? pairGrossProfit / pairGrossLoss : pairGrossProfit > 0 ? Infinity : 0,
      returnPct: startEquity > 0 ? ((pairGrossProfit - pairGrossLoss) / startEquity) * 100 : 0,
      maxDrawdownPct: 0, // computed globally
      signals: pairSignals,
    });
  }

  // Global stats
  const totalF1 = perPair.reduce((s, p) => s + p.signalsF1, 0);
  const totalF2 = perPair.reduce((s, p) => s + p.entriesF2, 0);
  const allEntered = allSignals.filter(s => s.outcome === "entered");
  const allWins = allEntered.filter(s => (s.pnl ?? 0) > 0).length;

  const totalGrossProfit = perPair.reduce((s, p) => s + (pairStats.get(p.symbol)?.grossProfit ?? 0), 0);
  const totalGrossLoss = perPair.reduce((s, p) => s + (pairStats.get(p.symbol)?.grossLoss ?? 0), 0);

  // Average time F1→F2
  const allTimesToEntry: number[] = [];
  for (const stats of pairStats.values()) {
    allTimesToEntry.push(...stats.timesToEntry);
  }
  const avgBarsToEntry = allTimesToEntry.length > 0
    ? allTimesToEntry.reduce((s, v) => s + v, 0) / allTimesToEntry.length
    : 0;

  // Max drawdown
  let maxDD = 0;
  for (const ep of equityCurve) {
    if (ep.drawdown > maxDD) maxDD = ep.drawdown;
  }

  // Trades per week
  const totalWeeks = totalBars / (24 * 7); // 1H bars
  const tradesPerWeek = totalWeeks > 0 ? totalF2 / totalWeeks : 0;

  // Best/worst pair by net return
  const sorted = [...perPair].sort((a, b) => b.returnPct - a.returnPct);
  const bestPair = sorted[0]?.symbol ?? "";
  const worstPair = sorted[sorted.length - 1]?.symbol ?? "";

  // Thin equity curve for chart (1 point per day = every 24 bars)
  const thinEquity: typeof equityCurve = [];
  for (let i = 0; i < equityCurve.length; i += 24) {
    thinEquity.push(equityCurve[i]);
  }
  if (equityCurve.length > 0 && thinEquity[thinEquity.length - 1] !== equityCurve[equityCurve.length - 1]) {
    thinEquity.push(equityCurve[equityCurve.length - 1]);
  }

  return {
    perPair,
    totalSignalsF1: totalF1,
    totalEntriesF2: totalF2,
    pctReachedZone: totalF1 > 0 ? (totalF2 / totalF1) * 100 : 0,
    avgTimeF1toF2Minutes: avgBarsToEntry * 60, // 1H bars → minutes
    winRateGlobal: allEntered.length > 0 ? (allWins / allEntered.length) * 100 : 0,
    profitFactorGlobal: totalGrossLoss > 0 ? totalGrossProfit / totalGrossLoss : totalGrossProfit > 0 ? Infinity : 0,
    totalReturnPct: ((capital - startEquity) / startEquity) * 100,
    maxDrawdownPct: maxDD,
    tradesPerWeek,
    bestPair: bestPair.replace("USDT", ""),
    worstPair: worstPair.replace("USDT", ""),
    finalEquity: capital,
    startEquity,
    equityCurve: thinEquity,
    allSignals,
  };
}
