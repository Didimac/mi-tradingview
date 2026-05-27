/**
 * Backtest: 100€ capital, último año, SmartScorer v2 Variante A
 * Usage: npx tsx scripts/run-100eur-1year.ts
 */

interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number; }
interface FundingEntry { time: number; rate: number; }

const BASE = "https://api.binance.com/api/v3";
const FAPI = "https://fapi.binance.com/fapi/v1";

async function fetchKlines(sym: string, iv: string, lim = 1000): Promise<Candle[]> {
  const r = await fetch(`${BASE}/klines?symbol=${sym}&interval=${iv}&limit=${lim}`);
  if (!r.ok) throw new Error(`klines ${r.status}`);
  return ((await r.json()) as unknown[][]).map(k => ({ time: Math.floor((k[0] as number)/1000), open: parseFloat(k[1] as string), high: parseFloat(k[2] as string), low: parseFloat(k[3] as string), close: parseFloat(k[4] as string), volume: parseFloat(k[5] as string) }));
}
async function fetchKlinesBefore(sym: string, iv: string, endMs: number, lim = 1000): Promise<Candle[]> {
  const r = await fetch(`${BASE}/klines?symbol=${sym}&interval=${iv}&endTime=${endMs-1}&limit=${lim}`);
  if (!r.ok) throw new Error(`klines ${r.status}`);
  return ((await r.json()) as unknown[][]).map(k => ({ time: Math.floor((k[0] as number)/1000), open: parseFloat(k[1] as string), high: parseFloat(k[2] as string), low: parseFloat(k[3] as string), close: parseFloat(k[4] as string), volume: parseFloat(k[5] as string) }));
}
async function loadCandles(sym: string, iv: string, count: number): Promise<Candle[]> {
  let c = await fetchKlines(sym, iv, Math.min(count, 1000));
  while (c.length < count) { const o = c[0]; const b = await fetchKlinesBefore(sym, iv, o.time*1000, Math.min(count-c.length, 1000)); if (!b.length) break; c = [...b, ...c]; await new Promise(r=>setTimeout(r,200)); }
  const seen = new Set<number>(); return c.sort((a,b)=>a.time-b.time).filter(x => { if (seen.has(x.time)) return false; seen.add(x.time); return true; });
}
async function fetchFRHistory(sym: string, startMs: number, endMs: number): Promise<FundingEntry[]> {
  const all: FundingEntry[] = []; let cur = startMs;
  while (cur < endMs) { const r = await fetch(`${FAPI}/fundingRate?symbol=${sym}&startTime=${cur}&endTime=${endMs}&limit=1000`); if (!r.ok) break; const d = (await r.json()) as {fundingRate:string;fundingTime:number}[]; if (!d.length) break; for (const x of d) all.push({time:Math.floor(x.fundingTime/1000),rate:parseFloat(x.fundingRate)}); cur = d[d.length-1].fundingTime+1; await new Promise(r=>setTimeout(r,200)); }
  return all.sort((a,b)=>a.time-b.time);
}
function findFR(h: FundingEntry[], ts: number): number { for (let i=h.length-1;i>=0;i--) if(h[i].time<=ts) return h[i].rate; return 0; }

function calcEMA(c: number[], p: number): number[] { const o=new Array(c.length).fill(NaN); if(c.length<p)return o; const k=2/(p+1); let e=0; for(let i=0;i<p;i++)e+=c[i]; e/=p; o[p-1]=e; for(let i=p;i<c.length;i++){e=c[i]*k+e*(1-k);o[i]=e;} return o; }
function calcRSI(c: number[], p=14): number[] { const o=new Array(c.length).fill(NaN); if(c.length<p+1)return o; let ag=0,al=0; for(let i=1;i<=p;i++){const d=c[i]-c[i-1];if(d>0)ag+=d;else al+=Math.abs(d);} ag/=p;al/=p; o[p]=al===0?100:100-100/(1+ag/al); for(let i=p+1;i<c.length;i++){const d=c[i]-c[i-1];ag=(ag*(p-1)+(d>0?d:0))/p;al=(al*(p-1)+(d<0?Math.abs(d):0))/p;o[i]=al===0?100:100-100/(1+ag/al);} return o; }
function calcATR(cs: Candle[], p=14): number[] { const o=new Array(cs.length).fill(NaN); if(cs.length<p+1)return o; const t:number[]=[]; for(let i=1;i<cs.length;i++)t.push(Math.max(cs[i].high-cs[i].low,Math.abs(cs[i].high-cs[i-1].close),Math.abs(cs[i].low-cs[i-1].close))); let a=0;for(let i=0;i<p;i++)a+=t[i];a/=p;o[p]=a; for(let i=p;i<t.length;i++){a=(a*(p-1)+t[i])/p;o[i+1]=a;} return o; }

type Dir = "LONG"|"SHORT"|"NEUTRAL";

function scoreFR(fr: number): {pts:number;dir:Dir} {
  let dir:Dir="NEUTRAL"; if(fr<-0.0001)dir="LONG"; else if(fr>0.0001)dir="SHORT";
  let lp=0; if(fr<-0.0002)lp=35;else if(fr<0.0001)lp=15;else if(fr<0.0005)lp=0;else lp=-20;
  let sp=0; if(fr>0.0005)sp=35;else if(fr>-0.0001)sp=15;else if(fr>-0.0002)sp=0;else sp=-20;
  if(lp>=sp) return {pts:lp,dir:lp>0?"LONG":dir}; return {pts:sp,dir:sp>0?"SHORT":dir};
}
function scoreDiv(cs: Candle[], rsi: number[], i: number): {pts:number;dir:Dir} {
  if(i<20) return {pts:0,dir:"NEUTRAL"};
  for(const lb of [5,8,12,16]){const j=i-lb;if(j<0||isNaN(rsi[i])||isNaN(rsi[j]))continue;if(cs[i].low<cs[j].low&&rsi[i]>rsi[j])return{pts:35,dir:"LONG"};if(cs[i].high>cs[j].high&&rsi[i]<rsi[j])return{pts:35,dir:"SHORT"};}
  for(const lb of [5,8,12,16]){const j=i-lb;if(j<0||isNaN(rsi[i])||isNaN(rsi[j]))continue;if(cs[i].low>cs[j].low&&rsi[i]<rsi[j])return{pts:20,dir:"LONG"};if(cs[i].high<cs[j].high&&rsi[i]>rsi[j])return{pts:20,dir:"SHORT"};}
  return {pts:0,dir:"NEUTRAL"};
}
function calcVWAP(cs: Candle[], i: number): number {
  const d=new Date(cs[i].time*1000);const dow=d.getUTCDay();const dsm=dow===0?6:dow-1;
  const ws=new Date(d);ws.setUTCHours(0,0,0,0);ws.setUTCDate(ws.getUTCDate()-dsm);const wst=ws.getTime()/1000;
  let spv=0,sv=0;for(let k=i;k>=0;k--){if(cs[k].time<wst)break;const tp=(cs[k].high+cs[k].low+cs[k].close)/3;spv+=tp*cs[k].volume;sv+=cs[k].volume;}
  return sv>0?spv/sv:cs[i].close;
}
function scoreVWAP(price: number, vwap: number): {pts:number;dir:Dir} {
  const dp=((price-vwap)/vwap)*100; let dir:Dir="NEUTRAL"; if(dp<-0.5)dir="LONG";else if(dp>0.5)dir="SHORT";
  const ad=Math.abs(dp); let pts=0; if(ad>=2&&ad<=3)pts=30;else if(ad>=1&&ad<2)pts=20;else if(ad>=0.5&&ad<1)pts=10;else if(ad>3)pts=15;
  return {pts,dir};
}

function scoreBar(cs: Candle[], rsi: number[], atr: number[], ema21: number[], i: number, fr: number): {score:number;dir:Dir;atrV:number;ema21V:number} {
  const z = {score:0,dir:"NEUTRAL" as Dir,atrV:0,ema21V:0};
  if(isNaN(atr[i])||isNaN(ema21[i])||atr[i]<=0) return z;
  const price=cs[i].close;
  const frR=scoreFR(fr), divR=scoreDiv(cs,rsi,i), vwap=calcVWAP(cs,i), vwapR=scoreVWAP(price,vwap);
  const dirs=[frR.dir,divR.dir,vwapR.dir].filter(d=>d!=="NEUTRAL");
  const lc=dirs.filter(d=>d==="LONG").length, sc=dirs.filter(d=>d==="SHORT").length;
  if(dirs.length===0) return z;
  let finalDir:Dir, agree: number;
  if(lc>0&&sc===0){finalDir="LONG";agree=lc;}
  else if(sc>0&&lc===0){finalDir="SHORT";agree=sc;}
  else{finalDir=lc>=sc?"LONG":"SHORT";agree=Math.max(lc,sc);}
  if(agree<2) return z;
  let raw=frR.pts+divR.pts+vwapR.pts;
  if(frR.dir!=="NEUTRAL"&&frR.dir!==finalDir) raw-=15;
  const score=Math.max(0,raw);
  if(score<75) return z;
  return {score,dir:finalDir,atrV:atr[i],ema21V:ema21[i]};
}

function calcEntryZone(p:number,e:number,a:number,d:Dir){const dist=Math.abs(p-e);if(dist<=0.3*a)return{ideal:e,latest:p,type:"pullback" as const};if(dist<=1.0*a)return{ideal:p,latest:p,type:"momentum" as const};const lp=d==="LONG"?e+1.0*a:e-1.0*a;return{ideal:e,latest:lp,type:"late" as const};}

const CFG={cancelTh:40,risk:0.015,maxPos:1,expiry:2,timeout:48,zoneTol:0.001,cd:2,slM:1.5,tp1M:2.25,tp2M:4.5,tp1Pct:0.5};
const PAIRS=["BTCUSDT","SOLUSDT","BNBUSDT"];

interface Pos{sym:string;ep:number;dir:Dir;sl:number;tp1:number;tp2:number;qty:number;tp1Hit:boolean;rem:number;bars:number;}

interface TradeLog {
  sym: string;
  dir: Dir;
  ep: number;
  exit: number;
  pnl: number;
  reason: string;
}

async function main(){
  const START_CAPITAL = 100; // 100€
  const BARS_1YEAR = 8760;  // 365 days × 24h

  console.log("═══════════════════════════════════════════════════════════════════════");
  console.log("  SIMULACION: 100€ — Ultimo año — SmartScorer v2 Variante A");
  console.log("  Pares: BTC + SOL + BNB | Risk: 1.5% por trade");
  console.log("═══════════════════════════════════════════════════════════════════════\n");

  const allC=new Map<string,Candle[]>();
  for(const sym of PAIRS){process.stdout.write(`  Descargando ${sym}...`);const c=await loadCandles(sym,"1h",BARS_1YEAR+200);allC.set(sym,c);console.log(` ${c.length} barras`);}

  const allFR=new Map<string,FundingEntry[]>();
  const fc=allC.get(PAIRS[0])!;const startMs=fc[0].time*1000,endMs=fc[fc.length-1].time*1000;
  for(const sym of PAIRS){process.stdout.write(`  Descargando FR ${sym}...`);const fr=await fetchFRHistory(sym,startMs,endMs);allFR.set(sym,fr);console.log(` ${fr.length}`);}

  const allRSI=new Map<string,number[]>(),allATR=new Map<string,number[]>(),allE21=new Map<string,number[]>(),allE55=new Map<string,number[]>();
  for(const[sym,c]of allC){const cl=c.map(x=>x.close);allRSI.set(sym,calcRSI(cl));allATR.set(sym,calcATR(c));allE21.set(sym,calcEMA(cl,21));allE55.set(sym,calcEMA(cl,55));}

  // Run backtest
  let cap=START_CAPITAL, peak=START_CAPITAL, maxDD=0;
  const sigs=new Map<string,{sym:string;bar:number;dir:Dir;ideal:number;latest:number;sl:number;tp1:number;tp2:number;w:number;}>();
  const pos=new Map<string,Pos>(), lastSig=new Map<string,number>();
  let closed=0,wins=0,losses=0;
  let totalGP=0, totalGL=0;
  const trades: TradeLog[] = [];
  const capitalCurve: {bar:number;cap:number}[] = [];

  const totalBars = fc.length;
  const startBar = 60;

  for(let i=startBar;i<totalBars;i++){
    // Check open positions
    for(const[sym,p]of pos){
      const c=allC.get(sym)!;if(i>=c.length)continue;const b=c[i];p.bars++;
      let ep:number|null=null,er="";
      if(p.dir==="LONG"){
        if(b.low<=p.sl){ep=p.sl;er=p.tp1Hit?"BE":"SL";}
        else if(!p.tp1Hit&&b.high>=p.tp1){const pq=p.qty*CFG.tp1Pct;const pnl=(p.tp1-p.ep)*pq;cap+=pnl;if(pnl>0)totalGP+=pnl;else totalGL+=Math.abs(pnl);p.tp1Hit=true;p.rem=p.qty-pq;p.sl=p.ep;}
        else if(p.tp1Hit&&b.high>=p.tp2){ep=p.tp2;er="TP2";}
      }else{
        if(b.high>=p.sl){ep=p.sl;er=p.tp1Hit?"BE":"SL";}
        else if(!p.tp1Hit&&b.low<=p.tp1){const pq=p.qty*CFG.tp1Pct;const pnl=(p.ep-p.tp1)*pq;cap+=pnl;if(pnl>0)totalGP+=pnl;else totalGL+=Math.abs(pnl);p.tp1Hit=true;p.rem=p.qty-pq;p.sl=p.ep;}
        else if(p.tp1Hit&&b.low<=p.tp2){ep=p.tp2;er="TP2";}
      }
      if(!ep&&p.bars>=CFG.timeout){ep=b.close;er="Timeout";}
      if(ep!==null){
        const pu=p.dir==="LONG"?ep-p.ep:p.ep-ep;const pnl=pu*p.rem;cap+=pnl;
        if(pnl>0){totalGP+=pnl;wins++;}else{totalGL+=Math.abs(pnl);losses++;}
        closed++;
        trades.push({sym:p.sym,dir:p.dir,ep:p.ep,exit:ep,pnl:pnl+(p.tp1Hit?(p.dir==="LONG"?(p.tp1-p.ep):(p.ep-p.tp1))*p.qty*CFG.tp1Pct:0),reason:er});
        pos.delete(sym);
      }
    }
    // Check pending signals
    for(const[sym,sig]of sigs){
      const c=allC.get(sym)!;if(i>=c.length){sigs.delete(sym);continue;}const b=c[i];sig.w++;
      const fr=findFR(allFR.get(sym)!,c[i].time);const cur=scoreBar(c,allRSI.get(sym)!,allATR.get(sym)!,allE21.get(sym)!,i,fr);
      if(cur.score<CFG.cancelTh){sigs.delete(sym);continue;}
      const reached=sig.dir==="LONG"?b.low<=sig.ideal*(1+CFG.zoneTol):b.high>=sig.ideal*(1-CFG.zoneTol);
      if(reached&&pos.size<CFG.maxPos&&!pos.has(sym)){const sd=Math.abs(sig.ideal-sig.sl);const qty=sd>0?(cap*CFG.risk)/sd:0;if(qty>0){pos.set(sym,{sym,ep:sig.ideal,dir:sig.dir,sl:sig.sl,tp1:sig.tp1,tp2:sig.tp2,qty,tp1Hit:false,rem:qty,bars:0});}sigs.delete(sym);continue;}
      const esc=sig.dir==="LONG"?b.high>sig.latest:b.low<sig.latest;if(esc){sigs.delete(sym);continue;}
      if(sig.w>=CFG.expiry){sigs.delete(sym);continue;}
    }
    // Generate new signals
    for(const sym of PAIRS){
      if(sigs.has(sym)||pos.has(sym))continue;const lb=lastSig.get(sym)??-999;if(i-lb<CFG.cd)continue;
      const c=allC.get(sym)!;if(i>=c.length)continue;
      const fr=findFR(allFR.get(sym)!,c[i].time);const bs=scoreBar(c,allRSI.get(sym)!,allATR.get(sym)!,allE21.get(sym)!,i,fr);
      if(bs.score<75||bs.dir==="NEUTRAL")continue;
      const e55=allE55.get(sym)![i];if(!isNaN(e55)){if(bs.dir==="LONG"&&c[i].close<=e55)continue;if(bs.dir==="SHORT"&&c[i].close>=e55)continue;}
      const price=c[i].close;const atr=bs.atrV;
      const zone=calcEntryZone(price,bs.ema21V,atr,bs.dir);
      let adj=bs.score;if(zone.type==="late")adj=Math.round(adj*0.8);if(adj<75)continue;
      let sl:number,tp1:number,tp2:number;
      if(bs.dir==="LONG"){sl=price-CFG.slM*atr;tp1=price+CFG.tp1M*atr;tp2=price+CFG.tp2M*atr;}
      else{sl=price+CFG.slM*atr;tp1=price-CFG.tp1M*atr;tp2=price-CFG.tp2M*atr;}
      lastSig.set(sym,i);
      if(zone.type==="momentum"&&pos.size<CFG.maxPos){const sd=Math.abs(price-sl);const qty=sd>0?(cap*CFG.risk)/sd:0;if(qty>0){pos.set(sym,{sym,ep:price,dir:bs.dir,sl,tp1,tp2,qty,tp1Hit:false,rem:qty,bars:0});}}
      else if(zone.type!=="momentum"){sigs.set(sym,{sym,bar:i,dir:bs.dir,ideal:zone.ideal,latest:zone.latest,sl,tp1,tp2,w:0});}
    }
    if(cap>peak)peak=cap;const dd=peak>0?((peak-cap)/peak)*100:0;if(dd>maxDD)maxDD=dd;
    if(i%168===0) capitalCurve.push({bar:i,cap});
  }
  // Close remaining positions at market
  for(const[sym,p]of pos){const c=allC.get(sym)!;const lp=c[c.length-1].close;const pnl=(p.dir==="LONG"?lp-p.ep:p.ep-lp)*p.rem;cap+=pnl;if(pnl>0){totalGP+=pnl;wins++;}else{totalGL+=Math.abs(pnl);losses++;}closed++;}

  const ret = ((cap - START_CAPITAL) / START_CAPITAL) * 100;
  const pf = totalGL > 0 ? totalGP / totalGL : totalGP > 0 ? Infinity : 0;

  // Results
  console.log("\n═══════════════════════════════════════════════════════════════════════");
  console.log("  RESULTADOS — 100€ en el ultimo año");
  console.log("═══════════════════════════════════════════════════════════════════════\n");

  console.log(`  Capital inicial:     €100.00`);
  console.log(`  Capital final:       €${cap.toFixed(2)}`);
  console.log(`  Ganancia/Perdida:    €${(cap - START_CAPITAL).toFixed(2)} (${ret >= 0 ? "+" : ""}${ret.toFixed(2)}%)`);
  console.log(`  Max Drawdown:        ${maxDD.toFixed(1)}%`);
  console.log(`  ─────────────────────────────────`);
  console.log(`  Total trades:        ${closed}`);
  console.log(`  Wins:                ${wins}`);
  console.log(`  Losses:              ${losses}`);
  console.log(`  Win Rate:            ${closed > 0 ? ((wins/closed)*100).toFixed(1) : 0}%`);
  console.log(`  Profit Factor:       ${pf === Infinity ? "∞" : pf.toFixed(2)}`);
  console.log(`  ─────────────────────────────────`);
  console.log(`  Ganancia bruta:      €${totalGP.toFixed(2)}`);
  console.log(`  Perdida bruta:       €${totalGL.toFixed(2)}`);
  console.log(`  Risk por trade:      1.5% (€${(START_CAPITAL * CFG.risk).toFixed(2)} inicial)`);

  // Trade list
  if (trades.length > 0) {
    console.log(`\n  ─────────────────────────────────`);
    console.log(`  DETALLE DE TRADES:`);
    console.log(`  ─────────────────────────────────`);
    for (const t of trades) {
      const sym = t.sym.replace("USDT","");
      const sign = t.pnl >= 0 ? "+" : "";
      console.log(`  ${t.dir.padEnd(5)} ${sym.padEnd(4)} | Entry $${t.ep.toFixed(2).padStart(10)} → Exit $${t.exit.toFixed(2).padStart(10)} | ${t.reason.padEnd(7)} | ${sign}€${t.pnl.toFixed(2)}`);
    }
  }

  // Capital curve
  console.log(`\n  ─────────────────────────────────`);
  console.log(`  CURVA DE CAPITAL (semanal):`);
  console.log(`  ─────────────────────────────────`);
  capitalCurve.push({bar:totalBars,cap});
  for (const p of capitalCurve) {
    const bar = "█".repeat(Math.max(1, Math.round((p.cap / START_CAPITAL) * 20)));
    console.log(`  ${bar} €${p.cap.toFixed(2)}`);
  }

  console.log("\n═══════════════════════════════════════════════════════════════════════\n");
}

main().catch(console.error);
