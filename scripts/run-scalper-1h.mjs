// Pulse Scalper 1H — Backtest runner (1H, top 10 pairs, 1 year)
const BASE = "https://api.binance.com/api/v3";

async function fetchKlines(symbol, interval, limit = 1000) {
  const res = await fetch(`${BASE}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
  if (!res.ok) throw new Error(`klines ${res.status}`);
  return (await res.json()).map(k => ({
    time: Math.floor(k[0] / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5],
  }));
}

async function loadCandles(symbol, tf, count) {
  let c = await fetchKlines(symbol, tf, Math.min(count, 1000));
  while (c.length < count) {
    const endTime = c[0].time * 1000 - 1;
    const b = await fetch(`${BASE}/klines?symbol=${symbol}&interval=${tf}&endTime=${endTime}&limit=${Math.min(count - c.length, 1000)}`);
    if (!b.ok) break;
    const d = (await b.json()).map(k => ({ time: Math.floor(k[0]/1000), open:+k[1], high:+k[2], low:+k[3], close:+k[4], volume:+k[5] }));
    if (!d.length) break;
    c = [...d, ...c];
  }
  const seen = new Set();
  return c.sort((a,b) => a.time-b.time).filter(x => { if (seen.has(x.time)) return false; seen.add(x.time); return true; });
}

// ── Indicators ──
function calcEMA(c, p) {
  const o = Array(c.length).fill(NaN); if (c.length < p) return o;
  const k = 2/(p+1); let e = c.slice(0,p).reduce((s,x)=>s+x.close,0)/p; o[p-1]=e;
  for (let i=p;i<c.length;i++) { e=c[i].close*k+e*(1-k); o[i]=e; } return o;
}
function calcRSI(c, p) {
  const o = Array(c.length).fill(NaN); if (c.length<p+1) return o;
  let ag=0,al=0;
  for (let i=1;i<=p;i++){const d=c[i].close-c[i-1].close; if(d>0)ag+=d;else al+=Math.abs(d);}
  ag/=p;al/=p; o[p]=100-100/(1+(al===0?100:ag/al));
  for(let i=p+1;i<c.length;i++){const d=c[i].close-c[i-1].close;ag=(ag*(p-1)+Math.max(d,0))/p;al=(al*(p-1)+Math.max(-d,0))/p;o[i]=100-100/(1+(al===0?100:ag/al));}
  return o;
}
function calcATR(c, p) {
  const o = Array(c.length).fill(NaN); if (c.length<p+1) return o;
  const t=c.slice(1).map((x,i)=>Math.max(x.high-x.low,Math.abs(x.high-c[i].close),Math.abs(x.low-c[i].close)));
  let a=t.slice(0,p).reduce((s,v)=>s+v,0)/p; o[p]=a;
  for(let i=p;i<t.length;i++){a=(a*(p-1)+t[i])/p;o[i+1]=a;} return o;
}
function calcVWAP(c) {
  const o = Array(c.length).fill(NaN);
  let cumPV=0, cumVol=0, curDay=-1;
  for(let i=0;i<c.length;i++){
    const d=new Date(c[i].time*1000);
    const dk=d.getUTCFullYear()*10000+(d.getUTCMonth()+1)*100+d.getUTCDate();
    if(dk!==curDay){cumPV=0;cumVol=0;curDay=dk;}
    const tp=(c[i].high+c[i].low+c[i].close)/3;
    cumPV+=tp*c[i].volume; cumVol+=c[i].volume;
    o[i]=cumVol>0?cumPV/cumVol:tp;
  }
  return o;
}

// ── Config ──
const CFG = {
  emaFast:8, emaSlow:21, rsiPeriod:9, atrPeriod:10,
  atrSlMult:1.6, atrTpMult:3.2,
  atrSmaLookback:20, atrVolMinMult:0.8,
  trailingActivation:1.0, trailingNewSL:0.2,
  maxBarsInTrade:12, riskPerTrade:0.01,
  maxTradesPerDay:2, circuitBreakerPct:0.03,
  commissionPct:0.001, slippagePct:0.0005,
};

function isInSession(ts) {
  const h = new Date(ts * 1000).getUTCHours();
  return h >= 1 && h < 21;
}
function utcDayKey(ts) {
  const d = new Date(ts * 1000);
  return d.getUTCFullYear()*10000+(d.getUTCMonth()+1)*100+d.getUTCDate();
}

function calcATRSma(atr, lb) {
  const o = Array(atr.length).fill(NaN);
  for (let i=lb-1;i<atr.length;i++){
    let s=0,n=0;
    for(let j=i-lb+1;j<=i;j++){if(!isNaN(atr[j])){s+=atr[j];n++;}}
    if(n===lb) o[i]=s/n;
  }
  return o;
}

function precompute(candles) {
  const atr = calcATR(candles, CFG.atrPeriod);
  return {
    ef: calcEMA(candles, CFG.emaFast),
    es: calcEMA(candles, CFG.emaSlow),
    rsi: calcRSI(candles, CFG.rsiPeriod),
    atr,
    atrSma: calcATRSma(atr, CFG.atrSmaLookback),
    vwap: calcVWAP(candles),
  };
}

function evalBar(c, ind, i) {
  const minI = Math.max(CFG.emaSlow, CFG.rsiPeriod, CFG.atrPeriod) + 2;
  if (i < minI) return { signal: "NONE" };

  const ef=ind.ef[i], efP=ind.ef[i-1], es=ind.es[i], esP=ind.es[i-1];
  const rsi=ind.rsi[i], rsiP=ind.rsi[i-1], atr=ind.atr[i], atrSma=ind.atrSma[i], vwap=ind.vwap[i];
  if ([ef,efP,es,esP,rsi,rsiP,atr,vwap].some(isNaN) || atr===0) return { signal: "NONE" };

  const cn = c[i];
  if (!isInSession(cn.time)) return { signal: "NONE" };

  // Volatility filter: ATR must be above its SMA × threshold
  if (!isNaN(atrSma) && atr < atrSma * CFG.atrVolMinMult) return { signal: "NONE" };

  const slD = atr * CFG.atrSlMult, tpD = atr * CFG.atrTpMult;

  // LONG
  if (efP <= esP && ef > es && rsiP < 50 && rsi >= 50)
    return { signal: "LONG", entry: cn.close, sl: cn.close - slD, tp: cn.close + tpD, atr, vwapAligned: cn.close > vwap };
  // SHORT
  if (efP >= esP && ef < es && rsiP > 50 && rsi <= 50)
    return { signal: "SHORT", entry: cn.close, sl: cn.close + slD, tp: cn.close - tpD, atr, vwapAligned: cn.close < vwap };

  return { signal: "NONE" };
}

function checkExit(cn, pos, barIdx) {
  const barsHeld = barIdx - pos.idx;
  if (pos.side === "long") {
    if (cn.low <= pos.sl) return { exit: true, price: pos.sl, reason: "SL" };
    if (cn.high >= pos.tp) return { exit: true, price: pos.tp, reason: "TP" };
    if (barsHeld >= CFG.maxBarsInTrade) return { exit: true, price: cn.close, reason: "Timeout" };
    if (!pos.trailing && cn.close >= pos.entry + pos.atr * CFG.trailingActivation)
      return { exit: false, newSL: pos.entry + pos.atr * CFG.trailingNewSL };
  } else {
    if (cn.high >= pos.sl) return { exit: true, price: pos.sl, reason: "SL" };
    if (cn.low <= pos.tp) return { exit: true, price: pos.tp, reason: "TP" };
    if (barsHeld >= CFG.maxBarsInTrade) return { exit: true, price: cn.close, reason: "Timeout" };
    if (!pos.trailing && cn.close <= pos.entry - pos.atr * CFG.trailingActivation)
      return { exit: false, newSL: pos.entry - pos.atr * CFG.trailingNewSL };
  }
  return { exit: false };
}

function runBacktest(candles, startCap = 10000) {
  const ind = precompute(candles);
  const trades = [];
  let cash = startCap, peak = cash, pos = null;
  const minI = Math.max(CFG.emaSlow, CFG.rsiPeriod, CFG.atrPeriod) + 2;

  let curDay = -1, dayTrades = 0, dayStart = startCap;

  for (let i = minI; i < candles.length; i++) {
    const cn = candles[i];
    const dk = utcDayKey(cn.time);
    if (dk !== curDay) { curDay = dk; dayTrades = 0; dayStart = cash; }

    const dayLoss = (dayStart - cash) / dayStart;
    const circuitBroken = dayLoss >= CFG.circuitBreakerPct;

    if (pos) {
      const ex = checkExit(cn, pos, i);
      if (ex.newSL !== undefined && !ex.exit) { pos.sl = ex.newSL; pos.trailing = true; }
      else if (ex.exit) {
        const slipped = pos.side === "long" ? ex.price * (1 - CFG.slippagePct) : ex.price * (1 + CFG.slippagePct);
        const pnlPU = pos.side === "long" ? slipped - pos.entry : pos.entry - slipped;
        const gross = pnlPU * pos.qty;
        const comm = (pos.entry + slipped) * pos.qty * CFG.commissionPct;
        const net = gross - comm;
        cash += net;
        trades.push({ side: pos.side, entry: pos.entry, exit: slipped, pnl: net, pnlPct: (net / (cash - net)) * 100, reason: ex.reason, bars: i - pos.idx, trailing: pos.trailing });
        if (cash > peak) peak = cash;
        pos = null;
      }
    }

    if (!pos && !circuitBroken && dayTrades < CFG.maxTradesPerDay) {
      const ev = evalBar(candles, ind, i);
      if (ev.signal !== "NONE") {
        const entrySlip = ev.signal === "LONG" ? ev.entry * (1 + CFG.slippagePct) : ev.entry * (1 - CFG.slippagePct);
        const riskMult = ev.vwapAligned ? 1.0 : 0.5;
        const riskAmt = cash * CFG.riskPerTrade * riskMult;
        const stopDist = Math.abs(entrySlip - ev.sl);
        const qty = stopDist > 0 ? riskAmt / stopDist : 0;
        if (qty <= 0) continue;
        pos = { side: ev.signal === "LONG" ? "long" : "short", entry: entrySlip, sl: ev.sl, tp: ev.tp, atr: ev.atr, idx: i, trailing: false, qty };
        dayTrades++;
      }
    }
  }

  if (pos) {
    const last = candles[candles.length - 1];
    const pnlPU = pos.side === "long" ? last.close - pos.entry : pos.entry - last.close;
    const net = pnlPU * pos.qty;
    cash += net;
    trades.push({ side: pos.side, entry: pos.entry, exit: last.close, pnl: net, pnlPct: (net / (cash - net)) * 100, reason: "EOD", bars: candles.length - 1 - pos.idx, trailing: pos.trailing });
  }

  const wins = trades.filter(t => t.pnl > 0), losses = trades.filter(t => t.pnl <= 0);
  const gp = wins.reduce((s, t) => s + t.pnl, 0), gl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  let eq = startCap, eqP = startCap, maxDD = 0;
  for (const t of trades) { eq += t.pnl; if (eq > eqP) eqP = eq; const dd = (eqP - eq) / eqP * 100; if (dd > maxDD) maxDD = dd; }

  const firstT = candles[minI]?.time ?? candles[0]?.time;
  const lastT = candles[candles.length - 1]?.time ?? firstT;
  const totalDays = Math.max(1, (lastT - firstT) / 86400);

  return {
    totalTrades: trades.length,
    winRate: trades.length > 0 ? (wins.length / trades.length * 100).toFixed(1) : "0.0",
    profitFactor: gl > 0 ? (gp / gl).toFixed(2) : gp > 0 ? "Inf" : "0.00",
    totalReturn: ((cash - startCap) / startCap * 100).toFixed(2),
    maxDrawdown: maxDD.toFixed(2),
    finalEquity: cash.toFixed(2),
    trailingUsed: trades.filter(t => t.trailing).length,
    tradesPerDay: (trades.length / totalDays).toFixed(2),
  };
}

// ── Helpers ──
async function runBatch(label, pairs, count) {
  console.log("\n" + "═".repeat(95));
  console.log(`  ${label}`);
  console.log("═".repeat(95));
  const results = [];
  for (const pair of pairs) {
    process.stdout.write(`  ⏳ ${pair.padEnd(10)} — cargando...`);
    try {
      const candles = await loadCandles(pair, "1h", count);
      process.stdout.write(` ${candles.length} velas. `);
      const r = runBacktest(candles);
      const from = new Date(candles[0].time * 1000).toISOString().slice(0, 10);
      const to = new Date(candles[candles.length - 1].time * 1000).toISOString().slice(0, 10);
      results.push({ pair, ...r, from, to });
      console.log(`✓ ${r.totalTrades} trades | WR ${r.winRate}% | PF ${r.profitFactor} | Ret ${r.totalReturn}% | DD ${r.maxDrawdown}%`);
    } catch (err) {
      console.log(`✗ ERROR: ${err.message}`);
    }
  }
  // Table
  console.log();
  console.log(`  ${"Par".padEnd(11)} ${"Trades".padStart(7)} ${"WinRate".padStart(8)} ${"PF".padStart(7)} ${"Retorno".padStart(10)} ${"MaxDD".padStart(8)} ${"T/dia".padStart(7)}`);
  console.log("  " + "─".repeat(60));
  for (const r of results) {
    const ret = parseFloat(r.totalReturn);
    const retStr = (ret >= 0 ? "+" : "") + r.totalReturn + "%";
    console.log(`  ${r.pair.padEnd(11)} ${r.totalTrades.toString().padStart(7)} ${(r.winRate + "%").padStart(8)} ${r.profitFactor.padStart(7)} ${retStr.padStart(10)} ${(r.maxDrawdown + "%").padStart(8)} ${r.tradesPerDay.padStart(7)}`);
  }
  if (results.length > 1) {
    console.log("  " + "─".repeat(60));
    const avgRet = (results.reduce((s, r) => s + parseFloat(r.totalReturn), 0) / results.length).toFixed(2);
    const avgDD = (results.reduce((s, r) => s + parseFloat(r.maxDrawdown), 0) / results.length).toFixed(2);
    const avgTpd = (results.reduce((s, r) => s + parseFloat(r.tradesPerDay), 0) / results.length).toFixed(2);
    const tot = results.reduce((s, r) => s + r.totalTrades, 0);
    console.log(`  ${"PROMEDIO".padEnd(11)} ${tot.toString().padStart(7)} ${"".padStart(8)} ${"".padStart(7)} ${(avgRet + "%").padStart(10)} ${(avgDD + "%").padStart(8)} ${avgTpd.padStart(7)}`);
  }
  console.log("═".repeat(95));
  return results;
}

// ── Main ──
console.log("╔═══════════════════════════════════════════════════════════════════════════════╗");
console.log("║  Pulse Scalper 1H v3 — ATR vol filter + VWAP soft + SL 1.6x / TP 3.2x ATR  ║");
console.log("║  Timeout 12 bars · Max 2 trades/dia · Circuit Breaker 3%                    ║");
console.log("╚═══════════════════════════════════════════════════════════════════════════════╝");

const TOP4 = ["LINKUSDT", "AVAXUSDT", "SOLUSDT", "XRPUSDT"];
const COUNT_1Y = 8760;   // 365 * 24
const COUNT_2Y = 17520;  // 730 * 24

// Batch 1: Top 4 pares, 1 año
await runBatch("TOP 4 PARES — 1 AÑO (1H)", TOP4, COUNT_1Y);

// Batch 2: Top 4 pares, 2 años
await runBatch("TOP 4 PARES — 2 AÑOS (1H)", TOP4, COUNT_2Y);

// Batch 3: BTC solo, 2 años
await runBatch("BTCUSDT — 2 AÑOS (1H)", ["BTCUSDT"], COUNT_2Y);
