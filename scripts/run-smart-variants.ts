/**
 * SmartScorer v2 — 4 Variants Backtest
 * A: 2/3 agree, threshold 75, FR contradiction -15pts
 * B: 3/3 agree, FR ±0.01%, VWAP 0.2%, threshold 65
 * C: 2/3 agree, FR ±0.01%, VWAP 0.3%, threshold 70
 * D: 1/3 agree, threshold 55, BTC EMA200 daily filter
 * Usage: npx tsx scripts/run-smart-variants.ts
 */

interface Candle {
  time: number; open: number; high: number; low: number; close: number; volume: number;
}
interface FundingEntry { time: number; rate: number; }

// ─── Binance REST ───
const BASE = "https://api.binance.com/api/v3";
const FAPI = "https://fapi.binance.com/fapi/v1";

async function fetchKlines(symbol: string, interval: string, limit = 1000): Promise<Candle[]> {
  const res = await fetch(`${BASE}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
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
  const res = await fetch(`${BASE}/klines?symbol=${symbol}&interval=${interval}&endTime=${endTimeMs - 1}&limit=${limit}`);
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
  return candles.sort((a, b) => a.time - b.time).filter((c) => {
    if (seen.has(c.time)) return false; seen.add(c.time); return true;
  });
}

async function fetchFRHistory(symbol: string, startMs: number, endMs: number): Promise<FundingEntry[]> {
  const all: FundingEntry[] = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const res = await fetch(`${FAPI}/fundingRate?symbol=${symbol}&startTime=${cursor}&endTime=${endMs}&limit=1000`);
    if (!res.ok) break;
    const data = (await res.json()) as { fundingRate: string; fundingTime: number }[];
    if (data.length === 0) break;
    for (const d of data) all.push({ time: Math.floor(d.fundingTime / 1000), rate: parseFloat(d.fundingRate) });
    cursor = data[data.length - 1].fundingTime + 1;
    await new Promise(r => setTimeout(r, 200));
  }
  return all.sort((a, b) => a.time - b.time);
}

function findFR(frH: FundingEntry[], barTs: number): number {
  for (let i = frH.length - 1; i >= 0; i--) { if (frH[i].time <= barTs) return frH[i].rate; }
  return 0;
}

// ─── Indicators ───
function calcEMA(closes: number[], p: number): number[] {
  const o = new Array(closes.length).fill(NaN);
  if (closes.length < p) return o;
  const k = 2 / (p + 1); let e = 0;
  for (let i = 0; i < p; i++) e += closes[i]; e /= p; o[p - 1] = e;
  for (let i = p; i < closes.length; i++) { e = closes[i] * k + e * (1 - k); o[i] = e; }
  return o;
}

function calcRSI(closes: number[], p = 14): number[] {
  const o = new Array(closes.length).fill(NaN);
  if (closes.length < p + 1) return o;
  let ag = 0, al = 0;
  for (let i = 1; i <= p; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) ag += d; else al += Math.abs(d); }
  ag /= p; al /= p;
  o[p] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = p + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (p - 1) + (d > 0 ? d : 0)) / p;
    al = (al * (p - 1) + (d < 0 ? Math.abs(d) : 0)) / p;
    o[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return o;
}

function calcATR(candles: Candle[], p = 14): number[] {
  const o = new Array(candles.length).fill(NaN);
  if (candles.length < p + 1) return o;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) trs.push(Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - candles[i - 1].close), Math.abs(candles[i].low - candles[i - 1].close)));
  let a = 0; for (let i = 0; i < p; i++) a += trs[i]; a /= p; o[p] = a;
  for (let i = p; i < trs.length; i++) { a = (a * (p - 1) + trs[i]) / p; o[i + 1] = a; }
  return o;
}

// ─── SmartScorer components ───
type Dir = "LONG" | "SHORT" | "NEUTRAL";

interface VariantConfig {
  label: string;
  scoreThreshold: number;
  minAgree: 1 | 2 | 3;
  frContraDeduction: number; // pts deducted when FR contradicts (variant A)
  frSignalThreshold: number; // abs value for FR to count as directional (0.0002 default, 0.0001 for B/C)
  vwapMinDist: number;       // minimum % distance for VWAP to score (0.5 default, 0.2 for B, 0.3 for C)
  useBtcEma200Filter: boolean;
}

const VARIANT_A: VariantConfig = {
  label: "A", scoreThreshold: 75, minAgree: 2,
  frContraDeduction: 15, frSignalThreshold: 0.0002,
  vwapMinDist: 0.5, useBtcEma200Filter: false,
};
const VARIANT_B: VariantConfig = {
  label: "B", scoreThreshold: 65, minAgree: 3,
  frContraDeduction: 0, frSignalThreshold: 0.0001,
  vwapMinDist: 0.2, useBtcEma200Filter: false,
};
const VARIANT_C: VariantConfig = {
  label: "C", scoreThreshold: 70, minAgree: 2,
  frContraDeduction: 0, frSignalThreshold: 0.0001,
  vwapMinDist: 0.3, useBtcEma200Filter: false,
};
const VARIANT_D: VariantConfig = {
  label: "D", scoreThreshold: 55, minAgree: 1,
  frContraDeduction: 0, frSignalThreshold: 0.0002,
  vwapMinDist: 0.5, useBtcEma200Filter: true,
};

// FR scoring
function scoreFR(fr: number, frThreshold: number): { pts: number; dir: Dir } {
  let dir: Dir = "NEUTRAL";
  if (fr < -frThreshold) dir = "LONG";
  else if (fr > frThreshold) dir = "SHORT";

  // LONG perspective
  let longPts: number;
  if (fr < -0.0002) longPts = 35;
  else if (fr < 0.0001) longPts = 15;
  else if (fr < 0.0005) longPts = 0;
  else longPts = -20;

  // SHORT perspective
  let shortPts: number;
  if (fr > 0.0005) shortPts = 35;
  else if (fr > -0.0001) shortPts = 15;
  else if (fr > -0.0002) shortPts = 0;
  else shortPts = -20;

  if (longPts >= shortPts) return { pts: longPts, dir: longPts > 0 ? "LONG" : dir };
  return { pts: shortPts, dir: shortPts > 0 ? "SHORT" : dir };
}

// RSI divergence
function scoreDiv(candles: Candle[], rsi: number[], i: number): { pts: number; dir: Dir; type: string } {
  if (i < 20) return { pts: 0, dir: "NEUTRAL", type: "none" };
  for (const lb of [5, 8, 12, 16]) {
    const j = i - lb;
    if (j < 0 || isNaN(rsi[i]) || isNaN(rsi[j])) continue;
    if (candles[i].low < candles[j].low && rsi[i] > rsi[j]) return { pts: 35, dir: "LONG", type: "bullish" };
    if (candles[i].high > candles[j].high && rsi[i] < rsi[j]) return { pts: 35, dir: "SHORT", type: "bearish" };
  }
  for (const lb of [5, 8, 12, 16]) {
    const j = i - lb;
    if (j < 0 || isNaN(rsi[i]) || isNaN(rsi[j])) continue;
    if (candles[i].low > candles[j].low && rsi[i] < rsi[j]) return { pts: 20, dir: "LONG", type: "hidden_bull" };
    if (candles[i].high < candles[j].high && rsi[i] > rsi[j]) return { pts: 20, dir: "SHORT", type: "hidden_bear" };
  }
  return { pts: 0, dir: "NEUTRAL", type: "none" };
}

// Weekly VWAP
function calcVWAP(candles: Candle[], i: number): number {
  const d = new Date(candles[i].time * 1000);
  const dow = d.getUTCDay();
  const dsm = dow === 0 ? 6 : dow - 1;
  const ws = new Date(d); ws.setUTCHours(0, 0, 0, 0); ws.setUTCDate(ws.getUTCDate() - dsm);
  const wsTs = ws.getTime() / 1000;
  let spv = 0, sv = 0;
  for (let k = i; k >= 0; k--) {
    if (candles[k].time < wsTs) break;
    const tp = (candles[k].high + candles[k].low + candles[k].close) / 3;
    spv += tp * candles[k].volume; sv += candles[k].volume;
  }
  return sv > 0 ? spv / sv : candles[i].close;
}

function scoreVWAPFn(price: number, vwap: number, minDist: number): { pts: number; dir: Dir; distPct: number } {
  const distPct = ((price - vwap) / vwap) * 100;
  let dir: Dir = "NEUTRAL";
  if (distPct < -minDist) dir = "LONG";
  else if (distPct > minDist) dir = "SHORT";

  const absDist = Math.abs(distPct);
  let pts = 0;
  if (absDist >= 2 && absDist <= 3) pts = 30;
  else if (absDist >= 1 && absDist < 2) pts = 20;
  else if (absDist >= minDist && absDist < 1) pts = 10;
  else if (absDist > 3) pts = 15;
  return { pts, dir, distPct };
}

// ─── Score a bar with variant config ───
interface BarScore {
  score: number; direction: Dir; atrValue: number; ema21Value: number;
  frPts: number; divPts: number; vwapPts: number;
}

function scoreBar(
  candles: Candle[], rsi: number[], atr: number[], ema21: number[],
  i: number, fr: number, cfg: VariantConfig,
  // For variant D: BTC EMA200 filter
  btcEma200Dir?: Dir,
): BarScore {
  const zero: BarScore = { score: 0, direction: "NEUTRAL", atrValue: 0, ema21Value: 0, frPts: 0, divPts: 0, vwapPts: 0 };
  if (isNaN(atr[i]) || isNaN(ema21[i]) || atr[i] <= 0) return zero;

  const price = candles[i].close;
  const frR = scoreFR(fr, cfg.frSignalThreshold);
  const divR = scoreDiv(candles, rsi, i);
  const vwap = calcVWAP(candles, i);
  const vwapR = scoreVWAPFn(price, vwap, cfg.vwapMinDist);

  // Count directional agreement
  const dirs = [frR.dir, divR.dir, vwapR.dir].filter(d => d !== "NEUTRAL");
  const lc = dirs.filter(d => d === "LONG").length;
  const sc = dirs.filter(d => d === "SHORT").length;

  let finalDir: Dir = "NEUTRAL";
  let agreeCount = 0;

  if (dirs.length === 0) {
    return zero;
  } else if (lc > 0 && sc === 0) {
    finalDir = "LONG"; agreeCount = lc;
  } else if (sc > 0 && lc === 0) {
    finalDir = "SHORT"; agreeCount = sc;
  } else {
    // Mixed: determine majority
    finalDir = lc >= sc ? "LONG" : "SHORT";
    agreeCount = Math.max(lc, sc);
  }

  // Check minimum agreement
  if (agreeCount < cfg.minAgree) return zero;

  // Calculate raw score
  let rawScore = frR.pts + divR.pts + vwapR.pts;

  // Variant A: FR contradiction deducts points but doesn't block
  if (cfg.frContraDeduction > 0 && frR.dir !== "NEUTRAL" && frR.dir !== finalDir) {
    rawScore -= cfg.frContraDeduction;
  }

  // Variant D: BTC EMA200 filter
  if (cfg.useBtcEma200Filter && btcEma200Dir) {
    if (btcEma200Dir !== finalDir) return zero;
  }

  const score = Math.max(0, rawScore);
  if (score < cfg.scoreThreshold) return zero;

  return {
    score, direction: finalDir,
    atrValue: atr[i], ema21Value: ema21[i],
    frPts: frR.pts, divPts: divR.pts, vwapPts: vwapR.pts,
  };
}

// ─── Entry zone ───
function calcEntryZone(price: number, ema21: number, atr: number, dir: Dir) {
  const dist = Math.abs(price - ema21);
  if (dist <= 0.3 * atr) return { ideal: ema21, latest: price, type: "pullback" as const };
  if (dist <= 1.0 * atr) return { ideal: price, latest: price, type: "momentum" as const };
  const lp = dir === "LONG" ? ema21 + 1.0 * atr : ema21 - 1.0 * atr;
  return { ideal: ema21, latest: lp, type: "late" as const };
}

// ─── Trade config ───
const TRADE = {
  scoreCancelThreshold: 40,
  riskPerTrade: 0.015,
  maxOpenPositions: 1,
  expiryBars: 2,
  timeoutBars: 48,
  idealZoneTol: 0.001,
  cooldownBars: 2,
  atrSlMult: 1.5,
  atrTp1Mult: 2.25,
  atrTp2Mult: 4.5,
  tp1Pct: 0.5,
};

// ─── Backtest runner ───
interface ActiveSig {
  sym: string; bar: number; score: number; dir: Dir;
  idealEntry: number; latestEntry: number; sl: number; tp1: number; tp2: number;
  waiting: number;
}
interface OpenPos {
  sym: string; entryBar: number; entryPrice: number; dir: Dir;
  sl: number; tp1: number; tp2: number;
  qty: number; tp1Hit: boolean; remQty: number; bars: number;
}
interface PairStat {
  f1: number; f2: number;
  tp1: number; tp2: number; sl: number; tout: number;
  expired: number; escaped: number; cancelled: number;
  gp: number; gl: number;
}
interface RunResult {
  label: string; totalF1: number; totalF2: number;
  wr: number; pf: number; ret: number; capital: number;
  dd: number; tpw: number; closed: number;
}

const PAIRS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "TONUSDT"];

function runVariant(
  cfg: VariantConfig,
  allCandles: Map<string, Candle[]>,
  allRSI: Map<string, number[]>,
  allATR: Map<string, number[]>,
  allEMA21: Map<string, number[]>,
  allEMA55: Map<string, number[]>,
  allFR: Map<string, FundingEntry[]>,
  btcEma200: number[], // for variant D
  btcCandles: Candle[], // for variant D direction
): RunResult {
  const totalBars = allCandles.get(PAIRS[0])!.length;
  const minStart = 60;

  let capital = 1000, peak = 1000, maxDD = 0;
  const activeSigs = new Map<string, ActiveSig>();
  const openPos = new Map<string, OpenPos>();
  const lastSigBar = new Map<string, number>();
  const stats = new Map<string, PairStat>();
  for (const s of PAIRS) stats.set(s, { f1: 0, f2: 0, tp1: 0, tp2: 0, sl: 0, tout: 0, expired: 0, escaped: 0, cancelled: 0, gp: 0, gl: 0 });

  let closed = 0, wins = 0;

  for (let i = minStart; i < totalBars; i++) {
    // Determine BTC EMA200 direction for variant D
    let btcE200Dir: Dir = "NEUTRAL";
    if (cfg.useBtcEma200Filter && !isNaN(btcEma200[i])) {
      btcE200Dir = btcCandles[i].close > btcEma200[i] ? "LONG" : "SHORT";
    }

    // 1. Manage positions
    for (const [sym, pos] of openPos) {
      const c = allCandles.get(sym)!;
      if (i >= c.length) continue;
      const bar = c[i]; const st = stats.get(sym)!;
      pos.bars++;
      let ep: number | null = null, er = "";

      if (pos.dir === "LONG") {
        if (bar.low <= pos.sl) { ep = pos.sl; er = pos.tp1Hit ? "BE" : "SL"; }
        else if (!pos.tp1Hit && bar.high >= pos.tp1) {
          const pq = pos.qty * TRADE.tp1Pct;
          const pnl = (pos.tp1 - pos.entryPrice) * pq;
          capital += pnl; if (pnl > 0) st.gp += pnl; else st.gl += Math.abs(pnl);
          pos.tp1Hit = true; pos.remQty = pos.qty - pq; pos.sl = pos.entryPrice; st.tp1++;
        } else if (pos.tp1Hit && bar.high >= pos.tp2) { ep = pos.tp2; er = "TP2"; st.tp2++; }
      } else {
        if (bar.high >= pos.sl) { ep = pos.sl; er = pos.tp1Hit ? "BE" : "SL"; }
        else if (!pos.tp1Hit && bar.low <= pos.tp1) {
          const pq = pos.qty * TRADE.tp1Pct;
          const pnl = (pos.entryPrice - pos.tp1) * pq;
          capital += pnl; if (pnl > 0) st.gp += pnl; else st.gl += Math.abs(pnl);
          pos.tp1Hit = true; pos.remQty = pos.qty - pq; pos.sl = pos.entryPrice; st.tp1++;
        } else if (pos.tp1Hit && bar.low <= pos.tp2) { ep = pos.tp2; er = "TP2"; st.tp2++; }
      }

      if (!ep && pos.bars >= TRADE.timeoutBars) { ep = bar.close; er = "Tout"; st.tout++; }

      if (ep !== null) {
        const pu = pos.dir === "LONG" ? ep - pos.entryPrice : pos.entryPrice - ep;
        const pnl = pu * pos.remQty;
        capital += pnl; if (pnl > 0) st.gp += pnl; else st.gl += Math.abs(pnl);
        if (er === "SL" || er === "BE") st.sl++;
        if (pos.tp1Hit || pnl > 0) wins++;
        closed++; openPos.delete(sym);
      }
    }

    // 2. Check waiting signals
    for (const [sym, sig] of activeSigs) {
      const c = allCandles.get(sym)!;
      if (i >= c.length) { activeSigs.delete(sym); continue; }
      const bar = c[i]; const st = stats.get(sym)!;
      sig.waiting++;

      // Cancel check
      const fr = findFR(allFR.get(sym)!, c[i].time);
      const cur = scoreBar(c, allRSI.get(sym)!, allATR.get(sym)!, allEMA21.get(sym)!, i, fr, cfg, btcE200Dir);
      if (cur.score < TRADE.scoreCancelThreshold) { activeSigs.delete(sym); st.cancelled++; continue; }

      const reached = sig.dir === "LONG"
        ? bar.low <= sig.idealEntry * (1 + TRADE.idealZoneTol)
        : bar.high >= sig.idealEntry * (1 - TRADE.idealZoneTol);

      if (reached && openPos.size < TRADE.maxOpenPositions && !openPos.has(sym)) {
        const slD = Math.abs(sig.idealEntry - sig.sl);
        const qty = slD > 0 ? (capital * TRADE.riskPerTrade) / slD : 0;
        if (qty > 0) {
          openPos.set(sym, { sym, entryBar: i, entryPrice: sig.idealEntry, dir: sig.dir, sl: sig.sl, tp1: sig.tp1, tp2: sig.tp2, qty, tp1Hit: false, remQty: qty, bars: 0 });
          st.f2++;
        }
        activeSigs.delete(sym); continue;
      }

      const esc = sig.dir === "LONG" ? bar.high > sig.latestEntry : bar.low < sig.latestEntry;
      if (esc) { activeSigs.delete(sym); st.escaped++; continue; }
      if (sig.waiting >= TRADE.expiryBars) { activeSigs.delete(sym); st.expired++; continue; }
    }

    // 3. New signals
    for (const sym of PAIRS) {
      if (activeSigs.has(sym) || openPos.has(sym)) continue;
      const lb = lastSigBar.get(sym) ?? -999;
      if (i - lb < TRADE.cooldownBars) continue;
      const c = allCandles.get(sym)!;
      if (i >= c.length) continue;

      const fr = findFR(allFR.get(sym)!, c[i].time);
      const bs = scoreBar(c, allRSI.get(sym)!, allATR.get(sym)!, allEMA21.get(sym)!, i, fr, cfg, btcE200Dir);
      if (bs.score < cfg.scoreThreshold || bs.direction === "NEUTRAL") continue;

      // Trend filter EMA55
      const e55 = allEMA55.get(sym)![i];
      if (!isNaN(e55)) {
        if (bs.direction === "LONG" && c[i].close <= e55) continue;
        if (bs.direction === "SHORT" && c[i].close >= e55) continue;
      }

      const st = stats.get(sym)!;
      const price = c[i].close;
      const atr = bs.atrValue;
      const zone = calcEntryZone(price, bs.ema21Value, atr, bs.direction);

      let adj = bs.score;
      if (zone.type === "late") adj = Math.round(adj * 0.8);
      if (adj < cfg.scoreThreshold) continue;

      let sl: number, tp1: number, tp2: number;
      if (bs.direction === "LONG") {
        sl = price - TRADE.atrSlMult * atr; tp1 = price + TRADE.atrTp1Mult * atr; tp2 = price + TRADE.atrTp2Mult * atr;
      } else {
        sl = price + TRADE.atrSlMult * atr; tp1 = price - TRADE.atrTp1Mult * atr; tp2 = price - TRADE.atrTp2Mult * atr;
      }

      st.f1++; lastSigBar.set(sym, i);

      if (zone.type === "momentum" && openPos.size < TRADE.maxOpenPositions) {
        const slD = Math.abs(price - sl);
        const qty = slD > 0 ? (capital * TRADE.riskPerTrade) / slD : 0;
        if (qty > 0) {
          openPos.set(sym, { sym, entryBar: i, entryPrice: price, dir: bs.direction, sl, tp1, tp2, qty, tp1Hit: false, remQty: qty, bars: 0 });
          st.f2++;
        }
      } else if (zone.type !== "momentum") {
        activeSigs.set(sym, { sym, bar: i, score: adj, dir: bs.direction, idealEntry: zone.ideal, latestEntry: zone.latest, sl, tp1, tp2, waiting: 0 });
      }
    }

    if (capital > peak) peak = capital;
    const dd = peak > 0 ? ((peak - capital) / peak) * 100 : 0;
    if (dd > maxDD) maxDD = dd;
  }

  // Close remaining
  for (const [sym, pos] of openPos) {
    const c = allCandles.get(sym)!;
    const lp = c[c.length - 1].close;
    const pnl = (pos.dir === "LONG" ? lp - pos.entryPrice : pos.entryPrice - lp) * pos.remQty;
    capital += pnl; const st = stats.get(sym)!;
    if (pnl > 0) st.gp += pnl; else st.gl += Math.abs(pnl);
    closed++; if (pnl > 0) wins++;
  }

  let tF1 = 0, tF2 = 0, gp = 0, gl = 0;
  for (const sym of PAIRS) {
    const st = stats.get(sym)!;
    tF1 += st.f1; tF2 += st.f2; gp += st.gp; gl += st.gl;
  }

  const weeks = totalBars / (24 * 7);
  return {
    label: cfg.label,
    totalF1: tF1, totalF2: tF2,
    wr: closed > 0 ? (wins / closed) * 100 : 0,
    pf: gl > 0 ? gp / gl : gp > 0 ? Infinity : 0,
    ret: ((capital - 1000) / 1000) * 100,
    capital,
    dd: maxDD,
    tpw: tF2 / weeks,
    closed,
  };
}

// ─── Main ───
async function main() {
  console.log("═══════════════════════════════════════════════════════════════════════");
  console.log("  SMART SCORER v2 — 4 VARIANTES");
  console.log("  5 pares × 2 anos × 1H — Capital: $1,000");
  console.log("  Objetivo: PF > 1.1 | Trades > 80 | DD < 20%");
  console.log("═══════════════════════════════════════════════════════════════════════\n");

  console.log("  VARIANTE A: 2/3 agree, threshold 75, FR contra -15pts");
  console.log("  VARIANTE B: 3/3 agree, FR ±0.01%, VWAP 0.2%, threshold 65");
  console.log("  VARIANTE C: 2/3 agree, FR ±0.01%, VWAP 0.3%, threshold 70");
  console.log("  VARIANTE D: 1/3 agree, threshold 55, BTC EMA200 filter\n");

  // Download candles
  const allCandles = new Map<string, Candle[]>();
  for (const sym of PAIRS) {
    process.stdout.write(`  Descargando velas ${sym}...`);
    const c = await loadCandles(sym, "1h", 17520);
    allCandles.set(sym, c);
    console.log(` ${c.length} barras`);
  }

  // Download BTC daily for EMA200 (variant D)
  process.stdout.write("  Descargando BTC diario (EMA200)...");
  const btcDaily = await loadCandles("BTCUSDT", "1d", 800);
  console.log(` ${btcDaily.length} barras`);

  // Download FR
  const allFR = new Map<string, FundingEntry[]>();
  const fc = allCandles.get(PAIRS[0])!;
  const startMs = fc[0].time * 1000;
  const endMs = fc[fc.length - 1].time * 1000;
  for (const sym of PAIRS) {
    process.stdout.write(`  Descargando FR ${sym}...`);
    const fr = await fetchFRHistory(sym, startMs, endMs);
    allFR.set(sym, fr);
    console.log(` ${fr.length} registros`);
  }

  // Precompute indicators
  const allRSI = new Map<string, number[]>();
  const allATR = new Map<string, number[]>();
  const allEMA21 = new Map<string, number[]>();
  const allEMA55 = new Map<string, number[]>();

  for (const [sym, c] of allCandles) {
    const closes = c.map(x => x.close);
    allRSI.set(sym, calcRSI(closes));
    allATR.set(sym, calcATR(c));
    allEMA21.set(sym, calcEMA(closes, 21));
    allEMA55.set(sym, calcEMA(closes, 55));
  }

  // BTC EMA200 on daily — map to hourly bars
  const btcDailyCloses = btcDaily.map(c => c.close);
  const btcDailyEma200 = calcEMA(btcDailyCloses, 200);

  // Build hourly EMA200 array by mapping each 1H bar to its daily EMA200
  const btcHourly = allCandles.get("BTCUSDT")!;
  const btcEma200Hourly = new Array(btcHourly.length).fill(NaN);
  for (let i = 0; i < btcHourly.length; i++) {
    const barTs = btcHourly[i].time;
    // Find matching daily bar
    for (let d = btcDaily.length - 1; d >= 0; d--) {
      if (btcDaily[d].time <= barTs) {
        btcEma200Hourly[i] = btcDailyEma200[d];
        break;
      }
    }
  }

  // Run all 4 variants
  const variants = [VARIANT_A, VARIANT_B, VARIANT_C, VARIANT_D];
  const results: RunResult[] = [];

  for (const v of variants) {
    process.stdout.write(`\n  Ejecutando variante ${v.label}...`);
    const r = runVariant(v, allCandles, allRSI, allATR, allEMA21, allEMA55, allFR, btcEma200Hourly, btcHourly);
    results.push(r);
    console.log(` done (${r.totalF1} senales, ${r.totalF2} trades)`);
  }

  // ─── Results table ───
  console.log("\n═══════════════════════════════════════════════════════════════════════════════════════════════════════");
  console.log("  RESULTADOS — 4 VARIANTES SmartScorer v2");
  console.log("═══════════════════════════════════════════════════════════════════════════════════════════════════════\n");

  const hdr = [
    "Variante".padEnd(10),
    "Senales".padStart(8),
    "Trades".padStart(7),
    "T/sem".padStart(6),
    "WR%".padStart(7),
    "PF".padStart(7),
    "Retorno%".padStart(10),
    "DD%".padStart(7),
    "Capital".padStart(10),
    "Veredicto".padStart(12),
  ].join(" | ");
  console.log(hdr);
  console.log("-".repeat(hdr.length));

  for (const r of results) {
    const pfStr = r.pf === Infinity ? "  inf" : r.pf.toFixed(2);
    let verdict = "";
    const passP = r.pf > 1.1;
    const passT = r.closed > 80;
    const passD = r.dd < 20;
    if (passP && passT && passD) verdict = "✅ OBJETIVO";
    else if (passP && passD) verdict = "🟡 pocos T";
    else if (passP) verdict = "🟡 DD alto";
    else verdict = "🔴 PF bajo";

    const row = [
      r.label.padEnd(10),
      String(r.totalF1).padStart(8),
      String(r.closed).padStart(7),
      r.tpw.toFixed(1).padStart(6),
      (r.wr.toFixed(1) + "%").padStart(7),
      pfStr.padStart(7),
      ((r.ret >= 0 ? "+" : "") + r.ret.toFixed(2) + "%").padStart(10),
      (r.dd.toFixed(1) + "%").padStart(7),
      ("$" + r.capital.toFixed(0)).padStart(10),
      verdict.padStart(12),
    ].join(" | ");
    console.log(row);
  }
  console.log("-".repeat(hdr.length));

  // ─── Baseline comparison ───
  console.log("\n  REFERENCIA (Two-Phase Scorer v2, 5 pares):");
  console.log("  Senales: 2838 | Trades: 925 | WR: 39.5% | PF: 0.95 | Ret: -29.9% | DD: 43.9%\n");

  // ─── Objective check ───
  console.log("═══════════════════════════════════════════════════════════════════════");
  console.log("  CHECK DE OBJETIVOS (PF > 1.1 | Trades > 80 | DD < 20%)");
  console.log("═══════════════════════════════════════════════════════════════════════\n");

  for (const r of results) {
    const p = r.pf > 1.1 ? "✅" : "❌";
    const t = r.closed > 80 ? "✅" : "❌";
    const d = r.dd < 20 ? "✅" : "❌";
    console.log(`  Variante ${r.label}: PF ${p} ${r.pf === Infinity ? "inf" : r.pf.toFixed(2)} | Trades ${t} ${r.closed} | DD ${d} ${r.dd.toFixed(1)}%`);
  }

  // Find best
  const best = results.reduce((a, b) => {
    const aScore = (a.pf > 1.1 ? 1 : 0) + (a.closed > 80 ? 1 : 0) + (a.dd < 20 ? 1 : 0);
    const bScore = (b.pf > 1.1 ? 1 : 0) + (b.closed > 80 ? 1 : 0) + (b.dd < 20 ? 1 : 0);
    if (bScore > aScore) return b;
    if (bScore === aScore && b.pf > a.pf) return b;
    return a;
  });

  console.log(`\n  Mejor variante: ${best.label} (PF: ${best.pf === Infinity ? "inf" : best.pf.toFixed(2)}, ${best.closed} trades, DD: ${best.dd.toFixed(1)}%)`);
  console.log("═══════════════════════════════════════════════════════════════════════\n");
}

main().catch(console.error);
