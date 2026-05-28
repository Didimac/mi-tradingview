/**
 * Backtest: 1000€ capital, 2 años, SmartScorer v2 con parámetros actualizados
 *
 * Parámetros actuales:
 *   - Umbral: 65 (antes 75)
 *   - EMA55: penalización soft -10% (antes bloqueo total)
 *   - BEAR regime: penalización -10% (antes -30%)
 *   - TP1/TP2 partial close: 50% en TP1, SL→breakeven, resto en TP2
 *   - Risk: 1.5% por trade
 *   - Pares: BTC + SOL + BNB
 *
 * Usage: npx tsx scripts/run-1000eur-2year.ts
 */

interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number; }
interface FundingEntry { time: number; rate: number; }

const BASE = "https://api.binance.com/api/v3";
const FAPI = "https://fapi.binance.com/fapi/v1";

async function fetchKlines(sym: string, iv: string, lim = 1000): Promise<Candle[]> {
  const r = await fetch(`${BASE}/klines?symbol=${sym}&interval=${iv}&limit=${lim}`);
  if (!r.ok) throw new Error(`klines ${r.status}`);
  return ((await r.json()) as unknown[][]).map(k => ({
    time: Math.floor((k[0] as number) / 1000),
    open: parseFloat(k[1] as string), high: parseFloat(k[2] as string),
    low: parseFloat(k[3] as string), close: parseFloat(k[4] as string),
    volume: parseFloat(k[5] as string),
  }));
}

async function fetchKlinesBefore(sym: string, iv: string, endMs: number, lim = 1000): Promise<Candle[]> {
  const r = await fetch(`${BASE}/klines?symbol=${sym}&interval=${iv}&endTime=${endMs - 1}&limit=${lim}`);
  if (!r.ok) throw new Error(`klines ${r.status}`);
  return ((await r.json()) as unknown[][]).map(k => ({
    time: Math.floor((k[0] as number) / 1000),
    open: parseFloat(k[1] as string), high: parseFloat(k[2] as string),
    low: parseFloat(k[3] as string), close: parseFloat(k[4] as string),
    volume: parseFloat(k[5] as string),
  }));
}

async function loadCandles(sym: string, iv: string, count: number): Promise<Candle[]> {
  let c = await fetchKlines(sym, iv, Math.min(count, 1000));
  while (c.length < count) {
    const o = c[0];
    const b = await fetchKlinesBefore(sym, iv, o.time * 1000, Math.min(count - c.length, 1000));
    if (!b.length) break;
    c = [...b, ...c];
    await new Promise(r => setTimeout(r, 200));
  }
  const seen = new Set<number>();
  return c.sort((a, b) => a.time - b.time).filter(x => { if (seen.has(x.time)) return false; seen.add(x.time); return true; });
}

async function fetchFRHistory(sym: string, startMs: number, endMs: number): Promise<FundingEntry[]> {
  const all: FundingEntry[] = [];
  let cur = startMs;
  while (cur < endMs) {
    const r = await fetch(`${FAPI}/fundingRate?symbol=${sym}&startTime=${cur}&endTime=${endMs}&limit=1000`);
    if (!r.ok) break;
    const d = (await r.json()) as { fundingRate: string; fundingTime: number }[];
    if (!d.length) break;
    for (const x of d) all.push({ time: Math.floor(x.fundingTime / 1000), rate: parseFloat(x.fundingRate) });
    cur = d[d.length - 1].fundingTime + 1;
    await new Promise(r => setTimeout(r, 200));
  }
  return all.sort((a, b) => a.time - b.time);
}

function findFR(h: FundingEntry[], ts: number): number {
  for (let i = h.length - 1; i >= 0; i--) if (h[i].time <= ts) return h[i].rate;
  return 0;
}

// ─── Indicators ───

function calcEMA(c: number[], p: number): number[] {
  const o = new Array(c.length).fill(NaN); if (c.length < p) return o;
  const k = 2 / (p + 1); let e = 0;
  for (let i = 0; i < p; i++) e += c[i]; e /= p; o[p - 1] = e;
  for (let i = p; i < c.length; i++) { e = c[i] * k + e * (1 - k); o[i] = e; }
  return o;
}

function calcRSI(c: number[], p = 14): number[] {
  const o = new Array(c.length).fill(NaN); if (c.length < p + 1) return o;
  let ag = 0, al = 0;
  for (let i = 1; i <= p; i++) { const d = c[i] - c[i - 1]; if (d > 0) ag += d; else al += Math.abs(d); }
  ag /= p; al /= p; o[p] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = p + 1; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    ag = (ag * (p - 1) + (d > 0 ? d : 0)) / p;
    al = (al * (p - 1) + (d < 0 ? Math.abs(d) : 0)) / p;
    o[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return o;
}

function calcATR(cs: Candle[], p = 14): number[] {
  const o = new Array(cs.length).fill(NaN); if (cs.length < p + 1) return o;
  const t: number[] = [];
  for (let i = 1; i < cs.length; i++) t.push(Math.max(cs[i].high - cs[i].low, Math.abs(cs[i].high - cs[i - 1].close), Math.abs(cs[i].low - cs[i - 1].close)));
  let a = 0; for (let i = 0; i < p; i++) a += t[i]; a /= p; o[p] = a;
  for (let i = p; i < t.length; i++) { a = (a * (p - 1) + t[i]) / p; o[i + 1] = a; }
  return o;
}

// ─── Scoring (matches production opportunityScorer.ts) ───

type Dir = "LONG" | "SHORT" | "NEUTRAL";

function scoreFR(fr: number): { pts: number; dir: Dir } {
  let dir: Dir = "NEUTRAL";
  if (fr < -0.0001) dir = "LONG"; else if (fr > 0.0001) dir = "SHORT";
  let lp = 0;
  if (fr < -0.0002) lp = 35; else if (fr < 0.0001) lp = 15; else if (fr < 0.0005) lp = 0; else lp = -20;
  let sp = 0;
  if (fr > 0.0005) sp = 35; else if (fr > -0.0001) sp = 15; else if (fr > -0.0002) sp = 0; else sp = -20;
  if (lp >= sp) return { pts: lp, dir: lp > 0 ? "LONG" : dir };
  return { pts: sp, dir: sp > 0 ? "SHORT" : dir };
}

function scoreDiv(cs: Candle[], rsi: number[], i: number): { pts: number; dir: Dir } {
  if (i < 20) return { pts: 0, dir: "NEUTRAL" };
  for (const lb of [5, 8, 12, 16]) {
    const j = i - lb; if (j < 0 || isNaN(rsi[i]) || isNaN(rsi[j])) continue;
    if (cs[i].low < cs[j].low && rsi[i] > rsi[j]) return { pts: 35, dir: "LONG" };
    if (cs[i].high > cs[j].high && rsi[i] < rsi[j]) return { pts: 35, dir: "SHORT" };
  }
  for (const lb of [5, 8, 12, 16]) {
    const j = i - lb; if (j < 0 || isNaN(rsi[i]) || isNaN(rsi[j])) continue;
    if (cs[i].low > cs[j].low && rsi[i] < rsi[j]) return { pts: 20, dir: "LONG" };
    if (cs[i].high < cs[j].high && rsi[i] > rsi[j]) return { pts: 20, dir: "SHORT" };
  }
  return { pts: 0, dir: "NEUTRAL" };
}

function calcVWAP(cs: Candle[], i: number): number {
  const d = new Date(cs[i].time * 1000); const dow = d.getUTCDay(); const dsm = dow === 0 ? 6 : dow - 1;
  const ws = new Date(d); ws.setUTCHours(0, 0, 0, 0); ws.setUTCDate(ws.getUTCDate() - dsm);
  const wst = ws.getTime() / 1000;
  let spv = 0, sv = 0;
  for (let k = i; k >= 0; k--) { if (cs[k].time < wst) break; const tp = (cs[k].high + cs[k].low + cs[k].close) / 3; spv += tp * cs[k].volume; sv += cs[k].volume; }
  return sv > 0 ? spv / sv : cs[i].close;
}

function scoreVWAP(price: number, vwap: number): { pts: number; dir: Dir } {
  const dp = ((price - vwap) / vwap) * 100;
  let dir: Dir = "NEUTRAL"; if (dp < -0.5) dir = "LONG"; else if (dp > 0.5) dir = "SHORT";
  const ad = Math.abs(dp); let pts = 0;
  if (ad >= 2 && ad <= 3) pts = 30; else if (ad >= 1 && ad < 2) pts = 20; else if (ad >= 0.5 && ad < 1) pts = 10; else if (ad > 3) pts = 15;
  return { pts, dir };
}

function calcBtcRegime(btcCandles: Candle[], i: number, ema200: number[]): "BULL" | "BEAR" {
  if (isNaN(ema200[i])) return "BULL";
  return btcCandles[i].close > ema200[i] ? "BULL" : "BEAR";
}

/**
 * Score a bar using the EQUILIBRADO logic:
 * - Threshold: 70
 * - EMA55: soft penalty -10% (not hard block)
 * - BEAR regime: -15% penalty
 */
function scoreBar(
  cs: Candle[], rsi: number[], atr: number[], ema21: number[], ema55: number[],
  i: number, fr: number, regime: "BULL" | "BEAR",
): { score: number; dir: Dir; atrV: number; ema21V: number } {
  const z = { score: 0, dir: "NEUTRAL" as Dir, atrV: 0, ema21V: 0 };
  if (isNaN(atr[i]) || isNaN(ema21[i]) || isNaN(ema55[i]) || atr[i] <= 0) return z;

  const price = cs[i].close;
  const frR = scoreFR(fr);
  const divR = scoreDiv(cs, rsi, i);
  const vwap = calcVWAP(cs, i);
  const vwapR = scoreVWAP(price, vwap);

  // Directional agreement (2 of 3 must agree)
  const dirs = [frR.dir, divR.dir, vwapR.dir].filter(d => d !== "NEUTRAL");
  const lc = dirs.filter(d => d === "LONG").length;
  const sc = dirs.filter(d => d === "SHORT").length;
  if (dirs.length === 0) return z;

  let finalDir: Dir, agree: number;
  if (lc > 0 && sc === 0) { finalDir = "LONG"; agree = lc; }
  else if (sc > 0 && lc === 0) { finalDir = "SHORT"; agree = sc; }
  else { finalDir = lc >= sc ? "LONG" : "SHORT"; agree = Math.max(lc, sc); }
  if (agree < 2) return z;

  // Raw score + FR contradiction
  let raw = frR.pts + divR.pts + vwapR.pts;
  if (frR.dir !== "NEUTRAL" && frR.dir !== finalDir) raw -= 15;
  let score = Math.max(0, raw);

  // EMA55 soft penalty (-10%) instead of hard block
  if ((finalDir === "LONG" && price <= ema55[i]) || (finalDir === "SHORT" && price >= ema55[i])) {
    score = Math.round(score * 0.9);
  }

  // BEAR regime penalty on LONGs (-15%)
  if (regime === "BEAR" && finalDir === "LONG") {
    score = Math.round(score * 0.85);
  }

  // Late entry penalty
  const dist = Math.abs(price - ema21[i]);
  if (dist > 1.0 * atr[i]) {
    score = Math.round(score * 0.8);
  }

  if (score < 70) return z;

  return { score, dir: finalDir, atrV: atr[i], ema21V: ema21[i] };
}

// ─── Config ───

const CFG = {
  risk: 0.015,      // 1.5% risk per trade
  maxPos: 1,         // max 1 position at a time
  timeout: 48,       // close after 48 bars (2 days)
  cd: 2,             // 2-bar cooldown between signals per pair
  slM: 1.5,          // ATR multiplier for SL
  tp1M: 2.25,        // ATR multiplier for TP1
  tp2M: 4.5,         // ATR multiplier for TP2
  tp1Pct: 0.5,       // close 50% at TP1
};

const PAIRS = ["BTCUSDT", "SOLUSDT", "BNBUSDT"];

interface Pos {
  sym: string; ep: number; dir: Dir; sl: number; tp1: number; tp2: number;
  qty: number; tp1Hit: boolean; rem: number; bars: number;
}

interface TradeLog {
  sym: string; dir: Dir; ep: number; exit: number; pnl: number; reason: string; date: string;
}

// ─── Main ───

async function main() {
  const START_CAPITAL = 1000;
  const BARS_2YEARS = 17520 + 200; // 2 years × 365 × 24h + warmup

  console.log("═══════════════════════════════════════════════════════════════════════════════");
  console.log("  SIMULACION: €1,000 — Ultimos 2 años — SmartScorer v2 (Params actualizados)");
  console.log("  Pares: BTC + SOL + BNB | Risk: 1.5% por trade");
  console.log("  Umbral: 70 | EMA55: soft -10% | BEAR penalty: -15%");
  console.log("═══════════════════════════════════════════════════════════════════════════════\n");

  // Load data
  const allC = new Map<string, Candle[]>();
  for (const sym of PAIRS) {
    process.stdout.write(`  Descargando ${sym} (1H)...`);
    const c = await loadCandles(sym, "1h", BARS_2YEARS);
    allC.set(sym, c);
    const startDate = new Date(c[0].time * 1000).toISOString().slice(0, 10);
    const endDate = new Date(c[c.length - 1].time * 1000).toISOString().slice(0, 10);
    console.log(` ${c.length} barras (${startDate} → ${endDate})`);
  }

  // Load BTC daily for regime
  process.stdout.write(`  Descargando BTC Daily...`);
  const btcDaily = await loadCandles("BTCUSDT", "1d", 900);
  console.log(` ${btcDaily.length} barras`);
  const btcDailyCloses = btcDaily.map(c => c.close);
  const btcEma200Daily = calcEMA(btcDailyCloses, 200);

  // Load funding rates
  const allFR = new Map<string, FundingEntry[]>();
  const fc = allC.get(PAIRS[0])!;
  const startMs = fc[0].time * 1000, endMs = fc[fc.length - 1].time * 1000;
  for (const sym of PAIRS) {
    process.stdout.write(`  Descargando FR ${sym}...`);
    const fr = await fetchFRHistory(sym, startMs, endMs);
    allFR.set(sym, fr);
    console.log(` ${fr.length} entries`);
  }

  // Compute indicators
  const allRSI = new Map<string, number[]>();
  const allATR = new Map<string, number[]>();
  const allE21 = new Map<string, number[]>();
  const allE55 = new Map<string, number[]>();
  for (const [sym, c] of allC) {
    const cl = c.map(x => x.close);
    allRSI.set(sym, calcRSI(cl));
    allATR.set(sym, calcATR(c));
    allE21.set(sym, calcEMA(cl, 21));
    allE55.set(sym, calcEMA(cl, 55));
  }

  console.log("\n  Ejecutando backtest...\n");

  // ─── Backtest loop ───

  let cap = START_CAPITAL, peak = START_CAPITAL, maxDD = 0;
  const pos = new Map<string, Pos>();
  const lastSig = new Map<string, number>();
  let closed = 0, wins = 0, losses = 0;
  let totalGP = 0, totalGL = 0;
  const trades: TradeLog[] = [];
  const capitalCurve: { bar: number; cap: number; date: string }[] = [];
  const monthlyPnL: Record<string, number> = {};

  const totalBars = fc.length;
  const startBar = 60;

  for (let i = startBar; i < totalBars; i++) {
    const barDate = new Date(fc[i].time * 1000);

    // Determine BTC regime from daily candles
    const barDateMs = fc[i].time * 1000;
    let regimeIdx = btcDaily.length - 1;
    for (let d = btcDaily.length - 1; d >= 0; d--) {
      if (btcDaily[d].time * 1000 <= barDateMs) { regimeIdx = d; break; }
    }
    const regime = calcBtcRegime(btcDaily, regimeIdx, btcEma200Daily);

    // Check open positions
    for (const [sym, p] of pos) {
      const c = allC.get(sym)!; if (i >= c.length) continue;
      const b = c[i]; p.bars++;
      let exitPrice: number | null = null, exitReason = "";

      if (p.dir === "LONG") {
        if (b.low <= p.sl) { exitPrice = p.sl; exitReason = p.tp1Hit ? "BE" : "SL"; }
        else if (!p.tp1Hit && b.high >= p.tp1) {
          // TP1 partial close: 50%
          const pq = p.qty * CFG.tp1Pct;
          const pnl = (p.tp1 - p.ep) * pq;
          cap += pnl;
          if (pnl > 0) totalGP += pnl; else totalGL += Math.abs(pnl);
          p.tp1Hit = true; p.rem = p.qty - pq; p.sl = p.ep; // SL → breakeven
        }
        else if (p.tp1Hit && b.high >= p.tp2) { exitPrice = p.tp2; exitReason = "TP2"; }
      } else {
        if (b.high >= p.sl) { exitPrice = p.sl; exitReason = p.tp1Hit ? "BE" : "SL"; }
        else if (!p.tp1Hit && b.low <= p.tp1) {
          const pq = p.qty * CFG.tp1Pct;
          const pnl = (p.ep - p.tp1) * pq;
          cap += pnl;
          if (pnl > 0) totalGP += pnl; else totalGL += Math.abs(pnl);
          p.tp1Hit = true; p.rem = p.qty - pq; p.sl = p.ep;
        }
        else if (p.tp1Hit && b.low <= p.tp2) { exitPrice = p.tp2; exitReason = "TP2"; }
      }
      if (!exitPrice && p.bars >= CFG.timeout) { exitPrice = b.close; exitReason = "Timeout"; }

      if (exitPrice !== null) {
        const pu = p.dir === "LONG" ? exitPrice - p.ep : p.ep - exitPrice;
        const pnl = pu * p.rem;
        cap += pnl;
        const totalPnl = pnl + (p.tp1Hit ? ((p.dir === "LONG" ? p.tp1 - p.ep : p.ep - p.tp1) * p.qty * CFG.tp1Pct) : 0);
        if (totalPnl > 0) { totalGP += Math.max(0, pnl); wins++; }
        else { totalGL += Math.abs(pnl); losses++; }
        closed++;
        const month = barDate.toISOString().slice(0, 7);
        monthlyPnL[month] = (monthlyPnL[month] || 0) + totalPnl;
        trades.push({
          sym: p.sym, dir: p.dir, ep: p.ep, exit: exitPrice, pnl: totalPnl,
          reason: exitReason, date: barDate.toISOString().slice(0, 10),
        });
        pos.delete(sym);
      }
    }

    // Generate new signals & enter directly on momentum
    for (const sym of PAIRS) {
      if (pos.has(sym) || pos.size >= CFG.maxPos) continue;
      const lb = lastSig.get(sym) ?? -999;
      if (i - lb < CFG.cd) continue;
      const c = allC.get(sym)!; if (i >= c.length) continue;

      const fr = findFR(allFR.get(sym)!, c[i].time);
      const bs = scoreBar(c, allRSI.get(sym)!, allATR.get(sym)!, allE21.get(sym)!, allE55.get(sym)!, i, fr, regime);
      if (bs.score < 70 || bs.dir === "NEUTRAL") continue;

      const price = c[i].close;
      const atr = bs.atrV;
      let sl: number, tp1: number, tp2: number;
      if (bs.dir === "LONG") {
        sl = price - CFG.slM * atr; tp1 = price + CFG.tp1M * atr; tp2 = price + CFG.tp2M * atr;
      } else {
        sl = price + CFG.slM * atr; tp1 = price - CFG.tp1M * atr; tp2 = price - CFG.tp2M * atr;
      }

      lastSig.set(sym, i);
      const sd = Math.abs(price - sl);
      const qty = sd > 0 ? (cap * CFG.risk) / sd : 0;
      if (qty > 0) {
        pos.set(sym, { sym, ep: price, dir: bs.dir, sl, tp1, tp2, qty, tp1Hit: false, rem: qty, bars: 0 });
      }
    }

    // Track drawdown
    if (cap > peak) peak = cap;
    const dd = peak > 0 ? ((peak - cap) / peak) * 100 : 0;
    if (dd > maxDD) maxDD = dd;

    // Weekly capital curve
    if (i % 168 === 0) {
      capitalCurve.push({ bar: i, cap, date: barDate.toISOString().slice(0, 10) });
    }
  }

  // Close remaining positions at market
  for (const [sym, p] of pos) {
    const c = allC.get(sym)!; const lp = c[c.length - 1].close;
    const pnl = (p.dir === "LONG" ? lp - p.ep : p.ep - lp) * p.rem;
    cap += pnl;
    if (pnl > 0) { totalGP += pnl; wins++; } else { totalGL += Math.abs(pnl); losses++; }
    closed++;
  }

  const ret = ((cap - START_CAPITAL) / START_CAPITAL) * 100;
  const pf = totalGL > 0 ? totalGP / totalGL : totalGP > 0 ? Infinity : 0;
  const avgWin = wins > 0 ? totalGP / wins : 0;
  const avgLoss = losses > 0 ? totalGL / losses : 0;

  // ─── Results ───

  console.log("═══════════════════════════════════════════════════════════════════════════════");
  console.log("  RESULTADOS — €1,000 en 2 años (parametros actualizados)");
  console.log("═══════════════════════════════════════════════════════════════════════════════\n");

  console.log(`  Capital inicial:     €1,000.00`);
  console.log(`  Capital final:       €${cap.toFixed(2)}`);
  console.log(`  Ganancia/Perdida:    €${(cap - START_CAPITAL).toFixed(2)} (${ret >= 0 ? "+" : ""}${ret.toFixed(2)}%)`);
  console.log(`  Max Drawdown:        ${maxDD.toFixed(1)}%`);
  console.log(`  ─────────────────────────────────────`);
  console.log(`  Total trades:        ${closed}`);
  console.log(`  Wins:                ${wins}`);
  console.log(`  Losses:              ${losses}`);
  console.log(`  Win Rate:            ${closed > 0 ? ((wins / closed) * 100).toFixed(1) : 0}%`);
  console.log(`  Profit Factor:       ${pf === Infinity ? "∞" : pf.toFixed(2)}`);
  console.log(`  Avg Win:             €${avgWin.toFixed(2)}`);
  console.log(`  Avg Loss:            €${avgLoss.toFixed(2)}`);
  console.log(`  Risk/Reward:         ${avgLoss > 0 ? (avgWin / avgLoss).toFixed(2) : "N/A"}`);
  console.log(`  ─────────────────────────────────────`);
  console.log(`  Ganancia bruta:      €${totalGP.toFixed(2)}`);
  console.log(`  Perdida bruta:       €${totalGL.toFixed(2)}`);
  console.log(`  Risk por trade:      1.5% (€${(START_CAPITAL * CFG.risk).toFixed(2)} inicial)`);

  // Monthly P&L
  const months = Object.keys(monthlyPnL).sort();
  if (months.length > 0) {
    console.log(`\n  ─────────────────────────────────────`);
    console.log(`  P&L MENSUAL:`);
    console.log(`  ─────────────────────────────────────`);
    for (const m of months) {
      const pnl = monthlyPnL[m];
      const bar = pnl >= 0
        ? "█".repeat(Math.min(30, Math.round(pnl / 5)))
        : "▓".repeat(Math.min(30, Math.round(Math.abs(pnl) / 5)));
      const sign = pnl >= 0 ? "+" : "";
      console.log(`  ${m}  ${pnl >= 0 ? "🟢" : "🔴"} ${sign}€${pnl.toFixed(2).padStart(8)} ${bar}`);
    }
  }

  // Trade detail (last 30)
  if (trades.length > 0) {
    console.log(`\n  ─────────────────────────────────────`);
    console.log(`  DETALLE DE TRADES (${trades.length > 30 ? "ultimos 30 de " : ""}${trades.length}):`);
    console.log(`  ─────────────────────────────────────`);
    const show = trades.length > 30 ? trades.slice(-30) : trades;
    for (const t of show) {
      const sym = t.sym.replace("USDT", "");
      const sign = t.pnl >= 0 ? "+" : "";
      const icon = t.pnl >= 0 ? "✅" : "❌";
      console.log(`  ${t.date} ${icon} ${t.dir.padEnd(5)} ${sym.padEnd(4)} | $${t.ep.toFixed(2).padStart(10)} → $${t.exit.toFixed(2).padStart(10)} | ${t.reason.padEnd(7)} | ${sign}€${t.pnl.toFixed(2)}`);
    }
  }

  // Capital curve
  console.log(`\n  ─────────────────────────────────────`);
  console.log(`  CURVA DE CAPITAL (mensual):`);
  console.log(`  ─────────────────────────────────────`);
  capitalCurve.push({ bar: totalBars, cap, date: new Date(fc[totalBars - 1].time * 1000).toISOString().slice(0, 10) });
  // Sample monthly
  const monthlyCurve = capitalCurve.filter((_, idx) => idx % 4 === 0 || idx === capitalCurve.length - 1);
  for (const p of monthlyCurve) {
    const pct = ((p.cap - START_CAPITAL) / START_CAPITAL) * 100;
    const barLen = Math.max(1, Math.round((p.cap / START_CAPITAL) * 20));
    const bar = p.cap >= START_CAPITAL ? "█".repeat(barLen) : "▓".repeat(barLen);
    console.log(`  ${p.date}  ${bar} €${p.cap.toFixed(2)} (${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%)`);
  }

  console.log("\n═══════════════════════════════════════════════════════════════════════════════\n");
}

main().catch(console.error);
