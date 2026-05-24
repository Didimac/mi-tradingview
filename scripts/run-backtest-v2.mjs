// Crypto Pulse v2 — Backtest runner (1D, top 10 pairs)
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
    const b = await fetch(`${BASE}/klines?symbol=${symbol}&interval=${tf}&endTime=${c[0].time * 1000 - 1}&limit=${Math.min(count - c.length, 1000)}`);
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
function calcADX(c, p) {
  const n=c.length, adx=Array(n).fill(NaN), pDI=Array(n).fill(NaN), mDI=Array(n).fill(NaN);
  if(n<p*2+1) return {adx,pDI,mDI};
  const tr=Array(n).fill(0),pDM=Array(n).fill(0),mDM=Array(n).fill(0);
  for(let i=1;i<n;i++){const u=c[i].high-c[i-1].high,d=c[i-1].low-c[i].low;
    tr[i]=Math.max(c[i].high-c[i].low,Math.abs(c[i].high-c[i-1].close),Math.abs(c[i].low-c[i-1].close));
    pDM[i]=u>d&&u>0?u:0;mDM[i]=d>u&&d>0?d:0;}
  let sTR=tr.slice(1,p+1).reduce((s,v)=>s+v,0),sPDM=pDM.slice(1,p+1).reduce((s,v)=>s+v,0),sMDM=mDM.slice(1,p+1).reduce((s,v)=>s+v,0);
  const dx=Array(n).fill(NaN); const pi=Array(n).fill(NaN),mi=Array(n).fill(NaN);
  pi[p]=sTR>0?(sPDM/sTR)*100:0;mi[p]=sTR>0?(sMDM/sTR)*100:0;
  let s=pi[p]+mi[p]; dx[p]=s>0?Math.abs(pi[p]-mi[p])/s*100:0;
  for(let i=p+1;i<n;i++){sTR=sTR-sTR/p+tr[i];sPDM=sPDM-sPDM/p+pDM[i];sMDM=sMDM-sMDM/p+mDM[i];
    pi[i]=sTR>0?(sPDM/sTR)*100:0;mi[i]=sTR>0?(sMDM/sTR)*100:0;pDI[i]=pi[i];mDI[i]=mi[i];
    const s2=pi[i]+mi[i];dx[i]=s2>0?Math.abs(pi[i]-mi[i])/s2*100:0;}
  let av=dx.slice(p,p*2).filter(v=>!isNaN(v)).reduce((s,v)=>s+v,0)/p; adx[p*2-1]=av;
  for(let i=p*2;i<n;i++){if(!isNaN(dx[i])){av=(av*(p-1)+dx[i])/p;adx[i]=av;}}
  return {adx,pDI,mDI};
}

// ── Config ──
const CFG = {
  emaFast:21,emaSlow:55,rsiPeriod:14,atrPeriod:14,adxPeriod:14,volumeLookback:20,
  trendSeparationPct:0.3,adxTrendMin:20,atrSlMult:1.8,atrTpMult:3.6,
  rsiOverbought:78,rsiOversold:22,rsiCrossUp:45,rsiCrossDown:55,rsiRangeLong:35,rsiRangeShort:65,
  volMultTrend:1.4,volMultRange:1.1,trailingActivation:1.2,trailingNewSL:0.3,
  riskPerTrade:0.015,commissionPct:0.001,slippagePct:0.0003,
};

function avgVol(c,i,lb){const s=c.slice(Math.max(1,i-lb),i);return s.length?s.reduce((a,x)=>a+x.volume,0)/s.length:0;}
function bullE(p,c){return p.close<p.open&&c.close>c.open&&c.close>p.open&&c.open<p.close;}
function bearE(p,c){return p.close>p.open&&c.close<c.open&&c.close<p.open&&c.open>p.close;}

function precompute(candles) {
  const {adx,pDI,mDI}=calcADX(candles,CFG.adxPeriod);
  return {ef:calcEMA(candles,CFG.emaFast),es:calcEMA(candles,CFG.emaSlow),rsi:calcRSI(candles,CFG.rsiPeriod),atr:calcATR(candles,CFG.atrPeriod),adx,pDI,mDI};
}

function evalBar(c,ind,i) {
  const minI=Math.max(CFG.emaSlow,CFG.adxPeriod*2,CFG.rsiPeriod,CFG.atrPeriod)+2;
  if(i<minI) return {signal:"NONE"};
  const ef=ind.ef[i],es=ind.es[i],rsi=ind.rsi[i],rsiP=ind.rsi[i-1],atr=ind.atr[i],adx=ind.adx[i];
  if([ef,es,rsi,atr].some(isNaN)||atr===0) return {signal:"NONE"};
  const cn=c[i],cp=c[i-1],close=cn.close;
  const sep=Math.abs(ef-es)/es*100, regime=sep>=CFG.trendSeparationPct?"TREND":"RANGE";
  const va=avgVol(c,i,CFG.volumeLookback),vm=regime==="TREND"?CFG.volMultTrend:CFG.volMultRange;
  const volOk=va>0&&cn.volume>=va*vm;
  const slD=atr*CFG.atrSlMult,tpD=atr*CFG.atrTpMult;

  if(regime==="TREND"){
    const adxOk=!isNaN(adx)&&adx>=CFG.adxTrendMin;
    if(ef>es&&adxOk&&rsiP<CFG.rsiCrossUp&&rsi>=CFG.rsiCrossUp&&close>ef&&volOk)
      return {signal:"LONG",entry:close,sl:close-slD,tp:close+tpD,atr,reason:`TREND LONG ADX${adx?.toFixed(0)}`};
    if(ef<es&&adxOk&&rsiP>CFG.rsiCrossDown&&rsi<=CFG.rsiCrossDown&&close<ef&&volOk)
      return {signal:"SHORT",entry:close,sl:close+slD,tp:close-tpD,atr,reason:`TREND SHORT ADX${adx?.toFixed(0)}`};
  }
  if(regime==="RANGE"){
    const tS=Math.abs(cn.low-es)/es<0.008,tR=Math.abs(cn.high-es)/es<0.008;
    if(rsiP<=CFG.rsiRangeLong&&rsi>rsiP&&(tS||close>es)&&(bullE(cp,cn)||volOk))
      return {signal:"LONG",entry:close,sl:close-slD,tp:close+tpD,atr,reason:"RANGE LONG"};
    if(rsiP>=CFG.rsiRangeShort&&rsi<rsiP&&(tR||close<es)&&(bearE(cp,cn)||volOk))
      return {signal:"SHORT",entry:close,sl:close+slD,tp:close-tpD,atr,reason:"RANGE SHORT"};
  }
  return {signal:"NONE"};
}

function checkExit(cn,pos,ind,i) {
  const rsi=ind.rsi[i],ef=ind.ef[i],efP=ind.ef[i-1],es=ind.es[i],esP=ind.es[i-1];
  if(pos.side==="long"){
    if(cn.low<=pos.sl) return {exit:true,price:pos.sl,reason:"SL"};
    if(cn.high>=pos.tp) return {exit:true,price:pos.tp,reason:"TP"};
    if(!isNaN(rsi)&&rsi>CFG.rsiOverbought) return {exit:true,price:cn.close,reason:"RSI OB"};
    if(![ef,efP,es,esP].some(isNaN)&&efP>esP&&ef<es) return {exit:true,price:cn.close,reason:"EMA cross"};
    if(!pos.trailing&&cn.close>=pos.entry+pos.atr*CFG.trailingActivation)
      return {exit:false,newSL:pos.entry+pos.atr*CFG.trailingNewSL};
  } else {
    if(cn.high>=pos.sl) return {exit:true,price:pos.sl,reason:"SL"};
    if(cn.low<=pos.tp) return {exit:true,price:pos.tp,reason:"TP"};
    if(!isNaN(rsi)&&rsi<CFG.rsiOversold) return {exit:true,price:cn.close,reason:"RSI OS"};
    if(![ef,efP,es,esP].some(isNaN)&&efP<esP&&ef>es) return {exit:true,price:cn.close,reason:"EMA cross"};
    if(!pos.trailing&&cn.close<=pos.entry-pos.atr*CFG.trailingActivation)
      return {exit:false,newSL:pos.entry-pos.atr*CFG.trailingNewSL};
  }
  return {exit:false};
}

function runBacktest(candles, startCap=10000) {
  const ind=precompute(candles);
  const trades=[];
  let cash=startCap,peak=cash,pos=null;
  const minI=Math.max(CFG.emaSlow,CFG.adxPeriod*2,CFG.rsiPeriod,CFG.atrPeriod)+10;

  for(let i=minI;i<candles.length;i++){
    const cn=candles[i];
    if(pos){
      const ex=checkExit(cn,pos,ind,i);
      if(ex.newSL!==undefined&&!ex.exit){pos.sl=ex.newSL;pos.trailing=true;}
      else if(ex.exit){
        // Apply slippage
        const slipped=pos.side==="long"?ex.price*(1-CFG.slippagePct):ex.price*(1+CFG.slippagePct);
        const pnlPU=pos.side==="long"?slipped-pos.entry:pos.entry-slipped;
        const gross=pnlPU*pos.qty;
        const comm=(pos.entry+slipped)*pos.qty*CFG.commissionPct;
        const net=gross-comm;
        cash+=net;
        trades.push({side:pos.side,entry:pos.entry,exit:slipped,pnl:net,pnlPct:(net/(cash-net))*100,reason:ex.reason,bars:i-pos.idx,trailing:pos.trailing});
        if(cash>peak)peak=cash;
        pos=null;
      }
    }
    if(!pos){
      const ev=evalBar(candles,ind,i);
      if(ev.signal!=="NONE"){
        const entrySlip=ev.signal==="LONG"?ev.entry*(1+CFG.slippagePct):ev.entry*(1-CFG.slippagePct);
        const riskAmt=cash*CFG.riskPerTrade;
        const stopDist=Math.abs(entrySlip-ev.sl);
        const qty=stopDist>0?riskAmt/stopDist:0;
        if(qty<=0) continue;
        pos={side:ev.signal==="LONG"?"long":"short",entry:entrySlip,sl:ev.sl,tp:ev.tp,atr:ev.atr,idx:i,trailing:false,qty};
      }
    }
  }
  if(pos){
    const last=candles[candles.length-1];
    const pnlPU=pos.side==="long"?last.close-pos.entry:pos.entry-last.close;
    const net=pnlPU*pos.qty;cash+=net;
    trades.push({side:pos.side,entry:pos.entry,exit:last.close,pnl:net,pnlPct:(net/(cash-net))*100,reason:"EOD",bars:candles.length-1-pos.idx,trailing:pos.trailing});
  }

  const wins=trades.filter(t=>t.pnl>0),losses=trades.filter(t=>t.pnl<=0);
  const gp=wins.reduce((s,t)=>s+t.pnl,0),gl=Math.abs(losses.reduce((s,t)=>s+t.pnl,0));
  let eq=startCap,eqP=startCap,maxDD=0;
  for(const t of trades){eq+=t.pnl;if(eq>eqP)eqP=eq;const dd=(eqP-eq)/eqP*100;if(dd>maxDD)maxDD=dd;}
  const trailUsed=trades.filter(t=>t.trailing).length;

  return {
    totalTrades:trades.length,winRate:trades.length>0?(wins.length/trades.length*100).toFixed(1):"0.0",
    profitFactor:gl>0?(gp/gl).toFixed(2):gp>0?"Inf":"0.00",
    totalReturn:((cash-startCap)/startCap*100).toFixed(2),maxDrawdown:maxDD.toFixed(2),
    finalEquity:cash.toFixed(2),trailingUsed:trailUsed,
  };
}

// ── Main ──
const PAIRS=["BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT","DOGEUSDT","ADAUSDT","AVAXUSDT","LINKUSDT","TONUSDT"];
const COUNT=730; // 2 years of daily candles

console.log("╔════════════════════════════════════════════════════════════════════════╗");
console.log("║  Crypto Pulse v2 Backtest — 2 años · 1D · Capital: $10,000           ║");
console.log("║  ADX>20 filter · RSI 45/55 · ATR SL 1.8x / TP 3.6x · Slippage+Comm ║");
console.log("╚════════════════════════════════════════════════════════════════════════╝\n");

const allResults = [];

for (const pair of PAIRS) {
  process.stdout.write(`⏳ ${pair.padEnd(10)} — cargando...`);
  try {
    const candles = await loadCandles(pair, "1d", COUNT);
    process.stdout.write(` ${candles.length} velas. `);
    const r = runBacktest(candles);
    const from = new Date(candles[0].time*1000).toISOString().slice(0,10);
    const to = new Date(candles[candles.length-1].time*1000).toISOString().slice(0,10);
    allResults.push({pair, ...r, from, to});
    console.log(`✓ ${r.totalTrades} trades | WR ${r.winRate}% | PF ${r.profitFactor} | Ret ${r.totalReturn}% | DD ${r.maxDrawdown}% | Trail ${r.trailingUsed}`);
  } catch (err) {
    console.log(`✗ ERROR: ${err.message}`);
  }
}

console.log("\n" + "═".repeat(90));
console.log("  RESUMEN COMPARATIVO v2 (1D) vs v1 (4H)");
console.log("═".repeat(90));
console.log(`  ${"Par".padEnd(11)} ${"Trades".padStart(7)} ${"WinRate".padStart(8)} ${"PF".padStart(7)} ${"Retorno".padStart(10)} ${"MaxDD".padStart(8)} ${"Trades/año".padStart(11)} ${"Trail".padStart(6)}`);
console.log("  " + "─".repeat(80));
for (const r of allResults) {
  const ret = parseFloat(r.totalReturn);
  const retStr = (ret >= 0 ? "+" : "") + r.totalReturn + "%";
  const days = (new Date(r.to) - new Date(r.from)) / (1000*60*60*24);
  const tradesPerYear = days > 0 ? (r.totalTrades / days * 365).toFixed(1) : "N/A";
  console.log(`  ${r.pair.padEnd(11)} ${r.totalTrades.toString().padStart(7)} ${(r.winRate+"%").padStart(8)} ${r.profitFactor.padStart(7)} ${retStr.padStart(10)} ${(r.maxDrawdown+"%").padStart(8)} ${tradesPerYear.padStart(11)} ${r.trailingUsed.toString().padStart(6)}`);
}
console.log("  " + "─".repeat(75));

// Aggregated
const totalTrades = allResults.reduce((s,r) => s + r.totalTrades, 0);
const avgReturn = (allResults.reduce((s,r) => s + parseFloat(r.totalReturn), 0) / allResults.length).toFixed(2);
const avgDD = (allResults.reduce((s,r) => s + parseFloat(r.maxDrawdown), 0) / allResults.length).toFixed(2);
const totalTrail = allResults.reduce((s,r) => s + r.trailingUsed, 0);
console.log(`  ${"PROMEDIO".padEnd(11)} ${totalTrades.toString().padStart(7)} ${"".padStart(8)} ${"".padStart(7)} ${(avgReturn+"%").padStart(10)} ${(avgDD+"%").padStart(8)} ${"".padStart(12)} ${totalTrail.toString().padStart(6)}`);
console.log("═".repeat(90));
