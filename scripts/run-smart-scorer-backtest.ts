/**
 * SmartScorer v2 Backtest — CLI runner
 * Indicators: Funding Rate (35pts) + RSI Divergence (35pts) + VWAP Weekly (30pts)
 * Compares against Two-Phase Scorer v2 baseline
 * Usage: npx tsx scripts/run-smart-scorer-backtest.ts
 */

// ─── Types ───
interface Candle {
  time: number; open: number; high: number; low: number; close: number; volume: number;
}

interface FundingEntry {
  time: number; // unix seconds
  rate: number; // decimal (0.0001 = 0.01%)
}

// ─── Binance REST ───
const BASE = "https://api.binance.com/api/v3";
const FAPI = "https://fapi.binance.com/fapi/v1";

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

// ─── Funding Rate Historical ───

async function fetchFundingRateHistory(symbol: string, startTimeMs: number, endTimeMs: number): Promise<FundingEntry[]> {
  const all: FundingEntry[] = [];
  let cursor = startTimeMs;

  while (cursor < endTimeMs) {
    const url = `${FAPI}/fundingRate?symbol=${symbol}&startTime=${cursor}&endTime=${endTimeMs}&limit=1000`;
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`  ⚠ FR fetch failed ${res.status} for ${symbol}`);
      break;
    }
    const data = (await res.json()) as { fundingRate: string; fundingTime: number }[];
    if (data.length === 0) break;

    for (const d of data) {
      all.push({
        time: Math.floor(d.fundingTime / 1000),
        rate: parseFloat(d.fundingRate),
      });
    }

    cursor = data[data.length - 1].fundingTime + 1;
    await new Promise(r => setTimeout(r, 200));
  }

  return all.sort((a, b) => a.time - b.time);
}

/**
 * For a given bar timestamp, find the most recent funding rate.
 * FR updates every 8h, so we look for the latest FR <= bar time.
 */
function findFundingRate(frHistory: FundingEntry[], barTimeSec: number): number {
  let best = 0;
  for (let i = frHistory.length - 1; i >= 0; i--) {
    if (frHistory[i].time <= barTimeSec) {
      best = frHistory[i].rate;
      break;
    }
  }
  return best;
}

// ─── Indicators (inline) ───

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

function calcRSI(closes: number[], period = 14): number[] {
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

function calcATR(candles: Candle[], period = 14): number[] {
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

// ─── SmartScorer components (inline) ───

type Direction = "LONG" | "SHORT" | "NEUTRAL";

interface FRScore { value: number; points: number; direction: Direction; }
interface DivScore { type: string; points: number; direction: Direction; }
interface VWAPScore { vwap: number; distPct: number; points: number; direction: Direction; }

function scoreFundingRate(fr: number): FRScore {
  let direction: Direction = "NEUTRAL";
  if (fr < -0.0001) direction = "LONG";
  else if (fr > 0.0001) direction = "SHORT";

  let longPts = 0;
  if (fr < -0.0002) longPts = 35;
  else if (fr < 0.0001) longPts = 15;
  else if (fr < 0.0005) longPts = 0;
  else longPts = -20;

  let shortPts = 0;
  if (fr > 0.0005) shortPts = 35;
  else if (fr > -0.0001) shortPts = 15;
  else if (fr > -0.0002) shortPts = 0;
  else shortPts = -20;

  if (longPts >= shortPts) {
    return { value: fr, points: longPts, direction: longPts > 0 ? "LONG" : direction };
  }
  return { value: fr, points: shortPts, direction: shortPts > 0 ? "SHORT" : direction };
}

function detectDivergence(candles: Candle[], rsi: number[], i: number): DivScore {
  const none: DivScore = { type: "none", points: 0, direction: "NEUTRAL" };
  if (i < 20) return none;

  const lookbacks = [5, 8, 12, 16];

  for (const lb of lookbacks) {
    const j = i - lb;
    if (j < 0 || isNaN(rsi[i]) || isNaN(rsi[j])) continue;

    if (candles[i].low < candles[j].low && rsi[i] > rsi[j]) {
      return { type: "bullish", points: 35, direction: "LONG" };
    }
    if (candles[i].high > candles[j].high && rsi[i] < rsi[j]) {
      return { type: "bearish", points: 35, direction: "SHORT" };
    }
  }

  for (const lb of lookbacks) {
    const j = i - lb;
    if (j < 0 || isNaN(rsi[i]) || isNaN(rsi[j])) continue;

    if (candles[i].low > candles[j].low && rsi[i] < rsi[j]) {
      return { type: "hidden_bull", points: 20, direction: "LONG" };
    }
    if (candles[i].high < candles[j].high && rsi[i] > rsi[j]) {
      return { type: "hidden_bear", points: 20, direction: "SHORT" };
    }
  }

  return none;
}

function calcWeeklyVWAP(candles: Candle[], i: number): number {
  if (i < 0 || i >= candles.length) return NaN;

  const currentTime = candles[i].time * 1000;
  const d = new Date(currentTime);
  const dow = d.getUTCDay();
  const daysSinceMon = dow === 0 ? 6 : dow - 1;
  const weekStart = new Date(d);
  weekStart.setUTCHours(0, 0, 0, 0);
  weekStart.setUTCDate(weekStart.getUTCDate() - daysSinceMon);
  const wsTs = weekStart.getTime() / 1000;

  let sumPV = 0, sumV = 0;
  for (let k = i; k >= 0; k--) {
    if (candles[k].time < wsTs) break;
    const tp = (candles[k].high + candles[k].low + candles[k].close) / 3;
    sumPV += tp * candles[k].volume;
    sumV += candles[k].volume;
  }
  return sumV > 0 ? sumPV / sumV : candles[i].close;
}

function scoreVWAP(price: number, vwap: number): VWAPScore {
  const distPct = ((price - vwap) / vwap) * 100;

  let direction: Direction = "NEUTRAL";
  if (distPct < -0.5) direction = "LONG";
  else if (distPct > 0.5) direction = "SHORT";

  const absDist = Math.abs(distPct);
  let points = 0;
  if (absDist >= 2 && absDist <= 3) points = 30;
  else if (absDist >= 1 && absDist < 2) points = 20;
  else if (absDist >= 0.5 && absDist < 1) points = 10;
  else if (absDist > 3) points = 15;
  else points = 0;

  return { vwap, distPct, points, direction };
}

// ─── Score a bar with SmartScorer ───

interface SmartBarScore {
  score: number;
  direction: Direction;
  allAgree: boolean;
  atrValue: number;
  ema21Value: number;
  frPts: number;
  divPts: number;
  vwapPts: number;
}

function scoreBarSmart(
  candles: Candle[], rsi: number[], atr: number[], ema21: number[],
  i: number, fundingRate: number,
): SmartBarScore {
  const zero: SmartBarScore = {
    score: 0, direction: "NEUTRAL", allAgree: false,
    atrValue: 0, ema21Value: 0, frPts: 0, divPts: 0, vwapPts: 0,
  };
  if (isNaN(atr[i]) || isNaN(ema21[i]) || atr[i] <= 0) return zero;

  const price = candles[i].close;
  const fr = scoreFundingRate(fundingRate);
  const div = detectDivergence(candles, rsi, i);
  const vwap = calcWeeklyVWAP(candles, i);
  const vwapScore = scoreVWAP(price, vwap);

  const rawScore = fr.points + div.points + vwapScore.points;

  const dirs = [fr.direction, div.direction, vwapScore.direction].filter(d => d !== "NEUTRAL");
  const longC = dirs.filter(d => d === "LONG").length;
  const shortC = dirs.filter(d => d === "SHORT").length;

  let allAgree = false;
  let finalDir: Direction = "NEUTRAL";

  if (dirs.length === 0) {
    finalDir = "NEUTRAL";
  } else if (longC > 0 && shortC === 0) {
    allAgree = true;
    finalDir = "LONG";
  } else if (shortC > 0 && longC === 0) {
    allAgree = true;
    finalDir = "SHORT";
  } else {
    allAgree = false;
    finalDir = longC >= shortC ? "LONG" : "SHORT";
  }

  const score = allAgree ? Math.max(0, rawScore) : Math.min(60, Math.max(0, rawScore));

  return {
    score,
    direction: score > 0 ? finalDir : "NEUTRAL",
    allAgree,
    atrValue: atr[i],
    ema21Value: ema21[i],
    frPts: fr.points,
    divPts: div.points,
    vwapPts: vwapScore.points,
  };
}

// ─── Entry zone ───

function calcEntryZone(price: number, ema21: number, atr: number, dir: Direction) {
  const dist = Math.abs(price - ema21);
  if (dist <= 0.3 * atr) return { ideal: ema21, latest: price, type: "pullback" as const };
  if (dist <= 1.0 * atr) return { ideal: price, latest: price, type: "momentum" as const };
  const lp = dir === "LONG" ? ema21 + 1.0 * atr : ema21 - 1.0 * atr;
  return { ideal: ema21, latest: lp, type: "late" as const };
}

// ─── Config ───

const CFG = {
  scoreThreshold: 75,
  scoreCancelThreshold: 50,
  riskPerTrade: 0.015,
  maxOpenPositions: 1,
  expiryBars: 2,
  timeoutBars: 48,
  idealZoneTolerance: 0.001,
  cooldownBars: 2,
  atrSlMult: 1.5,
  atrTp1Mult: 2.25,
  atrTp2Mult: 4.5,
  tp1PartialPct: 0.5,
};

// ─── Backtest types ───

interface ActiveSignal {
  symbol: string; barIndex: number; score: number; direction: Direction;
  entryIdeal: number; entryLatest: number; sl: number; tp1: number; tp2: number;
  barsWaiting: number;
}

interface OpenPosition {
  symbol: string; entryBarIndex: number;
  entryPrice: number; direction: Direction;
  sl: number; tp1: number; tp2: number;
  qty: number; tp1Hit: boolean; remainingQty: number; barsInTrade: number;
}

interface PairStats {
  signalsF1: number; entriesF2: number;
  tp1: number; tp2: number; sl: number; timeout: number;
  expired: number; escaped: number; cancelled: number;
  grossProfit: number; grossLoss: number;
  conflicted: number;
}

const PAIRS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "TONUSDT"];

// ─── Main ───

async function main() {
  console.log("═══════════════════════════════════════════════════════════════════════");
  console.log("  SMART SCORER v2 BACKTEST");
  console.log("  FR (35pts) + RSI Divergencia (35pts) + VWAP Semanal (30pts)");
  console.log("  5 pares × 2 anos × 1H — Capital: $1,000");
  console.log("═══════════════════════════════════════════════════════════════════════\n");

  console.log("  Parametros:");
  console.log(`  Score threshold: ${CFG.scoreThreshold} | Max pos: ${CFG.maxOpenPositions}`);
  console.log(`  SL: ${CFG.atrSlMult}x ATR | TP1: ${CFG.atrTp1Mult}x | TP2: ${CFG.atrTp2Mult}x`);
  console.log(`  Riesgo: ${(CFG.riskPerTrade * 100).toFixed(1)}% | TP1 parcial: ${(CFG.tp1PartialPct * 100)}%\n`);

  // 1. Download candles
  const allCandles = new Map<string, Candle[]>();
  const targetCount = 17520;

  for (const sym of PAIRS) {
    process.stdout.write(`  Descargando velas ${sym}...`);
    const candles = await loadCandles(sym, "1h", targetCount);
    allCandles.set(sym, candles);
    const d0 = new Date(candles[0].time * 1000).toISOString().slice(0, 10);
    const d1 = new Date(candles[candles.length - 1].time * 1000).toISOString().slice(0, 10);
    console.log(` ${candles.length} barras (${d0} → ${d1})`);
  }

  // 2. Download funding rate history
  const allFR = new Map<string, FundingEntry[]>();
  const firstCandles = allCandles.get(PAIRS[0])!;
  const startMs = firstCandles[0].time * 1000;
  const endMs = firstCandles[firstCandles.length - 1].time * 1000;

  for (const sym of PAIRS) {
    process.stdout.write(`  Descargando FR ${sym}...`);
    const fr = await fetchFundingRateHistory(sym, startMs, endMs);
    allFR.set(sym, fr);
    console.log(` ${fr.length} registros`);
  }

  console.log("\n  Ejecutando backtest SmartScorer v2...\n");

  // 3. Precompute indicators
  const allRSI = new Map<string, number[]>();
  const allATR = new Map<string, number[]>();
  const allEMA21 = new Map<string, number[]>();
  const allEMA55 = new Map<string, number[]>();

  for (const [sym, candles] of allCandles) {
    const closes = candles.map(c => c.close);
    allRSI.set(sym, calcRSI(closes));
    allATR.set(sym, calcATR(candles));
    allEMA21.set(sym, calcEMA(closes, 21));
    allEMA55.set(sym, calcEMA(closes, 55));
  }

  // 4. Run backtest
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
      conflicted: 0,
    });
  }

  let totalTradesClosed = 0;
  let totalWins = 0;

  for (let i = minStart; i < totalBars; i++) {
    // 1. Manage open positions
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
          exitReason = pos.tp1Hit ? "BE" : "SL";
        } else if (!pos.tp1Hit && c.high >= pos.tp1) {
          const partialQty = pos.qty * CFG.tp1PartialPct;
          const pnl = (pos.tp1 - pos.entryPrice) * partialQty;
          capital += pnl;
          if (pnl > 0) st.grossProfit += pnl; else st.grossLoss += Math.abs(pnl);
          pos.tp1Hit = true;
          pos.remainingQty = pos.qty - partialQty;
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
          exitReason = pos.tp1Hit ? "BE" : "SL";
        } else if (!pos.tp1Hit && c.low <= pos.tp1) {
          const partialQty = pos.qty * CFG.tp1PartialPct;
          const pnl = (pos.entryPrice - pos.tp1) * partialQty;
          capital += pnl;
          if (pnl > 0) st.grossProfit += pnl; else st.grossLoss += Math.abs(pnl);
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

      if (!exitPrice && pos.barsInTrade >= CFG.timeoutBars) {
        exitPrice = c.close;
        exitReason = "Timeout";
        st.timeout++;
      }

      if (exitPrice !== null) {
        const pnlPU = pos.direction === "LONG"
          ? exitPrice - pos.entryPrice
          : pos.entryPrice - exitPrice;
        const pnl = pnlPU * pos.remainingQty;
        capital += pnl;
        if (pnl > 0) st.grossProfit += pnl; else st.grossLoss += Math.abs(pnl);
        if (exitReason === "SL") st.sl++;
        if (pos.tp1Hit || pnl > 0) totalWins++;
        totalTradesClosed++;
        openPositions.delete(sym);
      }
    }

    // 2. Check waiting signals
    for (const [sym, active] of activeSignals) {
      const candles = allCandles.get(sym)!;
      if (i >= candles.length) { activeSignals.delete(sym); continue; }
      const c = candles[i];
      const st = stats.get(sym)!;
      active.barsWaiting++;

      // Score cancellation
      const fr = findFundingRate(allFR.get(sym)!, candles[i].time);
      const cur = scoreBarSmart(candles, allRSI.get(sym)!, allATR.get(sym)!, allEMA21.get(sym)!, i, fr);
      if (cur.score < CFG.scoreCancelThreshold) {
        activeSignals.delete(sym); st.cancelled++; continue;
      }

      // Ideal zone reached
      const reached = active.direction === "LONG"
        ? c.low <= active.entryIdeal * (1 + CFG.idealZoneTolerance)
        : c.high >= active.entryIdeal * (1 - CFG.idealZoneTolerance);

      if (reached && openPositions.size < CFG.maxOpenPositions && !openPositions.has(sym)) {
        const ep = active.entryIdeal;
        const slDist = Math.abs(ep - active.sl);
        const riskAmt = capital * CFG.riskPerTrade;
        const qty = slDist > 0 ? riskAmt / slDist : 0;
        if (qty > 0) {
          openPositions.set(sym, {
            symbol: sym, entryBarIndex: i,
            entryPrice: ep, direction: active.direction,
            sl: active.sl, tp1: active.tp1, tp2: active.tp2,
            qty, tp1Hit: false, remainingQty: qty, barsInTrade: 0,
          });
          st.entriesF2++;
        }
        activeSignals.delete(sym);
        continue;
      }

      // Escaped
      const esc = active.direction === "LONG"
        ? c.high > active.entryLatest
        : c.low < active.entryLatest;
      if (esc) { activeSignals.delete(sym); st.escaped++; continue; }

      // Expired
      if (active.barsWaiting >= CFG.expiryBars) { activeSignals.delete(sym); st.expired++; continue; }
    }

    // 3. Scan for new signals
    for (const sym of PAIRS) {
      if (activeSignals.has(sym) || openPositions.has(sym)) continue;
      const lastBar = lastSignalBar.get(sym) ?? -999;
      if (i - lastBar < CFG.cooldownBars) continue;

      const candles = allCandles.get(sym)!;
      if (i >= candles.length) continue;

      const fr = findFundingRate(allFR.get(sym)!, candles[i].time);
      const bs = scoreBarSmart(
        candles, allRSI.get(sym)!, allATR.get(sym)!, allEMA21.get(sym)!, i, fr,
      );

      if (bs.score < CFG.scoreThreshold || bs.direction === "NEUTRAL") continue;
      if (bs.atrValue <= 0) continue;

      // Trend filter: price vs EMA55
      const ema55v = allEMA55.get(sym)![i];
      if (!isNaN(ema55v)) {
        const price = candles[i].close;
        if (bs.direction === "LONG" && price <= ema55v) continue;
        if (bs.direction === "SHORT" && price >= ema55v) continue;
      }

      if (!bs.allAgree) {
        stats.get(sym)!.conflicted++;
        continue;
      }

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
            symbol: sym, entryBarIndex: i,
            entryPrice: price, direction: bs.direction,
            sl, tp1, tp2, qty,
            tp1Hit: false, remainingQty: qty, barsInTrade: 0,
          });
          st.entriesF2++;
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
    const lastP = candles[candles.length - 1].close;
    const pnl = (pos.direction === "LONG" ? lastP - pos.entryPrice : pos.entryPrice - lastP) * pos.remainingQty;
    capital += pnl;
    const st = stats.get(sym)!;
    if (pnl > 0) st.grossProfit += pnl; else st.grossLoss += Math.abs(pnl);
    totalTradesClosed++;
    if (pnl > 0) totalWins++;
  }

  // ─── Print results ───

  console.log("═════════════════════════════════════════════════════════════════════════════════════════════════════════");
  console.log("  RESULTADOS POR PAR — SmartScorer v2");
  console.log("═════════════════════════════════════════════════════════════════════════════════════════════════════════");

  const hdr = [
    "Par".padEnd(8), "F1".padStart(5), "F2".padStart(5), "%Zona".padStart(6),
    "TP1".padStart(5), "TP2".padStart(5), "SL".padStart(5), "T.Out".padStart(5),
    "Expir".padStart(5), "Escap".padStart(5), "Canc.".padStart(5), "Confl".padStart(5),
    "WR%".padStart(7), "PF".padStart(7), "P&L".padStart(10), "Ret%".padStart(8),
  ].join(" | ");
  console.log(hdr);
  console.log("-".repeat(hdr.length));

  let totalF1 = 0, totalF2 = 0;
  let globalGP = 0, globalGL = 0;
  let bestPair = "", bestRet = -Infinity, worstPair = "", worstRet = Infinity;

  for (const sym of PAIRS) {
    const st = stats.get(sym)!;
    totalF1 += st.signalsF1;
    totalF2 += st.entriesF2;
    globalGP += st.grossProfit;
    globalGL += st.grossLoss;

    const pctZ = st.signalsF1 > 0 ? (st.entriesF2 / st.signalsF1 * 100).toFixed(0) : "0";
    const wr = st.entriesF2 > 0 ? ((st.tp1 + st.tp2) / st.entriesF2 * 100).toFixed(1) : "0.0";
    const pf = st.grossLoss > 0 ? (st.grossProfit / st.grossLoss).toFixed(2) : st.grossProfit > 0 ? "999" : "0.00";
    const pnl = st.grossProfit - st.grossLoss;
    const ret = (pnl / 1000 * 100).toFixed(2);

    if (pnl > bestRet) { bestRet = pnl; bestPair = sym; }
    if (pnl < worstRet) { worstRet = pnl; worstPair = sym; }

    const row = [
      sym.replace("USDT", "").padEnd(8),
      String(st.signalsF1).padStart(5),
      String(st.entriesF2).padStart(5),
      (pctZ + "%").padStart(6),
      String(st.tp1).padStart(5),
      String(st.tp2).padStart(5),
      String(st.sl).padStart(5),
      String(st.timeout).padStart(5),
      String(st.expired).padStart(5),
      String(st.escaped).padStart(5),
      String(st.cancelled).padStart(5),
      String(st.conflicted).padStart(5),
      (wr + "%").padStart(7),
      pf.padStart(7),
      ((pnl >= 0 ? "+" : "") + "$" + pnl.toFixed(2)).padStart(10),
      (ret + "%").padStart(8),
    ].join(" | ");
    console.log(row);
  }

  console.log("-".repeat(hdr.length));

  // Global summary
  const totalWeeks = totalBars / (24 * 7);
  const totalReturn = ((capital - 1000) / 1000 * 100);
  const globalPF = globalGL > 0 ? globalGP / globalGL : Infinity;
  const globalWR = totalTradesClosed > 0 ? (totalWins / totalTradesClosed * 100) : 0;

  console.log("\n═══════════════════════════════════════════════════════════════════════");
  console.log("  RESUMEN GLOBAL — SmartScorer v2");
  console.log("═══════════════════════════════════════════════════════════════════════");
  console.log(`  Senales F1:          ${totalF1}`);
  console.log(`  Entradas F2:         ${totalF2}`);
  console.log(`  % llego a zona:      ${totalF1 > 0 ? (totalF2 / totalF1 * 100).toFixed(1) : 0}%`);
  console.log(`  Win Rate:            ${globalWR.toFixed(1)}%`);
  console.log(`  Profit Factor:       ${globalPF === Infinity ? "inf" : globalPF.toFixed(2)}`);
  console.log(`  Retorno:             ${totalReturn >= 0 ? "+" : ""}${totalReturn.toFixed(2)}% ($1,000 → $${capital.toFixed(2)})`);
  console.log(`  Max Drawdown:        ${maxDD.toFixed(2)}%`);
  console.log(`  Trades cerrados:     ${totalTradesClosed}`);
  console.log(`  Trades/semana:       ${(totalF2 / totalWeeks).toFixed(1)}`);
  console.log(`  Mejor par:           ${bestPair.replace("USDT", "")} (+$${bestRet.toFixed(2)})`);
  console.log(`  Peor par:            ${worstPair.replace("USDT", "")} ($${worstRet.toFixed(2)})`);

  // ─── Comparative vs Two-Phase Scorer v2 baseline ───
  // Two-Phase v2 results (5 pairs, from previous run):
  const v2 = {
    totalF1: 2838, totalF2: 925,
    globalWR: 39.5, globalPF: 0.95,
    totalReturn: -29.90, finalCapital: 700.97,
    maxDD: 43.91, tradesPerWeek: 8.9,
  };

  console.log("\n═══════════════════════════════════════════════════════════════════════");
  console.log("  COMPARATIVA: SmartScorer v2 vs Two-Phase Scorer v2 (5 pares)");
  console.log("═══════════════════════════════════════════════════════════════════════\n");

  const fmtPct = (n: number) => n >= 0 ? `+${n.toFixed(1)}%` : `${n.toFixed(1)}%`;
  const fmt = (n: number, dec = 2) => n >= 0 ? `+${n.toFixed(dec)}` : n.toFixed(dec);

  const cHdr = [
    "Metrica".padEnd(22), "TwoPhase v2".padStart(14), "Smart v2".padStart(14), "Cambio".padStart(14),
  ].join(" | ");
  console.log(cHdr);
  console.log("-".repeat(cHdr.length));

  const tpw = totalF2 / totalWeeks;

  const cRows: [string, string, string, string][] = [
    ["Senales F1", String(v2.totalF1), String(totalF1), fmt(totalF1 - v2.totalF1, 0)],
    ["Entradas F2", String(v2.totalF2), String(totalF2), fmt(totalF2 - v2.totalF2, 0)],
    ["Trades/semana", v2.tradesPerWeek.toFixed(1), tpw.toFixed(1), fmt(tpw - v2.tradesPerWeek)],
    ["Win Rate", `${v2.globalWR}%`, `${globalWR.toFixed(1)}%`, fmtPct(globalWR - v2.globalWR)],
    ["Profit Factor", v2.globalPF.toFixed(2), globalPF === Infinity ? "inf" : globalPF.toFixed(2), fmt(globalPF - v2.globalPF)],
    ["Retorno", `${v2.totalReturn}%`, `${totalReturn.toFixed(2)}%`, fmtPct(totalReturn - v2.totalReturn)],
    ["Capital final", `$${v2.finalCapital}`, `$${capital.toFixed(2)}`, `$${fmt(capital - v2.finalCapital)}`],
    ["Max Drawdown", `${v2.maxDD}%`, `${maxDD.toFixed(2)}%`, fmtPct(maxDD - v2.maxDD)],
  ];

  for (const [m, b, a, c] of cRows) {
    console.log([m.padEnd(22), b.padStart(14), a.padStart(14), c.padStart(14)].join(" | "));
  }

  console.log("-".repeat(cHdr.length));

  // Verdict
  console.log("\n═══════════════════════════════════════════════════════════════════════");
  console.log("  VEREDICTO");
  console.log("═══════════════════════════════════════════════════════════════════════");

  if (globalPF >= 1.2) {
    console.log(`  ✅ PF = ${globalPF.toFixed(2)} >= 1.2 — EDGE ROBUSTO ENCONTRADO`);
  } else if (globalPF >= 1.0) {
    console.log(`  🟡 PF = ${globalPF.toFixed(2)} — Edge marginal, mejorable`);
  } else {
    console.log(`  🔴 PF = ${globalPF.toFixed(2)} — Sin edge, necesita mas trabajo`);
  }

  if (totalReturn > 0) {
    console.log(`  💰 RENTABLE: $1,000 → $${capital.toFixed(2)}`);
  } else {
    console.log(`  📉 PERDIDA: $1,000 → $${capital.toFixed(2)}`);
  }

  const improved = globalPF > v2.globalPF;
  console.log(`  ${improved ? "↗️" : "↘️"} vs Two-Phase v2: PF ${v2.globalPF.toFixed(2)} → ${globalPF.toFixed(2)}`);

  console.log("═══════════════════════════════════════════════════════════════════════\n");
}

main().catch(console.error);
