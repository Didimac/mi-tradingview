/**
 * Two-Phase Scorer Backtest — v3 Optimization
 * Compares: v2 (score 82, SL 1.5, TP1 2.25, TP2 4.5, 10 pairs, 50% partial)
 *       vs: v3 (score 85, SL 2.0, TP1 2.25, TP2 4.5, 5 pairs, 33% partial)
 * Usage: npx tsx scripts/run-two-phase-v3.ts
 */

// ─── Types ───
interface Candle {
  time: number; open: number; high: number; low: number; close: number; volume: number;
}

// ─── Binance REST ───
const BASE = "https://api.binance.com/api/v3";

async function fetchKlines(symbol: string, interval: string, limit = 1000): Promise<Candle[]> {
  const url = `${BASE}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`klines ${res.status}`);
  const data = (await res.json()) as unknown[][];
  return data.map((k) => ({
    time: Math.floor((k[0] as number) / 1000),
    open: parseFloat(k[1] as string), high: parseFloat(k[2] as string),
    low: parseFloat(k[3] as string), close: parseFloat(k[4] as string),
    volume: parseFloat(k[5] as string),
  }));
}

async function fetchKlinesBefore(symbol: string, interval: string, endTimeMs: number, limit = 1000): Promise<Candle[]> {
  const url = `${BASE}/klines?symbol=${symbol}&interval=${interval}&endTime=${endTimeMs - 1}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`klines ${res.status}`);
  const data = (await res.json()) as unknown[][];
  return data.map((k) => ({
    time: Math.floor((k[0] as number) / 1000),
    open: parseFloat(k[1] as string), high: parseFloat(k[2] as string),
    low: parseFloat(k[3] as string), close: parseFloat(k[4] as string),
    volume: parseFloat(k[5] as string),
  }));
}

async function loadCandles(symbol: string, interval: string, count: number): Promise<Candle[]> {
  let candles = await fetchKlines(symbol, interval, Math.min(count, 1000));
  while (candles.length < count) {
    const oldest = candles[0];
    const batch = await fetchKlinesBefore(symbol, interval, oldest.time * 1000, Math.min(count - candles.length, 1000));
    if (batch.length === 0) break;
    candles = [...batch, ...candles];
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

// ─── Indicators ───
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

interface Indicators {
  ema21: number[]; ema55: number[]; rsi14: number[]; atr14: number[]; volSma20: number[];
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
  score: number; direction: "LONG" | "SHORT" | "NEUTRAL"; ema21Value: number; atrValue: number;
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
interface Config {
  label: string;
  scoreThreshold: number;
  scoreCancelThreshold: number;
  riskPerTrade: number;
  maxOpenPositions: number;
  expiryBars: number;
  timeoutBars: number;
  idealZoneTolerance: number;
  cooldownBars: number;
  atrSlMult: number;
  atrTp1Mult: number;
  atrTp2Mult: number;
  useTrendFilter: boolean;
  tp1PartialPct: number; // fraction closed at TP1 (0.5 = 50%, 0.33 = 33%)
  pairs: string[];
}

const ALL_PAIRS = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT",
  "DOGEUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT", "TONUSDT",
];

const TOP5_PAIRS = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "TONUSDT",
];

const CFG_V2: Config = {
  label: "v2 (anterior)",
  scoreThreshold: 82,
  scoreCancelThreshold: 60,
  riskPerTrade: 0.015,
  maxOpenPositions: 1,
  expiryBars: 2,
  timeoutBars: 48,
  idealZoneTolerance: 0.001,
  cooldownBars: 2,
  atrSlMult: 1.5,
  atrTp1Mult: 2.25,
  atrTp2Mult: 4.5,
  useTrendFilter: true,
  tp1PartialPct: 0.5,
  pairs: ALL_PAIRS,
};

const CFG_V3: Config = {
  label: "v3 (nuevo)",
  scoreThreshold: 85,          // CAMBIO 2: 82 → 85
  scoreCancelThreshold: 60,
  riskPerTrade: 0.015,
  maxOpenPositions: 1,
  expiryBars: 2,
  timeoutBars: 48,
  idealZoneTolerance: 0.001,
  cooldownBars: 2,
  atrSlMult: 2.0,              // CAMBIO 1: 1.5 → 2.0
  atrTp1Mult: 2.25,
  atrTp2Mult: 4.5,
  useTrendFilter: true,
  tp1PartialPct: 0.33,         // CAMBIO 4: 0.5 → 0.33
  pairs: TOP5_PAIRS,           // CAMBIO 3: 10 → 5 pares
};

// ─── Backtest runner ───

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
  filteredByTrend: number;
}

interface RunResult {
  config: Config;
  totalF1: number; totalF2: number;
  globalWR: number; globalPF: number;
  totalReturn: number; finalCapital: number;
  maxDD: number; tradesPerWeek: number;
  totalTradesClosed: number; totalWins: number;
  avgBarsToEntry: number;
  bestPair: string; bestRet: number;
  worstPair: string; worstRet: number;
  pairStats: Map<string, PairStats>;
  totalFilteredByTrend: number;
}

function runBacktestWithConfig(
  cfg: Config,
  allCandles: Map<string, Candle[]>,
  allIndicators: Map<string, Indicators>,
): RunResult {
  const pairs = cfg.pairs;
  const firstCandles = allCandles.get(pairs[0])!;
  const totalBars = firstCandles.length;
  const minStart = 60;

  let capital = 1000;
  let peak = 1000;
  let maxDD = 0;

  const activeSignals = new Map<string, ActiveSignal>();
  const openPositions = new Map<string, OpenPosition>();
  const lastSignalBar = new Map<string, number>();

  const stats = new Map<string, PairStats>();
  for (const sym of pairs) {
    stats.set(sym, {
      signalsF1: 0, entriesF2: 0,
      tp1: 0, tp2: 0, sl: 0, timeout: 0,
      expired: 0, escaped: 0, cancelled: 0,
      grossProfit: 0, grossLoss: 0,
      timesToEntry: [],
      filteredByTrend: 0,
    });
  }

  let totalTradesClosed = 0;
  let totalWins = 0;

  for (let i = minStart; i < totalBars; i++) {
    // 1. Check open positions
    for (const [sym, pos] of openPositions) {
      const candles = allCandles.get(sym)!;
      if (i >= candles.length) continue;
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
          // TP1 hit — close partial
          const partialQty = pos.qty * cfg.tp1PartialPct;
          const halfPnl = (pos.tp1 - pos.entryPrice) * partialQty;
          capital += halfPnl;
          if (halfPnl > 0) st.grossProfit += halfPnl; else st.grossLoss += Math.abs(halfPnl);
          pos.tp1Hit = true;
          pos.remainingQty = pos.qty - partialQty;
          pos.sl = pos.entryPrice; // Move to BE
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
          const partialQty = pos.qty * cfg.tp1PartialPct;
          const halfPnl = (pos.entryPrice - pos.tp1) * partialQty;
          capital += halfPnl;
          if (halfPnl > 0) st.grossProfit += halfPnl; else st.grossLoss += Math.abs(halfPnl);
          pos.tp1Hit = true;
          pos.remainingQty = pos.qty - partialQty;
          pos.sl = pos.entryPrice;
          st.tp1++;
        } else if (pos.tp1Hit && c.low <= pos.tp2) {
          exitPrice = pos.tp2;
          exitReason = "TP2";
          st.tp2++;
        }
      }

      if (!exitPrice && pos.barsInTrade >= cfg.timeoutBars) {
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

        if (pos.tp1Hit || pnl > 0) totalWins++;
        totalTradesClosed++;

        openPositions.delete(sym);
      }
    }

    // 2. Check active signals waiting for entry
    for (const [sym, active] of activeSignals) {
      const candles = allCandles.get(sym)!;
      if (i >= candles.length) { activeSignals.delete(sym); continue; }
      const c = candles[i];
      const st = stats.get(sym)!;
      const ind = allIndicators.get(sym)!;
      active.barsWaiting++;

      const currentScore = scoreBar(candles, ind, i);
      if (currentScore.score < cfg.scoreCancelThreshold) {
        activeSignals.delete(sym);
        st.cancelled++;
        continue;
      }

      const reachedIdeal = active.direction === "LONG"
        ? c.low <= active.entryIdeal * (1 + cfg.idealZoneTolerance)
        : c.high >= active.entryIdeal * (1 - cfg.idealZoneTolerance);

      if (reachedIdeal && openPositions.size < cfg.maxOpenPositions && !openPositions.has(sym)) {
        const entryPrice = active.entryIdeal;
        const slDist = Math.abs(entryPrice - active.sl);
        const riskAmt = capital * cfg.riskPerTrade;
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

      const escaped = active.direction === "LONG"
        ? c.high > active.entryLatest
        : c.low < active.entryLatest;
      if (escaped) { activeSignals.delete(sym); st.escaped++; continue; }

      if (active.barsWaiting >= cfg.expiryBars) { activeSignals.delete(sym); st.expired++; continue; }
    }

    // 3. Scan for new Phase 1 signals
    for (const sym of pairs) {
      if (activeSignals.has(sym) || openPositions.has(sym)) continue;
      const lastBar = lastSignalBar.get(sym) ?? -999;
      if (i - lastBar < cfg.cooldownBars) continue;

      const candles = allCandles.get(sym)!;
      if (i >= candles.length) continue;
      const ind = allIndicators.get(sym)!;
      const bs = scoreBar(candles, ind, i);

      if (bs.score < cfg.scoreThreshold || bs.direction === "NEUTRAL") continue;
      if (bs.atrValue <= 0) continue;

      const st = stats.get(sym)!;
      const price = candles[i].close;
      const atr = bs.atrValue;

      // Trend filter: price vs EMA55
      if (cfg.useTrendFilter) {
        const ema55v = ind.ema55[i];
        if (isNaN(ema55v)) continue;
        if (bs.direction === "LONG" && price <= ema55v) { st.filteredByTrend++; continue; }
        if (bs.direction === "SHORT" && price >= ema55v) { st.filteredByTrend++; continue; }
      }

      const zone = calcEntryZone(price, bs.ema21Value, atr, bs.direction);

      let adjustedScore = bs.score;
      if (zone.type === "late") adjustedScore = Math.round(adjustedScore * 0.8);
      if (adjustedScore < cfg.scoreThreshold) continue;

      let sl: number, tp1: number, tp2: number;
      if (bs.direction === "LONG") {
        sl = price - cfg.atrSlMult * atr;
        tp1 = price + cfg.atrTp1Mult * atr;
        tp2 = price + cfg.atrTp2Mult * atr;
      } else {
        sl = price + cfg.atrSlMult * atr;
        tp1 = price - cfg.atrTp1Mult * atr;
        tp2 = price - cfg.atrTp2Mult * atr;
      }

      st.signalsF1++;
      lastSignalBar.set(sym, i);

      if (zone.type === "momentum" && openPositions.size < cfg.maxOpenPositions) {
        const slDist = Math.abs(price - sl);
        const riskAmt = capital * cfg.riskPerTrade;
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

    if (capital > peak) peak = capital;
    const dd = peak > 0 ? ((peak - capital) / peak) * 100 : 0;
    if (dd > maxDD) maxDD = dd;
  }

  // Close remaining
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

  // Aggregate
  let totalF1 = 0, totalF2 = 0;
  let globalGrossProfit = 0, globalGrossLoss = 0;
  const allTimesToEntry: number[] = [];
  let bestPair = "", bestRet = -Infinity;
  let worstPair = "", worstRet = Infinity;
  let totalFilteredByTrend = 0;

  for (const sym of pairs) {
    const st = stats.get(sym)!;
    totalF1 += st.signalsF1;
    totalF2 += st.entriesF2;
    globalGrossProfit += st.grossProfit;
    globalGrossLoss += st.grossLoss;
    allTimesToEntry.push(...st.timesToEntry);
    totalFilteredByTrend += st.filteredByTrend;
    const ret = st.grossProfit - st.grossLoss;
    if (ret > bestRet) { bestRet = ret; bestPair = sym; }
    if (ret < worstRet) { worstRet = ret; worstPair = sym; }
  }

  const avgBarsToEntry = allTimesToEntry.length > 0
    ? allTimesToEntry.reduce((s, v) => s + v, 0) / allTimesToEntry.length : 0;
  const totalWeeks = totalBars / (24 * 7);
  const totalReturn = ((capital - 1000) / 1000 * 100);
  const globalPF = globalGrossLoss > 0 ? globalGrossProfit / globalGrossLoss : Infinity;
  const globalWR = totalTradesClosed > 0 ? (totalWins / totalTradesClosed * 100) : 0;

  return {
    config: cfg,
    totalF1, totalF2,
    globalWR, globalPF,
    totalReturn, finalCapital: capital,
    maxDD, tradesPerWeek: totalF2 / totalWeeks,
    totalTradesClosed, totalWins,
    avgBarsToEntry,
    bestPair: bestPair.replace("USDT", ""),
    bestRet,
    worstPair: worstPair.replace("USDT", ""),
    worstRet,
    pairStats: stats,
    totalFilteredByTrend,
  };
}

// ─── Main ───

async function main() {
  console.log("═══════════════════════════════════════════════════════════════════════");
  console.log("  TWO-PHASE SCORER — BACKTEST v3 (Ronda 3 de optimizacion)");
  console.log("  Capital inicial: $1,000 — Periodo: 2 anos × 1H");
  console.log("═══════════════════════════════════════════════════════════════════════\n");

  console.log("  CAMBIOS v2 → v3:");
  console.log("  [1] SL:              1.5 → 2.0 × ATR (mas espacio)");
  console.log("  [2] Score threshold: 82 → 85 (solo senales fuertes)");
  console.log("  [3] Pares:           10 → 5 (BTC, ETH, SOL, BNB, TON)");
  console.log("  [4] TP1 parcial:     50% → 33% (dejar correr mas)\n");

  // Download all 10 pairs (need them for v2 comparison)
  const allCandles = new Map<string, Candle[]>();
  const targetCount = 17520;

  for (const sym of ALL_PAIRS) {
    process.stdout.write(`  Descargando ${sym}...`);
    const candles = await loadCandles(sym, "1h", targetCount);
    allCandles.set(sym, candles);
    const d0 = new Date(candles[0].time * 1000).toISOString().slice(0, 10);
    const d1 = new Date(candles[candles.length - 1].time * 1000).toISOString().slice(0, 10);
    console.log(` ${candles.length} barras (${d0} → ${d1})`);
  }

  const allIndicators = new Map<string, Indicators>();
  for (const [sym, candles] of allCandles) {
    allIndicators.set(sym, precompute(candles));
  }

  console.log("\n  Ejecutando backtest v2 (10 pares, score 82, SL 1.5, TP1 50%)...");
  const resV2 = runBacktestWithConfig(CFG_V2, allCandles, allIndicators);

  console.log("  Ejecutando backtest v3 (5 pares, score 85, SL 2.0, TP1 33%)...");
  const resV3 = runBacktestWithConfig(CFG_V3, allCandles, allIndicators);

  // Also run v2 config but restricted to the same 5 pairs for fair comparison
  const CFG_V2_5PAIRS: Config = { ...CFG_V2, label: "v2 (5 pares)", pairs: TOP5_PAIRS };
  console.log("  Ejecutando backtest v2 restringido a 5 pares (comparacion justa)...");
  const resV2_5 = runBacktestWithConfig(CFG_V2_5PAIRS, allCandles, allIndicators);

  // ─── Per-pair table for v3 ───

  console.log("\n═════════════════════════════════════════════════════════════════════════════════════════════════════════════════");
  console.log("  RESULTADOS POR PAR — v3 (score>=85, SL 2.0x, TP1 2.25x, TP2 4.5x, 33% parcial, filtro EMA55)");
  console.log("═════════════════════════════════════════════════════════════════════════════════════════════════════════════════");

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
    "Trend".padStart(5),
    "WR%".padStart(7),
    "PF".padStart(7),
    "P&L $".padStart(10),
    "Ret%".padStart(8),
  ].join(" | ");
  console.log(header);
  console.log("-".repeat(header.length));

  for (const sym of TOP5_PAIRS) {
    const st = resV3.pairStats.get(sym)!;
    const pctZone = st.signalsF1 > 0 ? (st.entriesF2 / st.signalsF1 * 100).toFixed(0) : "0";
    const totalTrades = st.entriesF2;
    const wins = st.tp1 + st.tp2;
    const wr = totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : "0.0";
    const pf = st.grossLoss > 0 ? (st.grossProfit / st.grossLoss).toFixed(2) : st.grossProfit > 0 ? "999" : "0.00";
    const pnl = st.grossProfit - st.grossLoss;
    const ret = (pnl / 1000 * 100).toFixed(2);

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
      String(st.filteredByTrend).padStart(5),
      (wr + "%").padStart(7),
      pf.padStart(7),
      (pnl >= 0 ? "+" : "") + "$" + pnl.toFixed(2).padStart(8),
      (ret + "%").padStart(8),
    ].join(" | ");
    console.log(row);
  }

  console.log("-".repeat(header.length));

  // ─── Comparative: v2(10 pairs) vs v3(5 pairs) ───

  console.log("\n═══════════════════════════════════════════════════════════════════════");
  console.log("  TABLA COMPARATIVA: v2 (10 pares) vs v3 (5 pares)");
  console.log("═══════════════════════════════════════════════════════════════════════\n");

  const fmtPct = (n: number) => n >= 0 ? `+${n.toFixed(1)}%` : `${n.toFixed(1)}%`;
  const fmt = (n: number, dec = 2) => n >= 0 ? `+${n.toFixed(dec)}` : n.toFixed(dec);

  const compHeader = [
    "Metrica".padEnd(24),
    "v2 (10p)".padStart(14),
    "v3 (5p)".padStart(14),
    "Cambio".padStart(14),
  ].join(" | ");
  console.log(compHeader);
  console.log("-".repeat(compHeader.length));

  const v2z = resV2.totalF1 > 0 ? (resV2.totalF2 / resV2.totalF1 * 100) : 0;
  const v3z = resV3.totalF1 > 0 ? (resV3.totalF2 / resV3.totalF1 * 100) : 0;

  const rows: [string, string, string, string][] = [
    ["Pares", "10", "5", "-5"],
    ["Score threshold", "82", "85", "+3"],
    ["SL (ATR mult)", "1.5x", "2.0x", "+0.5x"],
    ["TP1 parcial", "50%", "33%", "-17pp"],
    ["---", "---", "---", "---"],
    [
      "Senales F1",
      String(resV2.totalF1),
      String(resV3.totalF1),
      `${fmt(resV3.totalF1 - resV2.totalF1, 0)} (${resV2.totalF1 > 0 ? ((resV3.totalF1 / resV2.totalF1 - 1) * 100).toFixed(0) : 0}%)`,
    ],
    [
      "Filtradas tendencia",
      String(resV2.totalFilteredByTrend),
      String(resV3.totalFilteredByTrend),
      fmt(resV3.totalFilteredByTrend - resV2.totalFilteredByTrend, 0),
    ],
    [
      "Entradas F2",
      String(resV2.totalF2),
      String(resV3.totalF2),
      `${fmt(resV3.totalF2 - resV2.totalF2, 0)} (${resV2.totalF2 > 0 ? ((resV3.totalF2 / resV2.totalF2 - 1) * 100).toFixed(0) : 0}%)`,
    ],
    [
      "% llego a zona",
      `${v2z.toFixed(1)}%`,
      `${v3z.toFixed(1)}%`,
      fmtPct(v3z - v2z),
    ],
    [
      "Trades / semana",
      resV2.tradesPerWeek.toFixed(1),
      resV3.tradesPerWeek.toFixed(1),
      fmt(resV3.tradesPerWeek - resV2.tradesPerWeek),
    ],
    [
      "Win Rate global",
      `${resV2.globalWR.toFixed(1)}%`,
      `${resV3.globalWR.toFixed(1)}%`,
      fmtPct(resV3.globalWR - resV2.globalWR),
    ],
    [
      "Profit Factor",
      resV2.globalPF === Infinity ? "inf" : resV2.globalPF.toFixed(2),
      resV3.globalPF === Infinity ? "inf" : resV3.globalPF.toFixed(2),
      fmt(resV3.globalPF - resV2.globalPF),
    ],
    [
      "Retorno total",
      `${resV2.totalReturn.toFixed(2)}%`,
      `${resV3.totalReturn.toFixed(2)}%`,
      fmtPct(resV3.totalReturn - resV2.totalReturn),
    ],
    [
      "Capital final",
      `$${resV2.finalCapital.toFixed(2)}`,
      `$${resV3.finalCapital.toFixed(2)}`,
      `$${fmt(resV3.finalCapital - resV2.finalCapital)}`,
    ],
    [
      "Max Drawdown",
      `${resV2.maxDD.toFixed(2)}%`,
      `${resV3.maxDD.toFixed(2)}%`,
      fmtPct(resV3.maxDD - resV2.maxDD),
    ],
    [
      "Trades cerrados",
      String(resV2.totalTradesClosed),
      String(resV3.totalTradesClosed),
      fmt(resV3.totalTradesClosed - resV2.totalTradesClosed, 0),
    ],
    [
      "Mejor par",
      `${resV2.bestPair} (+$${resV2.bestRet.toFixed(0)})`,
      `${resV3.bestPair} (+$${resV3.bestRet.toFixed(0)})`,
      "",
    ],
    [
      "Peor par",
      `${resV2.worstPair} ($${resV2.worstRet.toFixed(0)})`,
      `${resV3.worstPair} ($${resV3.worstRet.toFixed(0)})`,
      "",
    ],
  ];

  for (const [metric, before, after, change] of rows) {
    if (metric === "---") {
      console.log("-".repeat(compHeader.length));
      continue;
    }
    const row = [
      metric.padEnd(24),
      before.padStart(14),
      after.padStart(14),
      change.padStart(14),
    ].join(" | ");
    console.log(row);
  }

  console.log("-".repeat(compHeader.length));

  // ─── Fair comparison: v2 vs v3 SAME 5 pairs ───

  console.log("\n═══════════════════════════════════════════════════════════════════════");
  console.log("  COMPARACION JUSTA: v2 vs v3 (ambos con 5 pares)");
  console.log("═══════════════════════════════════════════════════════════════════════\n");

  const fairHeader = [
    "Metrica".padEnd(24),
    "v2 (5p)".padStart(14),
    "v3 (5p)".padStart(14),
    "Delta".padStart(14),
  ].join(" | ");
  console.log(fairHeader);
  console.log("-".repeat(fairHeader.length));

  const v2_5z = resV2_5.totalF1 > 0 ? (resV2_5.totalF2 / resV2_5.totalF1 * 100) : 0;

  const fairRows: [string, string, string, string][] = [
    [
      "Senales F1",
      String(resV2_5.totalF1),
      String(resV3.totalF1),
      fmt(resV3.totalF1 - resV2_5.totalF1, 0),
    ],
    [
      "Entradas F2",
      String(resV2_5.totalF2),
      String(resV3.totalF2),
      fmt(resV3.totalF2 - resV2_5.totalF2, 0),
    ],
    [
      "% llego a zona",
      `${v2_5z.toFixed(1)}%`,
      `${v3z.toFixed(1)}%`,
      fmtPct(v3z - v2_5z),
    ],
    [
      "Win Rate",
      `${resV2_5.globalWR.toFixed(1)}%`,
      `${resV3.globalWR.toFixed(1)}%`,
      fmtPct(resV3.globalWR - resV2_5.globalWR),
    ],
    [
      "Profit Factor",
      resV2_5.globalPF === Infinity ? "inf" : resV2_5.globalPF.toFixed(2),
      resV3.globalPF === Infinity ? "inf" : resV3.globalPF.toFixed(2),
      fmt(resV3.globalPF - resV2_5.globalPF),
    ],
    [
      "Retorno total",
      `${resV2_5.totalReturn.toFixed(2)}%`,
      `${resV3.totalReturn.toFixed(2)}%`,
      fmtPct(resV3.totalReturn - resV2_5.totalReturn),
    ],
    [
      "Capital final",
      `$${resV2_5.finalCapital.toFixed(2)}`,
      `$${resV3.finalCapital.toFixed(2)}`,
      `$${fmt(resV3.finalCapital - resV2_5.finalCapital)}`,
    ],
    [
      "Max Drawdown",
      `${resV2_5.maxDD.toFixed(2)}%`,
      `${resV3.maxDD.toFixed(2)}%`,
      fmtPct(resV3.maxDD - resV2_5.maxDD),
    ],
  ];

  for (const [metric, before, after, change] of fairRows) {
    const row = [
      metric.padEnd(24),
      before.padStart(14),
      after.padStart(14),
      change.padStart(14),
    ].join(" | ");
    console.log(row);
  }

  console.log("-".repeat(fairHeader.length));

  // ─── Verdict ───

  console.log("\n═══════════════════════════════════════════════════════════════════════");
  console.log("  VEREDICTO FINAL");
  console.log("═══════════════════════════════════════════════════════════════════════");

  const pf = resV3.globalPF;
  const profitable = resV3.totalReturn > 0;

  if (pf >= 1.2) {
    console.log(`  ✅ PF = ${pf.toFixed(2)} >= 1.2 — OBJETIVO ALCANZADO`);
    console.log("     El sistema tiene edge estadistico robusto.");
  } else if (pf >= 1.0) {
    console.log(`  🟡 PF = ${pf.toFixed(2)} — Edge marginal (objetivo: >= 1.2)`);
    console.log("     Rentable pero sin margen de seguridad suficiente.");
  } else {
    console.log(`  🔴 PF = ${pf.toFixed(2)} < 1.0 — No rentable (objetivo: >= 1.2)`);
  }

  if (profitable) {
    console.log(`  💰 RENTABLE: $1,000 → $${resV3.finalCapital.toFixed(2)} (${resV3.totalReturn >= 0 ? "+" : ""}${resV3.totalReturn.toFixed(2)}%)`);
  } else {
    console.log(`  📉 PERDIDA: $1,000 → $${resV3.finalCapital.toFixed(2)} (${resV3.totalReturn.toFixed(2)}%)`);
  }

  console.log(`  📊 Max DD: ${resV3.maxDD.toFixed(2)}% | WR: ${resV3.globalWR.toFixed(1)}% | Trades/sem: ${resV3.tradesPerWeek.toFixed(1)}`);

  // Per-pair verdict
  console.log("\n  Resultado por par:");
  for (const sym of TOP5_PAIRS) {
    const st = resV3.pairStats.get(sym)!;
    const pnl = st.grossProfit - st.grossLoss;
    const pf = st.grossLoss > 0 ? st.grossProfit / st.grossLoss : Infinity;
    const icon = pnl > 0 ? "🟢" : "🔴";
    console.log(`    ${icon} ${sym.replace("USDT", "").padEnd(5)} PF ${pf === Infinity ? "inf" : pf.toFixed(2).padStart(5)} | ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`);
  }

  console.log("═══════════════════════════════════════════════════════════════════════\n");
}

main().catch(console.error);
