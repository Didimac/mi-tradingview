/**
 * SmartScorer v2 Variante A — Robustness Check
 * Split: Year 1 vs Year 2 + Per-pair breakdown
 * Usage: npx tsx scripts/run-smart-robustness.ts
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

// Indicators
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

// Variant A scorer
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
  if(agree<2) return z; // Variant A: 2/3 must agree
  let raw=frR.pts+divR.pts+vwapR.pts;
  // FR contradiction deducts 15pts
  if(frR.dir!=="NEUTRAL"&&frR.dir!==finalDir) raw-=15;
  const score=Math.max(0,raw);
  if(score<75) return z; // threshold 75
  return {score,dir:finalDir,atrV:atr[i],ema21V:ema21[i]};
}

function calcEntryZone(p:number,e:number,a:number,d:Dir){const dist=Math.abs(p-e);if(dist<=0.3*a)return{ideal:e,latest:p,type:"pullback" as const};if(dist<=1.0*a)return{ideal:p,latest:p,type:"momentum" as const};const lp=d==="LONG"?e+1.0*a:e-1.0*a;return{ideal:e,latest:lp,type:"late" as const};}

const CFG={cancelTh:40,risk:0.015,maxPos:1,expiry:2,timeout:48,zoneTol:0.001,cd:2,slM:1.5,tp1M:2.25,tp2M:4.5,tp1Pct:0.5};
const PAIRS=["BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","TONUSDT"];

interface Sig{sym:string;bar:number;dir:Dir;ideal:number;latest:number;sl:number;tp1:number;tp2:number;w:number;}
interface Pos{sym:string;ep:number;dir:Dir;sl:number;tp1:number;tp2:number;qty:number;tp1Hit:boolean;rem:number;bars:number;}
interface PStat{f1:number;f2:number;tp1:number;tp2:number;sl:number;tout:number;exp:number;esc:number;can:number;gp:number;gl:number;}

interface PeriodResult{trades:number;wins:number;wr:number;pf:number;ret:number;dd:number;capital:number;}
interface PairResult{sym:string;trades:number;wins:number;wr:number;pf:number;ret:number;gp:number;gl:number;}

function runFull(
  allC: Map<string,Candle[]>, allRSI: Map<string,number[]>, allATR: Map<string,number[]>,
  allE21: Map<string,number[]>, allE55: Map<string,number[]>, allFR: Map<string,FundingEntry[]>,
  startBar: number, endBar: number, startCapital: number,
): {period: PeriodResult; pairs: Map<string,PStat>} {
  let cap=startCapital, peak=startCapital, maxDD=0;
  const sigs=new Map<string,Sig>(), pos=new Map<string,Pos>(), lastSig=new Map<string,number>();
  const st=new Map<string,PStat>();
  for(const s of PAIRS) st.set(s,{f1:0,f2:0,tp1:0,tp2:0,sl:0,tout:0,exp:0,esc:0,can:0,gp:0,gl:0});
  let closed=0,wins=0;

  for(let i=startBar;i<endBar;i++){
    // Positions
    for(const[sym,p]of pos){
      const c=allC.get(sym)!;if(i>=c.length)continue;const b=c[i];const s=st.get(sym)!;p.bars++;
      let ep:number|null=null,er="";
      if(p.dir==="LONG"){
        if(b.low<=p.sl){ep=p.sl;er=p.tp1Hit?"BE":"SL";}
        else if(!p.tp1Hit&&b.high>=p.tp1){const pq=p.qty*CFG.tp1Pct;const pnl=(p.tp1-p.ep)*pq;cap+=pnl;if(pnl>0)s.gp+=pnl;else s.gl+=Math.abs(pnl);p.tp1Hit=true;p.rem=p.qty-pq;p.sl=p.ep;s.tp1++;}
        else if(p.tp1Hit&&b.high>=p.tp2){ep=p.tp2;er="TP2";s.tp2++;}
      }else{
        if(b.high>=p.sl){ep=p.sl;er=p.tp1Hit?"BE":"SL";}
        else if(!p.tp1Hit&&b.low<=p.tp1){const pq=p.qty*CFG.tp1Pct;const pnl=(p.ep-p.tp1)*pq;cap+=pnl;if(pnl>0)s.gp+=pnl;else s.gl+=Math.abs(pnl);p.tp1Hit=true;p.rem=p.qty-pq;p.sl=p.ep;s.tp1++;}
        else if(p.tp1Hit&&b.low<=p.tp2){ep=p.tp2;er="TP2";s.tp2++;}
      }
      if(!ep&&p.bars>=CFG.timeout){ep=b.close;er="T";s.tout++;}
      if(ep!==null){const pu=p.dir==="LONG"?ep-p.ep:p.ep-ep;const pnl=pu*p.rem;cap+=pnl;if(pnl>0)s.gp+=pnl;else s.gl+=Math.abs(pnl);if(er==="SL"||er==="BE")s.sl++;if(p.tp1Hit||pnl>0)wins++;closed++;pos.delete(sym);}
    }
    // Waiting sigs
    for(const[sym,sig]of sigs){
      const c=allC.get(sym)!;if(i>=c.length){sigs.delete(sym);continue;}const b=c[i];const s=st.get(sym)!;sig.w++;
      const fr=findFR(allFR.get(sym)!,c[i].time);const cur=scoreBar(c,allRSI.get(sym)!,allATR.get(sym)!,allE21.get(sym)!,i,fr);
      if(cur.score<CFG.cancelTh){sigs.delete(sym);s.can++;continue;}
      const reached=sig.dir==="LONG"?b.low<=sig.ideal*(1+CFG.zoneTol):b.high>=sig.ideal*(1-CFG.zoneTol);
      if(reached&&pos.size<CFG.maxPos&&!pos.has(sym)){const sd=Math.abs(sig.ideal-sig.sl);const qty=sd>0?(cap*CFG.risk)/sd:0;if(qty>0){pos.set(sym,{sym,ep:sig.ideal,dir:sig.dir,sl:sig.sl,tp1:sig.tp1,tp2:sig.tp2,qty,tp1Hit:false,rem:qty,bars:0});s.f2++;}sigs.delete(sym);continue;}
      const esc=sig.dir==="LONG"?b.high>sig.latest:b.low<sig.latest;if(esc){sigs.delete(sym);s.esc++;continue;}
      if(sig.w>=CFG.expiry){sigs.delete(sym);s.exp++;continue;}
    }
    // New signals
    for(const sym of PAIRS){
      if(sigs.has(sym)||pos.has(sym))continue;const lb=lastSig.get(sym)??-999;if(i-lb<CFG.cd)continue;
      const c=allC.get(sym)!;if(i>=c.length)continue;
      const fr=findFR(allFR.get(sym)!,c[i].time);const bs=scoreBar(c,allRSI.get(sym)!,allATR.get(sym)!,allE21.get(sym)!,i,fr);
      if(bs.score<75||bs.dir==="NEUTRAL")continue;
      const e55=allE55.get(sym)![i];if(!isNaN(e55)){if(bs.dir==="LONG"&&c[i].close<=e55)continue;if(bs.dir==="SHORT"&&c[i].close>=e55)continue;}
      const s=st.get(sym)!;const price=c[i].close;const atr=bs.atrV;
      const zone=calcEntryZone(price,bs.ema21V,atr,bs.dir);
      let adj=bs.score;if(zone.type==="late")adj=Math.round(adj*0.8);if(adj<75)continue;
      let sl:number,tp1:number,tp2:number;
      if(bs.dir==="LONG"){sl=price-CFG.slM*atr;tp1=price+CFG.tp1M*atr;tp2=price+CFG.tp2M*atr;}
      else{sl=price+CFG.slM*atr;tp1=price-CFG.tp1M*atr;tp2=price-CFG.tp2M*atr;}
      s.f1++;lastSig.set(sym,i);
      if(zone.type==="momentum"&&pos.size<CFG.maxPos){const sd=Math.abs(price-sl);const qty=sd>0?(cap*CFG.risk)/sd:0;if(qty>0){pos.set(sym,{sym,ep:price,dir:bs.dir,sl,tp1,tp2,qty,tp1Hit:false,rem:qty,bars:0});s.f2++;}}
      else if(zone.type!=="momentum"){sigs.set(sym,{sym,bar:i,dir:bs.dir,ideal:zone.ideal,latest:zone.latest,sl,tp1,tp2,w:0});}
    }
    if(cap>peak)peak=cap;const dd=peak>0?((peak-cap)/peak)*100:0;if(dd>maxDD)maxDD=dd;
  }
  // Close remaining
  for(const[sym,p]of pos){const c=allC.get(sym)!;const lp=c[Math.min(endBar-1,c.length-1)].close;const pnl=(p.dir==="LONG"?lp-p.ep:p.ep-lp)*p.rem;cap+=pnl;const s=st.get(sym)!;if(pnl>0)s.gp+=pnl;else s.gl+=Math.abs(pnl);closed++;if(pnl>0)wins++;}

  let gp=0,gl=0;for(const s of PAIRS){const x=st.get(s)!;gp+=x.gp;gl+=x.gl;}
  return {
    period:{trades:closed,wins,wr:closed>0?(wins/closed)*100:0,pf:gl>0?gp/gl:gp>0?Infinity:0,ret:((cap-startCapital)/startCapital)*100,dd:maxDD,capital:cap},
    pairs:st,
  };
}

async function main(){
  console.log("═══════════════════════════════════════════════════════════════════════");
  console.log("  SMART SCORER v2 VARIANTE A — TEST DE ROBUSTEZ");
  console.log("  Periodo 1 (Ano 1) vs Periodo 2 (Ano 2) + Por par");
  console.log("  Criterio: ambos periodos PF > 1.0 → aplicar a produccion");
  console.log("═══════════════════════════════════════════════════════════════════════\n");

  const allC=new Map<string,Candle[]>();
  for(const sym of PAIRS){process.stdout.write(`  Descargando ${sym}...`);const c=await loadCandles(sym,"1h",17520);allC.set(sym,c);console.log(` ${c.length} barras`);}

  const allFR=new Map<string,FundingEntry[]>();
  const fc=allC.get(PAIRS[0])!;const startMs=fc[0].time*1000,endMs=fc[fc.length-1].time*1000;
  for(const sym of PAIRS){process.stdout.write(`  Descargando FR ${sym}...`);const fr=await fetchFRHistory(sym,startMs,endMs);allFR.set(sym,fr);console.log(` ${fr.length}`);}

  const allRSI=new Map<string,number[]>(),allATR=new Map<string,number[]>(),allE21=new Map<string,number[]>(),allE55=new Map<string,number[]>();
  for(const[sym,c]of allC){const cl=c.map(x=>x.close);allRSI.set(sym,calcRSI(cl));allATR.set(sym,calcATR(c));allE21.set(sym,calcEMA(cl,21));allE55.set(sym,calcEMA(cl,55));}

  const totalBars=fc.length;
  const halfBar=Math.floor(totalBars/2);
  const midDate=new Date(fc[halfBar].time*1000).toISOString().slice(0,10);
  const startDate=new Date(fc[60].time*1000).toISOString().slice(0,10);
  const endDate=new Date(fc[totalBars-1].time*1000).toISOString().slice(0,10);

  console.log(`\n  Total barras: ${totalBars}`);
  console.log(`  Periodo 1: barra 60-${halfBar} (${startDate} → ${midDate})`);
  console.log(`  Periodo 2: barra ${halfBar}-${totalBars} (${midDate} → ${endDate})`);

  // Full run
  console.log("\n  Ejecutando periodo completo (2 anos)...");
  const full=runFull(allC,allRSI,allATR,allE21,allE55,allFR,60,totalBars,1000);

  // Period 1
  console.log("  Ejecutando periodo 1 (ano 1)...");
  const p1=runFull(allC,allRSI,allATR,allE21,allE55,allFR,60,halfBar,1000);

  // Period 2
  console.log("  Ejecutando periodo 2 (ano 2)...");
  const p2=runFull(allC,allRSI,allATR,allE21,allE55,allFR,halfBar,totalBars,1000);

  // ─── Period comparison ───
  console.log("\n═══════════════════════════════════════════════════════════════════════");
  console.log("  COMPARACION POR PERIODO");
  console.log("═══════════════════════════════════════════════════════════════════════\n");

  const phdr=["Periodo".padEnd(14),"Trades".padStart(7),"Wins".padStart(5),"WR%".padStart(7),"PF".padStart(7),"Retorno%".padStart(10),"DD%".padStart(7),"Capital".padStart(10)].join(" | ");
  console.log(phdr);console.log("-".repeat(phdr.length));

  for(const[label,r]of [["Ano 1",p1.period],["Ano 2",p2.period],["2 anos full",full.period]] as [string,PeriodResult][]){
    const pfS=r.pf===Infinity?"  inf":r.pf.toFixed(2);
    console.log([label.padEnd(14),String(r.trades).padStart(7),String(r.wins).padStart(5),(r.wr.toFixed(1)+"%").padStart(7),pfS.padStart(7),((r.ret>=0?"+":"")+r.ret.toFixed(2)+"%").padStart(10),(r.dd.toFixed(1)+"%").padStart(7),("$"+r.capital.toFixed(0)).padStart(10)].join(" | "));
  }
  console.log("-".repeat(phdr.length));

  const p1pass=p1.period.pf>1.0;const p2pass=p2.period.pf>1.0;
  console.log(`\n  Ano 1 PF > 1.0: ${p1pass?"✅ SI":"❌ NO"} (${p1.period.pf.toFixed(2)})`);
  console.log(`  Ano 2 PF > 1.0: ${p2pass?"✅ SI":"❌ NO"} (${p2.period.pf.toFixed(2)})`);

  if(p1pass&&p2pass){
    console.log("\n  ✅ AMBOS PERIODOS RENTABLES → LISTO PARA PRODUCCION");
  }else if(p1pass||p2pass){
    console.log("\n  ⚠️  SOLO UN PERIODO RENTABLE → NECESITA AJUSTES");
  }else{
    console.log("\n  ❌ NINGÚN PERIODO RENTABLE → NO APLICAR");
  }

  // ─── Per-pair breakdown (full 2 years) ───
  console.log("\n═══════════════════════════════════════════════════════════════════════");
  console.log("  RESULTADO POR PAR (2 anos completos)");
  console.log("═══════════════════════════════════════════════════════════════════════\n");

  const ppHdr=["Par".padEnd(8),"F1".padStart(5),"F2/Trades".padStart(10),"TP1".padStart(5),"TP2".padStart(5),"SL".padStart(5),"T.Out".padStart(5),"WR%".padStart(7),"PF".padStart(7),"P&L".padStart(10),"Ret%".padStart(8),"Contribuye".padStart(11)].join(" | ");
  console.log(ppHdr);console.log("-".repeat(ppHdr.length));

  let posCount=0,negCount=0;
  for(const sym of PAIRS){
    const s=full.pairs.get(sym)!;
    const pnl=s.gp-s.gl;
    const wr=s.f2>0?((s.tp1+s.tp2)/s.f2*100).toFixed(1):"0.0";
    const pf=s.gl>0?(s.gp/s.gl).toFixed(2):s.gp>0?"999":"0.00";
    const ret=(pnl/1000*100).toFixed(2);
    const icon=pnl>0?"🟢":"🔴";
    if(pnl>0)posCount++;else negCount++;
    console.log([sym.replace("USDT","").padEnd(8),String(s.f1).padStart(5),String(s.f2).padStart(10),String(s.tp1).padStart(5),String(s.tp2).padStart(5),String(s.sl).padStart(5),String(s.tout).padStart(5),(wr+"%").padStart(7),pf.padStart(7),((pnl>=0?"+":"")+"$"+pnl.toFixed(2)).padStart(10),(ret+"%").padStart(8),(icon).padStart(11)].join(" | "));
  }
  console.log("-".repeat(ppHdr.length));
  console.log(`\n  Pares positivos: ${posCount}/5 | Pares negativos: ${negCount}/5`);

  // Per-pair per-period
  console.log("\n═══════════════════════════════════════════════════════════════════════");
  console.log("  DESGLOSE POR PAR × PERIODO");
  console.log("═══════════════════════════════════════════════════════════════════════\n");

  const dpHdr=["Par".padEnd(8),"Periodo".padEnd(8),"Trades".padStart(7),"WR%".padStart(7),"PF".padStart(7),"P&L".padStart(10)].join(" | ");
  console.log(dpHdr);console.log("-".repeat(dpHdr.length));

  for(const sym of PAIRS){
    for(const[label,run]of [["Ano 1",p1],["Ano 2",p2]] as [string,typeof p1][]){
      const s=run.pairs.get(sym)!;
      const pnl=s.gp-s.gl;
      const wr=s.f2>0?((s.tp1+s.tp2)/s.f2*100).toFixed(1):"0.0";
      const pf=s.gl>0?(s.gp/s.gl).toFixed(2):s.gp>0?"999":"0.00";
      console.log([sym.replace("USDT","").padEnd(8),label.padEnd(8),String(s.f2).padStart(7),(wr+"%").padStart(7),pf.padStart(7),((pnl>=0?"+":"")+"$"+pnl.toFixed(2)).padStart(10)].join(" | "));
    }
    console.log("-".repeat(dpHdr.length));
  }

  // ─── Final verdict ───
  console.log("\n═══════════════════════════════════════════════════════════════════════");
  console.log("  VEREDICTO FINAL DE ROBUSTEZ");
  console.log("═══════════════════════════════════════════════════════════════════════");

  const consistency=p1pass&&p2pass;
  const profitable=full.period.ret>0;
  const lowDD=full.period.dd<20;
  const goodPF=full.period.pf>1.1;

  console.log(`\n  PF > 1.1 en 2 anos:     ${goodPF?"✅":"❌"} (${full.period.pf.toFixed(2)})`);
  console.log(`  DD < 20%:               ${lowDD?"✅":"❌"} (${full.period.dd.toFixed(1)}%)`);
  console.log(`  Rentable:               ${profitable?"✅":"❌"} (${full.period.ret>=0?"+":""}${full.period.ret.toFixed(2)}%)`);
  console.log(`  Consistente (ambos PF>1):${consistency?"✅":"❌"}`);
  console.log(`  Pares positivos:        ${posCount}/5`);

  if(consistency&&profitable&&lowDD&&goodPF){
    console.log("\n  🟢 APROBADO — Sistema robusto, listo para produccion");
  }else if(profitable&&(p1pass||p2pass)){
    console.log("\n  🟡 PARCIAL — Rentable pero inconsistente entre periodos");
  }else{
    console.log("\n  🔴 NO APROBADO — No cumple criterios de robustez");
  }
  console.log("═══════════════════════════════════════════════════════════════════════\n");
}

main().catch(console.error);
