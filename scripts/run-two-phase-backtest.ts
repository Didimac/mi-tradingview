/**
 * Two-Phase Scorer Backtest — CLI runner
 * Usage: npx tsx scripts/run-two-phase-backtest.ts
 */

// ─── Types (inline to avoid path alias issues) ───

interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  isFinal?: boolean;
}

// ─── Binance REST (standalone, no Next.js deps) ───

const BASE = "https://api.binance.com/api/v3";

async function fetchKlines(symbol: string, interval: string, limit = 1000): Promise<Candle[]> {
  const url = `${BASE}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`klines ${res.status}`);
  const data = (await res.json()) as unknown[][];
  return data.map((k) => ({
    time: Math.floor((k[0] as number) / 1000),
    open: parseFloat(k[1] as string),
    high: parseFloat(k[2] as string),
    low: parseFloat(k[3] as string),
    close: parseFloat(k[4] as string),
    volume: parseFloat(k[5] as string),
    isFinal: true,
  }));
}

async function fetchKlinesBefore(symbol: string, interval: string, endTimeMs: number, limit = 1000): Promise<Candle[]> {
  const url = `${BASE}/klines?symbol=${symbol}&interval=${interval}&endTime=${endTimeMs - 1}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`klines ${res.status}`);
  const data = (await res.json()) as unknown[][];
  return data.map((k) => ({
    time: Math.floor((k[0] as number) / 1000),
    open: parseFloat(k[1] as string),
    high: parseFloat(k[2] as string),
    low: parseFloat(k[3] as string),
    close: parseFloat(k[4] as string),
    volume: parseFloat(k[5] as string),
    isFinal: true,
  }));
}

async function loadCandles(symbol: string, interval: string, count: number): Promise<Candle[]> {
  let candles = await fetchKlines(symbol, interval, Math.min(count, 1000));
  while (candles.length < count) {
    const oldest = candles[0];
    const batch = await fetchKlinesBefore(symbol, interval, oldest.time * 1000, Math.min(count - candles.length, 1000));
    if (batch.length === 0) break;
    candles = [...batch, ...candles];
    // Rate limit
    await new Promise(r => setTimeout(r, 200));
  }
  const seen = new Set<number>();
  candles = candles.sort((a, b) => a.time - b.time).filter((c) => {
    if (seen.has(c.time)) return false;
    seen.add(c.time);
    return true;
  });
  return candles;
}

// ─── Indicator helpers (same as twoPhaseScorer.ts) ───

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
  ag /= period; al /= period;
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

// ─── Precompute ───

interface Indicators {
  ema21: number[];
  ema55: number[];
  rsi14: number[];
  atr14: number[];
  volSma20: number[];
}

function precompute(candles: Candle[]): Indicators {
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const ema21 = calcEMA(closes, 21);
  const ema55 = calcEMA(closes, 55);
  const rsi14 = calcRSI(closes, 14);
  const atr14 = calcATR(candles, 14);
  const volSma20 = new Array(candles.length).fill(NaN);
  for (let i = 19; i < volumes.length; i++) {
    let sum = 0;
    for (let j = i - 19; j <= i; j++) sum += volumes[j];
    volSma20[i] = sum / 20;
  }
  return { ema21, ema55, rsi14, atr14, volSma20 };
}

// ─── Score a bar ───

interface BarScore {
  score: number;
  direction: "LONG" | "SHORT" | "NEUTRAL";
  ema21Value: number;
  atrValue: number;
}

function scoreBar(candles: Candle[], ind: Indicators, i: number): BarScore {
  const zero: BarScore = { score: 0, direction: "NEUTRAL", ema21Value: 0, atrValue: 0 };
  const ema21v = ind.ema21[i], ema55v = ind.ema55[i];
  if (isNaN(ema21v) || isNaN(ema55v)) return zero;

  const isLong = ema21v > ema55v;
  const dir: "LONG" | "SHORT" = isLong ? "LONG" : "SHORT";

  const emaSep = (Math.abs(ema21v - ema55v) / ema55v) * 100;
  const emaScore = emaSep > 0.1 ? 25 : 0;

  const rsiVal = ind.rsi14[i];
  const rsiScore = !isNaN(rsiVal) && rsiVal >= 45 && rsiVal <= 65 ? 25 : 0;

  let volScore = 0;
  if (!isNaN(ind.volSma20[i]) && candles[i].volume > ind.volSma20[i] * 1.3) volScore = 25;

  let atrScore = 0;
  const atrCurrent = ind.atr14[i];
  if (!isNaN(atrCurrent) && i >= 34) {
    let atrSum = 0, atrCount = 0;
    for (let j = Math.max(0, i - 19); j <= i; j++) {
      if (!isNaN(ind.atr14[j])) { atrSum += ind.atr14[j]; atrCount++; }
    }
    if (atrCount >= 10 && atrCurrent > (atrSum / atrCount) * 0.8) atrScore = 25;
  }

  const score = emaScore + rsiScore + volScore + atrScore;
  return {
    score: score >= 25 ? score : 0,
    direction: score >= 25 ? dir : "NEUTRAL",
    ema21Value: ema21v,
    atrValue: isNaN(atrCurrent) ? 0 : atrCurrent,
  };
}

// ─── Entry zone ───

interface EntryZone { ideal: number; latest: number; type: "pullback" | "momentum" | "late"; }

function calcEntryZone(price: number, ema21: number, atr: number, dir: "LONG" | "SHORT"): EntryZone {
  const dist = Math.abs(price - ema21);
  if (dist <= 0.3 * atr) return { ideal: ema21, latest: price, type: "pullback" };
  if (dist <= 1.0 * atr) return { ideal: price, latest: price, type: "momentum" };
  const latestPrice = dir === "LONG" ? ema21 + 1.0 * atr : ema21 - 1.0 * atr;
  return { ideal: ema21, latest: latestPrice, type: "late" };
}

// ─── Config ───

const CFG = {
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
};

// ─── Main backtest ───

interface ActiveSignal {
  symbol: string; barIndex: number; score: number; direction: "LONG" | "SHORT";
  entryIdeal: number; entryLatest: number; sl: number; tp1: number; tp2: number;
  barsWaiting: number;
}

interface OpenPosition {
  symbol: string; signalBarIndex: number; entryBarIndex: number;
  entryPrice: number; direction: "LONG" | "SHORT";
  sl: number; tp1: number; tp2: number;
  qty: number; capitalAtEntry: number;
  tp1Hit: boolean; remainingQty: number; barsInTrade: number;
}

interface PairStats {
  signalsF1: number; entriesF2: number;
  tp1: number; tp2: number; sl: number; timeout: number;
  expired: number; escaped: number; cancelled: number;
  grossProfit: number; grossLoss: number;
  timesToEntry: number[];
}

const PAIRS = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT",
  "DOGEUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT", "TONUSDT",
];

async function main() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  TWO-PHASE SCORER BACKTEST — 10 pares × 2 años × 1H");
  console.log("═══════════════════════════════════════════════════════════\n");

  // Download data
  const allCandles = new Map<string, Candle[]>();
  const targetCount = 17520; // 2 years of 1H

  for (const sym of PAIRS) {
    process.stdout.write(`  Descargando ${sym}...`);
    const candles = await loadCandles(sym, "1h", targetCount);
    allCandles.set(sym, candles);
    console.log(` ${candles.length} barras (${(candles[0].time * 1000 ? new Date(candles[0].time * 1000).toISOString().slice(0, 10) : "?")} → ${new Date(candles[candles.length - 1].time * 1000).toISOString().slice(0, 10)})`);
  }

  console.log("\n  Ejecutando backtest...\n");

  // Precompute indicators
  const indicators = new Map<string, Indicators>();
  for (const [sym, candles] of allCandles) {
    indicators.set(sym, precompute(candles));
  }

  const firstCandles = allCandles.get(PAIRS[0])!;
  const totalBars = firstCandles.length;
  const minStart = 60;

  let capital = 1000;
  let peak = 1000;
  let maxDD = 0;

  const activeSignals = new Map<string, ActiveSignal>();
  const openPositions = new Map<string, OpenPosition>();
  const lastSignalBar = new Map<string, number>();

  const stats = new Map<string, PairStats>();
  for (const sym of PAIRS) {
    stats.set(sym, {
      signalsF1: 0, entriesF2: 0,
      tp1: 0, tp2: 0, sl: 0, timeout: 0,
      expired: 0, escaped: 0, cancelled: 0,
      grossProfit: 0, grossLoss: 0,
      timesToEntry: [],
    });
  }

  let totalTradesClosed = 0;
  let totalWins = 0;

  for (let i = minStart; i < totalBars; i++) {
    // 1. Check open positions
    for (const [sym, pos] of openPositions) {
      const candles = allCandles.get(sym)!;
      const c = candles[i];
      const st = stats.get(sym)!;
      pos.barsInTrade++;

      let exitPrice: number | null = null;
      let exitReason = "";

      if (pos.direction === "LONG") {
        if (c.low <= pos.sl) {
          exitPrice = pos.sl;
          exitReason = pos.tp1Hit ? "Trailing BE" : "SL";
        } else if (!pos.tp1Hit && c.high >= pos.tp1) {
          const halfPnl = (pos.tp1 - pos.entryPrice) * (pos.qty / 2);
          capital += halfPnl;
          if (halfPnl > 0) st.grossProfit += halfPnl; else st.grossLoss += Math.abs(halfPnl);
          pos.tp1Hit = true;
          pos.remainingQty = pos.qty / 2;
          pos.sl = pos.entryPrice;
          st.tp1++;
        } else if (pos.tp1Hit && c.high >= pos.tp2) {
          exitPrice = pos.tp2;
          exitReason = "TP2";
          st.tp2++;
        }
      } else {
        if (c.high >= pos.sl) {
          exitPrice = pos.sl;
          exitReason = pos.tp1Hit ? "Trailing BE" : "SL";
        } else if (!pos.tp1Hit && c.low <= pos.tp1) {
          const halfPnl = (pos.entryPrice - pos.tp1) * (pos.qty / 2);
          capital += halfPnl;
          if (halfPnl > 0) st.grossProfit += halfPnl; else st.grossLoss += Math.abs(halfPnl);
          pos.tp1Hit = true;
          pos.remainingQty = pos.qty / 2;
          pos.sl = pos.entryPrice;
          st.tp1++;
        } else if (pos.tp1Hit && c.low <= pos.tp2) {
          exitPrice = pos.tp2;
          exitReason = "TP2";
          st.tp2++;
        }
      }

      if (!exitPrice && pos.barsInTrade >= CFG.timeoutBars) {
        exitPrice = c.close;
        exitReason = "Timeout";
        st.timeout++;
      }

      if (exitPrice !== null) {
        const pnlPerUnit = pos.direction === "LONG"
          ? exitPrice - pos.entryPrice
          : pos.entryPrice - exitPrice;
        const pnl = pnlPerUnit * pos.remainingQty;
        capital += pnl;
        if (pnl > 0) st.grossProfit += pnl; else st.grossLoss += Math.abs(pnl);
        if (exitReason === "SL") st.sl++;

        // Total P&L for win/loss counting
        const totalPnl = pos.tp1Hit && exitReason !== "SL"
          ? pnl + (pos.direction === "LONG" ? 1 : -1) * (pos.tp1 - pos.entryPrice) * (pos.qty / 2) * (pos.direction === "LONG" ? 1 : -1)
          : pnl;
        // Simplified: if tp1 was hit, it was a partial win already
        if (pos.tp1Hit || pnl > 0) totalWins++;
        totalTradesClosed++;

        openPositions.delete(sym);
      }
    }

    // 2. Check active signals waiting for entry
    for (const [sym, active] of activeSignals) {
      const candles = allCandles.get(sym)!;
      const c = candles[i];
      const st = stats.get(sym)!;
      const ind = indicators.get(sym)!;
      active.barsWaiting++;

      // Score cancellation
      const currentScore = scoreBar(candles, ind, i);
      if (currentScore.score < CFG.scoreCancelThreshold) {
        activeSignals.delete(sym);
        st.cancelled++;
        continue;
      }

      // Price reached ideal zone
      const reachedIdeal = active.direction === "LONG"
        ? c.low <= active.entryIdeal * (1 + CFG.idealZoneTolerance)
        : c.high >= active.entryIdeal * (1 - CFG.idealZoneTolerance);

      if (reachedIdeal && openPositions.size < CFG.maxOpenPositions && !openPositions.has(sym)) {
        const entryPrice = active.entryIdeal;
        const slDist = Math.abs(entryPrice - active.sl);
        const riskAmt = capital * CFG.riskPerTrade;
        const qty = slDist > 0 ? riskAmt / slDist : 0;

        if (qty > 0) {
          openPositions.set(sym, {
            symbol: sym, signalBarIndex: active.barIndex, entryBarIndex: i,
            entryPrice, direction: active.direction,
            sl: active.sl, tp1: active.tp1, tp2: active.tp2,
            qty, capitalAtEntry: capital,
            tp1Hit: false, remainingQty: qty, barsInTrade: 0,
          });
          st.entriesF2++;
          st.timesToEntry.push(active.barsWaiting);
        }
        activeSignals.delete(sym);
        continue;
      }

      // Price escaped
      const escaped = active.direction === "LONG"
        ? c.high > active.entryLatest
        : c.low < active.entryLatest;
      if (escaped) { activeSignals.delete(sym); st.escaped++; continue; }

      // Expired
      if (active.barsWaiting >= CFG.expiryBars) { activeSignals.delete(sym); st.expired++; continue; }
    }

    // 3. Scan for new Phase 1 signals
    for (const sym of PAIRS) {
      if (activeSignals.has(sym) || openPositions.has(sym)) continue;
      const lastBar = lastSignalBar.get(sym) ?? -999;
      if (i - lastBar < CFG.cooldownBars) continue;

      const candles = allCandles.get(sym)!;
      if (i >= candles.length) continue;
      const ind = indicators.get(sym)!;
      const bs = scoreBar(candles, ind, i);

      if (bs.score < CFG.scoreThreshold || bs.direction === "NEUTRAL") continue;
      if (bs.atrValue <= 0) continue;

      const st = stats.get(sym)!;
      const price = candles[i].close;
      const atr = bs.atrValue;
      const zone = calcEntryZone(price, bs.ema21Value, atr, bs.direction);

      let adjustedScore = bs.score;
      if (zone.type === "late") adjustedScore = Math.round(adjustedScore * 0.8);
      if (adjustedScore < CFG.scoreThreshold) continue;

      let sl: number, tp1: number, tp2: number;
      if (bs.direction === "LONG") {
        sl = price - CFG.atrSlMult * atr;
        tp1 = price + CFG.atrTp1Mult * atr;
        tp2 = price + CFG.atrTp2Mult * atr;
      } else {
        sl = price + CFG.atrSlMult * atr;
        tp1 = price - CFG.atrTp1Mult * atr;
        tp2 = price - CFG.atrTp2Mult * atr;
      }

      st.signalsF1++;
      lastSignalBar.set(sym, i);

      if (zone.type === "momentum" && openPositions.size < CFG.maxOpenPositions) {
        const slDist = Math.abs(price - sl);
        const riskAmt = capital * CFG.riskPerTrade;
        const qty = slDist > 0 ? riskAmt / slDist : 0;
        if (qty > 0) {
          openPositions.set(sym, {
            symbol: sym, signalBarIndex: i, entryBarIndex: i,
            entryPrice: price, direction: bs.direction,
            sl, tp1, tp2, qty, capitalAtEntry: capital,
            tp1Hit: false, remainingQty: qty, barsInTrade: 0,
          });
          st.entriesF2++;
          st.timesToEntry.push(0);
        }
      } else if (zone.type !== "momentum") {
        activeSignals.set(sym, {
          symbol: sym, barIndex: i, score: adjustedScore, direction: bs.direction,
          entryIdeal: zone.ideal, entryLatest: zone.latest,
          sl, tp1, tp2, barsWaiting: 0,
        });
      }
    }

    // Track drawdown
    if (capital > peak) peak = capital;
    const dd = peak > 0 ? ((peak - capital) / peak) * 100 : 0;
    if (dd > maxDD) maxDD = dd;
  }

  // Close remaining positions
  for (const [sym, pos] of openPositions) {
    const candles = allCandles.get(sym)!;
    const lastPrice = candles[candles.length - 1].close;
    const pnl = (pos.direction === "LONG"
      ? lastPrice - pos.entryPrice
      : pos.entryPrice - lastPrice) * pos.remainingQty;
    capital += pnl;
    const st = stats.get(sym)!;
    if (pnl > 0) st.grossProfit += pnl; else st.grossLoss += Math.abs(pnl);
    totalTradesClosed++;
    if (pnl > 0) totalWins++;
  }

  // ─── Print results ───

  console.log("═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════");
  console.log("  RESULTADOS POR PAR");
  console.log("═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════");

  const header = [
    "Par".padEnd(8),
    "F1".padStart(5),
    "F2".padStart(5),
    "%Zona".padStart(6),
    "TP1".padStart(5),
    "TP2".padStart(5),
    "SL".padStart(5),
    "T.Out".padStart(5),
    "Expir".padStart(5),
    "Escap".padStart(5),
    "Canc.".padStart(5),
    "WR%".padStart(7),
    "PF".padStart(7),
    "Ret%".padStart(8),
  ].join(" │ ");
  console.log(header);
  console.log("─".repeat(header.length));

  let totalF1 = 0, totalF2 = 0;
  let globalGrossProfit = 0, globalGrossLoss = 0;
  const allTimesToEntry: number[] = [];

  for (const sym of PAIRS) {
    const st = stats.get(sym)!;
    totalF1 += st.signalsF1;
    totalF2 += st.entriesF2;
    globalGrossProfit += st.grossProfit;
    globalGrossLoss += st.grossLoss;
    allTimesToEntry.push(...st.timesToEntry);

    const pctZone = st.signalsF1 > 0 ? (st.entriesF2 / st.signalsF1 * 100).toFixed(0) : "0";
    const wr = st.entriesF2 > 0 ? ((st.tp1 + st.tp2) / st.entriesF2 * 100).toFixed(1) : "0.0";
    const pf = st.grossLoss > 0 ? (st.grossProfit / st.grossLoss).toFixed(2) : st.grossProfit > 0 ? "∞" : "0.00";
    const ret = ((st.grossProfit - st.grossLoss) / 1000 * 100).toFixed(2);

    const row = [
      sym.replace("USDT", "").padEnd(8),
      String(st.signalsF1).padStart(5),
      String(st.entriesF2).padStart(5),
      (pctZone + "%").padStart(6),
      String(st.tp1).padStart(5),
      String(st.tp2).padStart(5),
      String(st.sl).padStart(5),
      String(st.timeout).padStart(5),
      String(st.expired).padStart(5),
      String(st.escaped).padStart(5),
      String(st.cancelled).padStart(5),
      (wr + "%").padStart(7),
      pf.padStart(7),
      (ret + "%").padStart(8),
    ].join(" │ ");
    console.log(row);
  }

  console.log("─".repeat(header.length));

  // Global summary
  const avgBarsToEntry = allTimesToEntry.length > 0
    ? allTimesToEntry.reduce((s, v) => s + v, 0) / allTimesToEntry.length
    : 0;
  const totalWeeks = totalBars / (24 * 7);
  const totalReturn = ((capital - 1000) / 1000 * 100);
  const globalPF = globalGrossLoss > 0 ? globalGrossProfit / globalGrossLoss : Infinity;
  const globalWR = totalTradesClosed > 0 ? (totalWins / totalTradesClosed * 100) : 0;

  // Best / worst pair
  let bestPair = "", bestRet = -Infinity;
  let worstPair = "", worstRet = Infinity;
  for (const sym of PAIRS) {
    const st = stats.get(sym)!;
    const ret = st.grossProfit - st.grossLoss;
    if (ret > bestRet) { bestRet = ret; bestPair = sym; }
    if (ret < worstRet) { worstRet = ret; worstPair = sym; }
  }

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  RESUMEN GLOBAL");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  Total senales F1:         ${totalF1}`);
  console.log(`  Total entradas F2:        ${totalF2}`);
  console.log(`  % llego a zona:           ${totalF1 > 0 ? (totalF2 / totalF1 * 100).toFixed(1) : 0}%`);
  console.log(`  Tiempo medio F1→F2:       ${(avgBarsToEntry * 60).toFixed(0)} min (${avgBarsToEntry.toFixed(1)} barras)`);
  console.log(`  Win rate global:          ${globalWR.toFixed(1)}%`);
  console.log(`  Profit factor global:     ${globalPF === Infinity ? "∞" : globalPF.toFixed(2)}`);
  console.log(`  Retorno total:            ${totalReturn >= 0 ? "+" : ""}${totalReturn.toFixed(2)}% ($${1000} → $${capital.toFixed(2)})`);
  console.log(`  Max drawdown:             ${maxDD.toFixed(2)}%`);
  console.log(`  Trades cerrados:          ${totalTradesClosed}`);
  console.log(`  Trades por semana:        ${(totalF2 / totalWeeks).toFixed(1)}`);
  console.log(`  Barras totales:           ${totalBars} (${(totalBars / 24 / 365).toFixed(1)} anos)`);
  console.log(`  Mejor par:                ${bestPair.replace("USDT", "")} (+$${bestRet.toFixed(2)})`);
  console.log(`  Peor par:                 ${worstPair.replace("USDT", "")} (${worstRet >= 0 ? "+" : ""}$${worstRet.toFixed(2)})`);
  console.log("═══════════════════════════════════════════════════════════\n");
}

main().catch(console.error);
