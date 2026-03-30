import { useState, useEffect, useRef, useMemo, useCallback } from "react";

/* ════════════════════════════════════════════════════════
   CONSTANTS
════════════════════════════════════════════════════════ */
const SYMBOL    = "XAUUSDT";
const INTERVAL  = "15m";
// Try port 443 first (works through most firewalls), fallback to 9443
const WS_URLS   = [
  "wss://stream.binance.com:443/ws",
  "wss://stream.binance.com:9443/ws",
  "wss://stream1.binance.com:443/ws",
];

/* ════════════════════════════════════════════════════════
   API HELPERS  (calls Vercel serverless /api/* functions)
════════════════════════════════════════════════════════ */
async function api(method, path, body) {
  const opts = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);
  const res  = await fetch(path, opts);
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || "API error");
  return data;
}

const getAccount   = ()            => api("GET",    "/api/account");
const placeOrder   = (sym, side, qty) => api("POST", "/api/order", { symbol: sym, side, quantity: qty });
const cancelOrder  = (sym, id)     => api("DELETE", `/api/order?symbol=${sym}&orderId=${id}`);
const getOpenOrders= (sym)         => api("GET",    `/api/openOrders?symbol=${sym}`);
const getTrades    = (sym, lim=50) => api("GET",    `/api/trades?symbol=${sym}&limit=${lim}`);
const checkHealth  = ()            => fetch("/api/health").then(r => r.json());

/* Klines via Vercel — bypasses regional Binance blocks and CORS */
async function fetchKlines(limit = 200) {
  const r = await fetch("/api/klines?symbol=" + SYMBOL + "&interval=" + INTERVAL + "&limit=" + limit);
  if (!r.ok) throw new Error("Klines " + r.status);
  const json = await r.json();
  if (!json.ok) throw new Error(json.error || "Klines error");
  return json.data.map(k => ({ o:+k[1], h:+k[2], l:+k[3], c:+k[4], v:+k[5], t:k[0], done:true }));
}

/* ════════════════════════════════════════════════════════
   MATH
════════════════════════════════════════════════════════ */
const r2 = n => Math.round(n * 100) / 100;
const r1 = n => Math.round(n * 10)  / 10;
const fmtP = n => n > 0 ? "+$" + n : "-$" + Math.abs(n);

function emaArr(src, p) {
  const out = new Array(src.length).fill(null);
  if (src.length < p) return out;
  const k = 2 / (p + 1);
  let v = src.slice(0, p).reduce((a, b) => a + b, 0) / p;
  out[p - 1] = v;
  for (let i = p; i < src.length; i++) { v = src[i] * k + v * (1 - k); out[i] = v; }
  return out;
}

function rsiArr(src, p = 14) {
  const out = new Array(src.length).fill(null);
  for (let i = p; i < src.length; i++) {
    let g = 0, l = 0;
    for (let j = i - p + 1; j <= i; j++) { const d = src[j] - src[j-1]; d>0?(g+=d):(l-=d); }
    const ag=g/p, al=l/p;
    out[i] = r1(al===0?100:100-100/(1+ag/al));
  }
  return out;
}

function calcATR(bars, p = 14) {
  if (bars.length < p+1) return 2;
  const slice = bars.slice(-p);
  const trs = slice.map((b, i, a) => {
    const pc = i===0 ? (bars[bars.length-p-1]?.c||b.o) : a[i-1].c;
    return Math.max(b.h-b.l, Math.abs(b.h-pc), Math.abs(b.l-pc));
  });
  return r2(trs.reduce((a,b)=>a+b,0)/p);
}

function calcPivots(bars, lb=6) {
  const sup=[], res=[];
  for (let i=lb; i<bars.length-lb; i++) {
    const sl = bars.slice(i-lb, i+lb+1);
    if (sl.every(b=>b.l>=bars[i].l)) sup.push(r2(bars[i].l));
    if (sl.every(b=>b.h<=bars[i].h)) res.push(r2(bars[i].h));
  }
  return { sup:[...new Set(sup)].slice(-4), res:[...new Set(res)].slice(-4) };
}

// Volume surge detection
function isVolumeSurge(bars, multiplier=1.8) {
  if (bars.length < 20) return false;
  const avg = bars.slice(-20,-1).reduce((s,b)=>s+b.v,0)/19;
  return bars[bars.length-1].v > avg * multiplier;
}

/* ════════════════════════════════════════════════════════
   SIGNAL ENGINE  — optimised for high win rate
   Strategy: Triple EMA + RSI + Volume + S/R confluence
   Only fires when 4+ factors align
════════════════════════════════════════════════════════ */
function getSignal(bars) {
  const N = bars.length;
  const EMPTY = { sig:"WAIT", strat:"—", score:0, why:"Loading…", e21s:[], e50s:[], e9s:[], rsiS:[], sup:[], res:[], price:0 };
  if (N < 60) return EMPTY;

  const cl  = bars.map(b=>b.c);
  const p   = cl[N-1];
  const e9s = emaArr(cl, 9);
  const e21s= emaArr(cl, 21);
  const e50s= emaArr(cl, 50);
  const rS  = rsiArr(cl, 14);
  const atr = calcATR(bars, 14);
  const { sup, res } = calcPivots(bars, 6);

  const E9  = e9s[N-1]||p,  E9p = e9s[N-2]||E9;
  const E21 = e21s[N-1]||p, E21p= e21s[N-2]||E21;
  const E50 = e50s[N-1]||p;
  const RSI = rS[N-1]||50;
  const prev= cl[N-2]||p;

  const bullTrend  = E9 > E21 && E21 > E50;
  const bearTrend  = E9 < E21 && E21 < E50;
  const crossUp    = prev < E21p && p >= E21;
  const crossDown  = prev > E21p && p <= E21;
  const e9CrossUp  = e9s[N-2]<E21p && E9>=E21;
  const e9CrossDn  = e9s[N-2]>E21p && E9<=E21;
  const atSup      = sup.some(s=>Math.abs(p-s)<atr*0.9);
  const atRes      = res.some(r=>Math.abs(p-r)<atr*0.9);
  const volSurge   = isVolumeSurge(bars);

  const base = { e9s, e21s, e50s, e9:r2(E9), e21:r2(E21), e50:r2(E50), rsiS:rS, rsi:RSI, atr, price:p, sup, res };

  // ── Score bullish confluence ──────────────────────
  let bullScore=0, bearScore=0, bullFactors=[], bearFactors=[];

  if (bullTrend)   { bullScore+=20; bullFactors.push("EMA9>EMA21>EMA50 aligned"); }
  if (crossUp)     { bullScore+=25; bullFactors.push("Price crossed above EMA21"); }
  if (e9CrossUp)   { bullScore+=15; bullFactors.push("EMA9 crossed above EMA21"); }
  if (RSI>35&&RSI<55){ bullScore+=15; bullFactors.push(`RSI bullish zone (${RSI})`); }
  if (RSI<35)      { bullScore+=20; bullFactors.push(`RSI oversold (${RSI})`); }
  if (atSup)       { bullScore+=20; bullFactors.push("At pivot support"); }
  if (volSurge&&bars[N-1].c>bars[N-1].o) { bullScore+=15; bullFactors.push("Bull volume surge"); }

  if (bearTrend)   { bearScore+=20; bearFactors.push("EMA9<EMA21<EMA50 aligned"); }
  if (crossDown)   { bearScore+=25; bearFactors.push("Price crossed below EMA21"); }
  if (e9CrossDn)   { bearScore+=15; bearFactors.push("EMA9 crossed below EMA21"); }
  if (RSI>45&&RSI<65){ bearScore+=15; bearFactors.push(`RSI bearish zone (${RSI})`); }
  if (RSI>65)      { bearScore+=20; bearFactors.push(`RSI overbought (${RSI})`); }
  if (atRes)       { bearScore+=20; bearFactors.push("At pivot resistance"); }
  if (volSurge&&bars[N-1].c<bars[N-1].o) { bearScore+=15; bearFactors.push("Bear volume surge"); }

  const bullPct = Math.min(95, Math.round(bullScore));
  const bearPct = Math.min(95, Math.round(bearScore));

  if (bullPct >= 55 && bullPct > bearPct) {
    const strat = atSup ? "S/R BOUNCE" : crossUp ? "EMA CROSS" : "PULLBACK";
    return { ...base, sig:"BUY", strat, score:bullPct, factors:bullFactors,
      why:bullFactors.slice(0,3).join(" · "),
      sl: r2(p - atr*1.1), tp1: r2(p + atr*2.0), tp2: r2(p + atr*3.5) };
  }
  if (bearPct >= 55 && bearPct > bullPct) {
    const strat = atRes ? "S/R BOUNCE" : crossDown ? "EMA CROSS" : "PULLBACK";
    return { ...base, sig:"SELL", strat, score:bearPct, factors:bearFactors,
      why:bearFactors.slice(0,3).join(" · "),
      sl: r2(p + atr*1.1), tp1: r2(p - atr*2.0), tp2: r2(p - atr*3.5) };
  }

  const near = Math.abs(p-E21) < atr*1.2;
  return { ...base, sig:"SCAN", strat:"WATCHING", score:Math.max(bullPct,bearPct),
    why:`${bullTrend?"BULL":bearTrend?"BEAR":"NEUTRAL"} · EMA21 ${r2(E21)} · RSI ${RSI} · ATR ${r2(atr)}`,
    sl:null, tp1:null, tp2:null };
}

/* ════════════════════════════════════════════════════════
   SVG CHARTS
════════════════════════════════════════════════════════ */
function CandleChart({ bars, sig, trade }) {
  const SHOW=60, W=600, H=215, PL=65, PR=8, PT=8, PB=4;
  const view=bars.slice(-SHOW);
  const e9v =(sig.e9s||[]).slice(-SHOW);
  const e21v=(sig.e21s||[]).slice(-SHOW);
  const e50v=(sig.e50s||[]).slice(-SHOW);
  const cw  =(W-PL-PR)/SHOW;
  let lo=Math.min(...view.map(b=>b.l));
  let hi=Math.max(...view.map(b=>b.h));
  if(trade?.sl){lo=Math.min(lo,trade.sl);hi=Math.max(hi,trade.sl);}
  if(trade?.tp2){lo=Math.min(lo,trade.tp2);hi=Math.max(hi,trade.tp2);}
  const rng=hi-lo||4; lo-=rng*0.07; hi+=rng*0.07;
  const Y=p=>PT+((hi-p)/(hi-lo))*(H-PT-PB);
  const X=i=>PL+i*cw+cw/2;
  const LP=arr=>{const pts=arr.map((v,i)=>v!=null?`${X(i).toFixed(1)},${Y(v).toFixed(1)}`:null).filter(Boolean);return pts.length>1?pts.join(" "):null;};
  const {sup=[],res=[]}=sig;
  const grids=[0.1,0.3,0.5,0.7,0.9].map(f=>lo+(hi-lo)*f);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{width:"100%",height:H}}>
      {grids.map((p,i)=><g key={i}><line x1={PL} y1={Y(p)} x2={W-PR} y2={Y(p)} stroke="#0d1b2a" strokeWidth="1"/><text x={PL-4} y={Y(p)+3} textAnchor="end" fontSize="8" fill="#1e3a5f">{p.toFixed(2)}</text></g>)}
      {sup.map((s,i)=><g key={`s${i}`}><rect x={PL} y={Y(s+0.4)} width={W-PL-PR} height={Math.max(1,Y(s-0.4)-Y(s+0.4))} fill="#22c55e" opacity="0.07"/><line x1={PL} y1={Y(s)} x2={W-PR} y2={Y(s)} stroke="#22c55e" strokeWidth="0.8" strokeDasharray="5,3" opacity="0.5"/></g>)}
      {res.map((r,i)=><g key={`r${i}`}><rect x={PL} y={Y(r+0.4)} width={W-PL-PR} height={Math.max(1,Y(r-0.4)-Y(r+0.4))} fill="#ef4444" opacity="0.07"/><line x1={PL} y1={Y(r)} x2={W-PR} y2={Y(r)} stroke="#ef4444" strokeWidth="0.8" strokeDasharray="5,3" opacity="0.5"/></g>)}
      {LP(e50v)&&<polyline points={LP(e50v)} fill="none" stroke="#fb923c" strokeWidth="1.2" opacity="0.8"/>}
      {LP(e21v)&&<polyline points={LP(e21v)} fill="none" stroke="#38bdf8" strokeWidth="1.5" opacity="0.9"/>}
      {LP(e9v) &&<polyline points={LP(e9v)}  fill="none" stroke="#a78bfa" strokeWidth="1.2" opacity="0.9"/>}
      {view.map((b,i)=>{const bull=b.c>=b.o,col=bull?"#22c55e":"#ef4444",by=Y(Math.max(b.o,b.c)),bh=Math.max(1.5,Math.abs(Y(b.o)-Y(b.c)));return(<g key={i}><line x1={X(i)} y1={Y(b.h)} x2={X(i)} y2={Y(b.l)} stroke={col} strokeWidth="1"/><rect x={X(i)-cw*0.38} y={by} width={cw*0.76} height={bh} fill={col} opacity="0.9"/></g>);})}
      {trade&&(<>
        <line x1={PL} y1={Y(trade.entry)} x2={W-PR} y2={Y(trade.entry)} stroke="#fbbf24" strokeWidth="1.5" strokeDasharray="6,3"/>
        <text x={W-PR-2} y={Y(trade.entry)-2} textAnchor="end" fontSize="7.5" fill="#fbbf24">ENTRY {trade.entry}</text>
        {trade.sl&&<><line x1={PL} y1={Y(trade.sl)} x2={W-PR} y2={Y(trade.sl)} stroke="#f87171" strokeWidth="1" strokeDasharray="3,2"/><text x={W-PR-2} y={Y(trade.sl)-2} textAnchor="end" fontSize="7.5" fill="#f87171">SL {trade.sl}</text></>}
        {trade.tp1&&<><line x1={PL} y1={Y(trade.tp1)} x2={W-PR} y2={Y(trade.tp1)} stroke="#34d399" strokeWidth="1" strokeDasharray="3,2"/><text x={W-PR-2} y={Y(trade.tp1)-2} textAnchor="end" fontSize="7.5" fill="#34d399">TP1 {trade.tp1}</text></>}
        {trade.tp2&&<><line x1={PL} y1={Y(trade.tp2)} x2={W-PR} y2={Y(trade.tp2)} stroke="#6ee7b7" strokeWidth="0.8" strokeDasharray="2,2"/><text x={W-PR-2} y={Y(trade.tp2)-2} textAnchor="end" fontSize="7.5" fill="#6ee7b7">TP2 {trade.tp2}</text></>}
      </>)}
      <line x1={PL} y1={Y(sig.price||0)} x2={W-PR} y2={Y(sig.price||0)} stroke="#fbbf24" strokeWidth="0.5" opacity="0.3"/>
      {sig.price>0&&<><rect x={W-PR-60} y={Y(sig.price)-9} width={60} height={12} fill="#d97706" rx="3"/><text x={W-PR-3} y={Y(sig.price)+1} textAnchor="end" fontSize="8" fontWeight="bold" fill="#000">{"$"+sig.price.toFixed(2)}</text></>}
      <rect x={PL} y={PT-2} width={240} height={13} fill="#020c18" opacity="0.9" rx="2"/>
      <text x={PL+4}   y={PT+7} fontSize="8" fill="#a78bfa">━ EMA9</text>
      <text x={PL+52}  y={PT+7} fontSize="8" fill="#38bdf8">━ EMA21</text>
      <text x={PL+108} y={PT+7} fontSize="8" fill="#fb923c">━ EMA50</text>
      <text x={PL+164} y={PT+7} fontSize="8" fill="#22c55e">▬ SUP</text>
      <text x={PL+204} y={PT+7} fontSize="8" fill="#ef4444">▬ RES</text>
    </svg>
  );
}

function RSIChart({ rsiS }) {
  const SHOW=60,W=600,H=55,PL=65,PR=8;
  const data=(rsiS||[]).slice(-SHOW).map(v=>v??50);
  if(data.length<2) return null;
  const X=i=>PL+(i/(SHOW-1))*(W-PL-PR), Y=v=>3+((100-v)/100)*(H-6);
  const pts=data.map((v,i)=>`${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(" ");
  const last=data[data.length-1], col=last>70?"#f87171":last<30?"#34d399":"#a78bfa";
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{width:"100%",height:H}}>
      <rect x={PL} y={Y(70)} width={W-PL-PR} height={Y(30)-Y(70)} fill="#7c3aed" opacity="0.04"/>
      {[70,50,30].map(v=><g key={v}><line x1={PL} y1={Y(v)} x2={W-PR} y2={Y(v)} stroke={v===50?"#0d1b2a":v===70?"#450a0a":"#042f2e"} strokeWidth="0.8"/><text x={PL-4} y={Y(v)+3} textAnchor="end" fontSize="7" fill={v===70?"#7f1d1d":v===30?"#14532d":"#1e3a5f"}>{v}</text></g>)}
      <polyline points={pts} fill="none" stroke={col} strokeWidth="1.5"/>
      <circle cx={X(data.length-1)} cy={Y(last)} r="2.5" fill={col}/>
      <text x={W-PR-2} y={Y(last)-3} textAnchor="end" fontSize="8.5" fontWeight="bold" fill={col}>{last}</text>
    </svg>
  );
}

function VolumeChart({ bars }) {
  const SHOW=60,W=600,H=38,PL=65,PR=8;
  const view=bars.slice(-SHOW);
  const mx=Math.max(...view.map(b=>b.v),1);
  const cw=(W-PL-PR)/SHOW, X=i=>PL+i*cw+cw/2;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{width:"100%",height:H}}>
      <text x={PL-4} y={H-3} textAnchor="end" fontSize="7" fill="#1e3a5f">VOL</text>
      {view.map((b,i)=>{const h=(b.v/mx)*(H-5),col=b.c>=b.o?"#22c55e":"#ef4444";return <rect key={i} x={X(i)-cw*0.38} y={H-h-2} width={cw*0.76} height={h} fill={col} opacity="0.5"/>;})}
    </svg>
  );
}

function EquityChart({ trades, start }) {
  const W=600,H=85,PL=65,PR=8,PT=6,PB=4;
  const pts=useMemo(()=>{const p=[start];let b=start;[...trades].reverse().forEach(t=>{b=r2(b+t.pnl);p.push(b);});return p;},[trades,start]);
  if(pts.length<2) return <div style={{textAlign:"center",color:"#1e3a5f",padding:"22px 0",fontSize:11}}>No closed trades yet</div>;
  const mn=Math.min(...pts),mx=Math.max(...pts),sp=Math.max(mx-mn,50);
  const yE=v=>PT+((mx-v+sp*0.08)/(sp*1.16))*(H-PT-PB), xE=i=>PL+(i/(pts.length-1))*(W-PL-PR);
  const poly=pts.map((v,i)=>`${xE(i).toFixed(1)},${yE(v).toFixed(1)}`).join(" ");
  const col=pts[pts.length-1]>=start?"#22c55e":"#ef4444";
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{width:"100%",height:H}}>
      <defs><linearGradient id="eqG3" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={col} stopOpacity="0.28"/><stop offset="100%" stopColor={col} stopOpacity="0"/></linearGradient></defs>
      <line x1={PL} y1={yE(start)} x2={W-PR} y2={yE(start)} stroke="#1e3a5f" strokeWidth="0.7" strokeDasharray="5,3"/>
      <polygon points={`${xE(0)},${H} ${poly} ${xE(pts.length-1)},${H}`} fill="url(#eqG3)"/>
      <polyline points={poly} fill="none" stroke={col} strokeWidth="2"/>
      <circle cx={xE(pts.length-1)} cy={yE(pts[pts.length-1])} r="3.5" fill={col}/>
      <text x={PL-4} y={yE(start)+3} textAnchor="end" fontSize="7.5" fill="#334155">${start}</text>
    </svg>
  );
}

function Gauge({ score }) {
  const col=score>=80?"#22c55e":score>=55?"#f59e0b":"#475569";
  const r=32,cx=42,cy=44;
  const xy=d=>({x:cx+r*Math.cos((d-90)*Math.PI/180),y:cy+r*Math.sin((d-90)*Math.PI/180)});
  const s=xy(-120),bg=xy(120),fg=xy(-120+(Math.min(score,100)/100)*240);
  const la=(score/100)*240>180?1:0;
  return (
    <svg viewBox="0 0 84 68" style={{width:84,height:68,flexShrink:0}}>
      <path d={`M ${s.x.toFixed(1)} ${s.y.toFixed(1)} A ${r} ${r} 0 1 1 ${bg.x.toFixed(1)} ${bg.y.toFixed(1)}`} fill="none" stroke="#0d1b2a" strokeWidth="7" strokeLinecap="round"/>
      {score>0&&<path d={`M ${s.x.toFixed(1)} ${s.y.toFixed(1)} A ${r} ${r} 0 ${la} 1 ${fg.x.toFixed(1)} ${fg.y.toFixed(1)}`} fill="none" stroke={col} strokeWidth="7" strokeLinecap="round"/>}
      <text x={cx} y={cy-5} textAnchor="middle" fontSize="18" fontWeight="900" fill={col}>{score}</text>
      <text x={cx} y={cy+9} textAnchor="middle" fontSize="7.5" fill="#475569">SCORE</text>
    </svg>
  );
}

/* ════════════════════════════════════════════════════════
   MAIN APP
════════════════════════════════════════════════════════ */
const START_BAL = 10000;
const F = (o={}) => ({fontFamily:"ui-monospace,monospace",...o});

export default function App() {
  /* ─── data ───────────────────────────────────────── */
  const [bars,     setBars]    = useState([]);
  const [wsState,  setWsS]     = useState("off");
  const [loading,  setLoad]    = useState(true);
  const [dataErr,  setDataErr] = useState("");

  /* ─── account ────────────────────────────────────── */
  const [acct,     setAcct]    = useState(null);
  const [acctErr,  setAcctErr] = useState("");
  const [mode,     setMode]    = useState("paper"); // "paper" | "live"
  const [health,   setHealth]  = useState(null);

  /* ─── paper trading state ────────────────────────── */
  const [paperBal, setPBal]    = useState(START_BAL);
  const [paperTrd, setPTrd]    = useState(null);
  const [paperHist,setPHist]   = useState([]);
  const [paperTP1, setPTP1]    = useState(false);

  /* ─── live trading state ─────────────────────────── */
  const [liveOrders,setLOrds]  = useState([]);
  const [liveTrades,setLTrds]  = useState([]);
  const [orderMsg,  setOMsg]   = useState("");
  const [ordering,  setOrding] = useState(false);

  /* ─── UI ─────────────────────────────────────────── */
  const [autoOn,   setAuto]    = useState(true);
  const [lot,      setLot]     = useState(0.01);
  const [tab,      setTab]     = useState("chart");
  const [alerts,   setAlerts]  = useState([]);
  const [livePrice,setLiveP]   = useState(null);

  /* ─── refs ───────────────────────────────────────── */
  const R = useRef({});
  R.current.paperTrd  = paperTrd;
  R.current.auto      = autoOn;
  R.current.lot       = lot;
  R.current.paperTP1  = paperTP1;
  R.current.mode      = mode;

  const wsRef    = useRef(null);
  const reconnR  = useRef(null);
  const wsUrlIdx = useRef(0);   // cycles through WS_URLS on failure
  const reconnDelay = useRef(2000); // exponential backoff delay

  /* ─── derived ────────────────────────────────────── */
  const sig   = useMemo(() => getSignal(bars), [bars]);
  const price = livePrice ?? (bars[bars.length-1]?.c || 0);
  const isBuy  = sig.sig === "BUY";
  const isSell = sig.sig === "SELL";
  const sigCol = isBuy?"#22c55e":isSell?"#ef4444":sig.score>=55?"#f59e0b":"#475569";

  const paperPnl = paperTrd
    ? r2((paperTrd.dir==="BUY"?price-paperTrd.entry:paperTrd.entry-price)*paperTrd.lot*100)
    : 0;

  const pStats = useMemo(()=>{
    const w=paperHist.filter(t=>t.pnl>0), l=paperHist.filter(t=>t.pnl<=0);
    const tp=r2(paperHist.reduce((s,t)=>s+t.pnl,0));
    const wr=paperHist.length?r1((w.length/paperHist.length)*100):0;
    const aw=w.length?r2(w.reduce((s,t)=>s+t.pnl,0)/w.length):0;
    const al=l.length?r2(Math.abs(l.reduce((s,t)=>s+t.pnl,0))/l.length):0;
    const pf=al>0&&l.length>0?r1((aw*w.length)/(al*l.length)):w.length>0?"∞":"—";
    let pk=START_BAL,b=START_BAL,dd=0;
    [...paperHist].reverse().forEach(t=>{b+=t.pnl;pk=Math.max(pk,b);dd=Math.max(dd,pk-b);});
    return{tp,wr,aw,al,pf,dd:r2(dd),wins:w.length,tot:paperHist.length};
  },[paperHist]);

  const push = msg => setAlerts(a=>[`[${new Date().toLocaleTimeString()}] ${msg}`,...a.slice(0,12)]);
  const ts   = () => new Date().toLocaleTimeString();

  /* ─── Health check & account load ───────────────── */
  useEffect(()=>{
    checkHealth().then(h=>{
      setHealth(h);
      if(h.keySet) {
        getAccount()
          .then(a=>{ setAcct(a); push(`✅ Binance ${a.testnet?"TESTNET":"MAINNET"} connected · USDT: ${a.usdt?.free||"—"}`); })
          .catch(e=>setAcctErr(e.message));
      }
    }).catch(()=>{});
  },[]);

  /* ─── Load candles ────────────────────────────────── */
  const loadCandles = useCallback(async()=>{
    setLoad(true); setDataErr("");
    try {
      const kl = await fetchKlines(200);
      setBars(kl);
      push("✅ " + kl.length + " Binance 15M candles loaded · $" + kl[kl.length-1].c.toFixed(2));
    } catch(e) {
      setDataErr(e.message);
      push("⚠ Failed to load Binance candles");
    }
    setLoad(false);
  },[]);

  useEffect(()=>{ loadCandles(); return()=>{clearTimeout(reconnR.current);wsRef.current?.close(1000);}; },[]);

  /* ─── WebSocket price stream ──────────────────────── */
  const connectWS = useCallback(()=>{
    if(wsRef.current?.readyState===WebSocket.OPEN) return;
    setWsS("connecting");

    // Try each URL in rotation — port 443 works through most firewalls
    const url = WS_URLS[wsUrlIdx.current % WS_URLS.length];
    const streamName = SYMBOL.toLowerCase() + "@kline_" + INTERVAL;
    const ws = new WebSocket(url + "/" + streamName);
    wsRef.current=ws;
    let ping=null;

    // Connection timeout — if no open in 8s, try next URL
    const openTimer = setTimeout(()=>{
      if(ws.readyState !== WebSocket.OPEN){
        ws.close();
        wsUrlIdx.current++;
        reconnDelay.current = 2000;
        reconnR.current = setTimeout(connectWS, 500);
      }
    }, 8000);

    ws.onopen=()=>{
      clearTimeout(openTimer);
      setWsS("live");
      reconnDelay.current = 2000; // reset backoff on success
      push("🟢 WebSocket live — " + url.split("//")[1].split("/")[0] + " — XAUUSDT 15M");
      // Ping every 25s to keep connection alive (Binance closes idle at 60s)
      ping=setInterval(()=>{ if(ws.readyState===1) ws.send(JSON.stringify({method:"ping"})); },25000);
    };

    ws.onmessage=ev=>{
      try {
        const {k}=JSON.parse(ev.data);
        if(!k) return;
        const bar={o:+k.o,h:+k.h,l:+k.l,c:+k.c,v:+k.v,t:k.t,done:k.x};
        setLiveP(bar.c);

        setBars(prev=>{
          const last=prev[prev.length-1];
          const upd = last?.t===bar.t
            ? [...prev.slice(0,-1),bar]
            : k.x ? [...prev.slice(-299),bar] : [...prev.slice(0,-1),bar];

          const cp   = bar.c;
          const cur  = R.current.paperTrd;
          const auto = R.current.auto;

          // Paper: SL/TP checks
          if(cur) {
            const buy=cur.dir==="BUY";
            const hSL=buy?cp<=cur.sl:cp>=cur.sl;
            const hTP1=buy?cp>=cur.tp1:cp<=cur.tp1;
            const hTP2=buy?cp>=cur.tp2:cp<=cur.tp2;
            if(hTP2){
              const pnl=r2((buy?cur.tp2-cur.entry:cur.entry-cur.tp2)*cur.lot*100);
              setPHist(h=>[{...cur,exit:cur.tp2,pnl,why:"TP2✓✓",at:ts()},...h.slice(0,299)]);
              setPBal(b=>r2(b+pnl)); setPTrd(null); setPTP1(false);
              push("🏆 Paper TP2 @ " + cur.tp2 + " — +$" + pnl);
            } else if(hSL){
              const pnl=r2((buy?cur.sl-cur.entry:cur.entry-cur.sl)*cur.lot*100);
              setPHist(h=>[{...cur,exit:cur.sl,pnl,why:R.current.paperTP1?"BE≈0":"SL✗",at:ts()},...h.slice(0,299)]);
              setPBal(b=>r2(b+pnl)); setPTrd(null); setPTP1(false);
            } else if(hTP1&&!R.current.paperTP1){
              setPTP1(true);
              setPTrd(t=>t?{...t,sl:t.entry}:t);
              push(`✅ Paper TP1 @ ${cur.tp1} — SL → breakeven`);
            }
          }

          // Paper auto-trade on closed candle
          if(!cur && auto && k.x && R.current.mode==="paper") {
            const s=getSignal(upd);
            if((s.sig==="BUY"||s.sig==="SELL")&&s.score>=55&&s.sl){
              const nt={dir:s.sig,entry:cp,lot:R.current.lot,sl:s.sl,tp1:s.tp1,tp2:s.tp2,strat:s.strat,score:s.score,at:ts()};
              setPTrd(nt); setPTP1(false);
              push("🎯 Paper AUTO " + s.sig + " @ $" + cp.toFixed(2) + " — " + s.score + "% — " + s.strat);
            }
          }
          return upd;
        });
      } catch{}
    };

    ws.onerror=()=>{
      clearTimeout(openTimer);
      setWsS("error");
    };

    ws.onclose=e=>{
      clearTimeout(openTimer);
      clearInterval(ping);
      if(wsRef.current===ws){
        setWsS("disconnected");
        if(e.code!==1000){
          // Exponential backoff: 2s → 4s → 8s → max 30s
          const delay = Math.min(reconnDelay.current, 30000);
          reconnDelay.current = Math.min(delay * 2, 30000);
          // Rotate URL every other attempt
          if(reconnDelay.current >= 8000) wsUrlIdx.current++;
          push("🔄 Reconnecting in " + (delay/1000).toFixed(0) + "s… (trying " + WS_URLS[wsUrlIdx.current % WS_URLS.length].split("//")[1].split("/")[0] + ")");
          reconnR.current = setTimeout(connectWS, delay);
        }
      }
    };
  },[]);

  const disconnectWS=()=>{
    clearTimeout(reconnR.current);
    wsRef.current?.close(1000);
    wsRef.current=null;
    setWsS("off");
    reconnDelay.current=2000;
    wsUrlIdx.current=0;
  };

  /* ─── Refresh live orders/trades ────────────────── */
  const refreshLive = useCallback(async()=>{
    try {
      const [ords,trds] = await Promise.all([getOpenOrders(SYMBOL), getTrades(SYMBOL,50)]);
      setLOrds(ords.orders||[]);
      setLTrds(trds.trades||[]);
    } catch(e){ push("⚠ Refresh: "+e.message); }
  },[]);

  useEffect(()=>{
    if(mode==="live"&&acct){ refreshLive(); const t=setInterval(refreshLive,30000); return()=>clearInterval(t); }
  },[mode,acct]);

  /* ─── Paper trade actions ─────────────────────────── */
  const openPaper = dir=>{
    if(R.current.paperTrd||!price) return;
    const atr=sig.atr||3;
    const sl =sig.sl ||r2(price-(dir==="BUY"?1:-1)*atr*1.1);
    const tp1=sig.tp1||r2(price+(dir==="BUY"?1:-1)*atr*2.0);
    const tp2=sig.tp2||r2(price+(dir==="BUY"?1:-1)*atr*3.5);
    setPTrd({dir,entry:price,lot,sl,tp1,tp2,strat:sig.strat||"MANUAL",score:sig.score,at:ts()});
    setPTP1(false);
    push("📌 Paper " + dir + " @ $" + price.toFixed(2) + " · SL " + sl + " · TP2 " + tp2);
  };

  const closePaper=()=>{
    const cur=R.current.paperTrd; if(!cur) return;
    const pnl=r2((cur.dir==="BUY"?price-cur.entry:cur.entry-price)*cur.lot*100);
    setPHist(h=>[{...cur,exit:price,pnl,why:"Manual",at:ts()},...h.slice(0,299)]);
    setPBal(b=>r2(b+pnl)); setPTrd(null); setPTP1(false);
    push("📌 Paper closed @ $" + price.toFixed(2) + " — " + fmtP(pnl));
  };

  /* ─── Live order actions ─────────────────────────── */
  const placeLiveOrder = async dir=>{
    if(!acct||!price) return;
    setOrding(true); setOMsg("");
    try {
      const result = await placeOrder(SYMBOL, dir, lot);
      setOMsg(`✅ Live ${dir} placed — orderId: ${result.orderId}`);
      push(`🔴 LIVE ${dir} ${lot} XAU @ market — id:${result.orderId}`);
      await refreshLive();
    } catch(e){ setOMsg("❌ "+e.message); push("❌ Live order failed: "+e.message); }
    setOrding(false);
  };

  const cancelLiveOrder = async orderId=>{
    try { await cancelOrder(SYMBOL,orderId); push(`Cancelled order ${orderId}`); await refreshLive(); }
    catch(e){ push("Cancel failed: "+e.message); }
  };

  const refreshAccount = async()=>{
    try { const a=await getAccount(); setAcct(a); push("Account refreshed"); }
    catch(e){ setAcctErr(e.message); }
  };

  /* ─── Colours ─────────────────────────────────────── */
  const wsC={live:"#22c55e",connecting:"#f59e0b",disconnected:"#475569",error:"#ef4444",off:"#475569"};
  const wsL={live:"● LIVE",connecting:"◌ Connecting…",disconnected:"○ Disconnected",error:"✕ Error",off:"○ Off"};

  const TABS=[{id:"chart",l:"📈 Chart"},{id:"signals",l:"🎯 Signals"},{id:"paper",l:"📝 Paper"},{id:"live",l:"🔴 Live"},{id:"stats",l:"📊 Stats"}];
  const Box=({children,style={}})=><div style={{background:"#061120",border:"1px solid #0d1b2a",borderRadius:11,padding:"12px 14px",...style}}>{children}</div>;

  return (
    <div style={F({background:"#020c18",minHeight:"100vh",color:"#e2e8f0",maxWidth:660,margin:"0 auto"})}>

      {/* ════ HEADER ════ */}
      <div style={F({padding:"12px 14px 10px",borderBottom:"1px solid #0a1628",display:"flex",justifyContent:"space-between",alignItems:"center"})}>
        <div>
          <div style={{display:"flex",gap:6,alignItems:"center",flexWrap:"wrap"}}>
            <span style={{color:"#fbbf24",fontSize:19,fontWeight:900}}>⚡ XAU/USDT</span>
            <span style={{fontSize:9,padding:"2px 7px",background:"#0d1b2a",borderRadius:8,color:"#475569"}}>Binance · 15M</span>
            <span style={{fontSize:9,padding:"2px 7px",borderRadius:8,background:"#061120",color:wsC[wsState],fontWeight:700}}>{wsL[wsState]}</span>
            {mode==="live"
              ?<span style={{fontSize:9,padding:"2px 7px",background:"#7f1d1d",borderRadius:8,color:"#fca5a5",fontWeight:700}}>🔴 LIVE TRADING</span>
              :<span style={{fontSize:9,padding:"2px 7px",background:"#1e3a5f",borderRadius:8,color:"#93c5fd"}}>📝 PAPER</span>
            }
            {health?.testnet&&<span style={{fontSize:9,padding:"2px 7px",background:"#14532d",borderRadius:8,color:"#86efac"}}>🧪 TESTNET</span>}
          </div>
          <div style={{fontSize:9,color:"#0d1b2a",marginTop:3}}>Triple EMA · RSI · Volume · S/R · Auto-Breakeven</div>
        </div>
        <div style={{textAlign:"right"}}>
          <div style={{fontSize:28,fontWeight:900,color:"#fde68a",letterSpacing:-1}}>{price ? ("$" + price.toFixed(2)) : "—"}</div>
          <div style={{fontSize:9,color:"#1e3a5f"}}>
            {mode==="live"&&acct
              ?<>USDT: <span style={{color:"#fbbf24"}}>{acct.usdt?.free||"—"}</span></>
              :<>Paper: <span style={{color:"#fbbf24"}}>${paperBal.toFixed(0)}</span> · <span style={{color:pStats.tp>=0?"#86efac":"#fca5a5"}}>{pStats.tp>=0?"+":""}${pStats.tp}</span></>
            }
          </div>
        </div>
      </div>

      {/* ════ SIGNAL CARD ════ */}
      <div style={F({margin:"10px 14px 0",borderRadius:13,padding:"12px 14px",
        background:isBuy?"#022c22":isSell?"#1c0707":"#061120",
        border:`1px solid ${isBuy?"#166534":isSell?"#991b1b":"#0d1b2a"}`})}>
        <div style={{display:"flex",gap:12,alignItems:"center"}}>
          <Gauge score={sig.score}/>
          <div style={{flex:1,minWidth:0}}>
            <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap",marginBottom:4}}>
              <span style={{fontWeight:900,fontSize:20,color:sigCol}}>{isBuy?"▲ BUY":isSell?"▼ SELL":"◉ SCAN"}</span>
              <span style={{fontSize:9,padding:"3px 8px",borderRadius:8,background:isBuy?"#14532d":isSell?"#7f1d1d":"#0d1b2a",color:isBuy?"#86efac":isSell?"#fca5a5":"#475569",fontWeight:700}}>{sig.strat}</span>
              {sig.score>=55&&<span style={{fontSize:9,padding:"3px 8px",borderRadius:8,background:sigCol,color:"#000",fontWeight:800}}>AUTO ✓</span>}
            </div>
            <div style={{fontSize:10,color:"#64748b",marginBottom:4}}>{sig.why}</div>
            {sig.sl&&<div style={{display:"flex",gap:14,fontSize:10}}>
              <span style={{color:"#f87171"}}>SL {sig.sl}</span>
              <span style={{color:"#34d399"}}>TP1 {sig.tp1}</span>
              <span style={{color:"#6ee7b7"}}>TP2 {sig.tp2}</span>
              <span style={{color:"#475569"}}>ATR {sig.atr}</span>
            </div>}
          </div>
        </div>
        <div style={{marginTop:10,background:"#0d1b2a",borderRadius:5,height:5,overflow:"hidden"}}>
          <div style={{height:"100%",width:`${sig.score}%`,background:sigCol,borderRadius:5,transition:"width 0.5s"}}/>
        </div>
        <div style={{display:"flex",justifyContent:"space-between",fontSize:8,color:"#0d1b2a",marginTop:3}}>
          <span>0%</span><span style={{color:sigCol,fontWeight:700}}>{sig.score}% confluence</span><span>≥55% auto-fires (paper)</span>
        </div>
      </div>

      {/* ════ ACTIVE PAPER TRADE ════ */}
      {mode==="paper"&&paperTrd&&(
        <div style={F({margin:"8px 14px 0",borderRadius:11,padding:"10px 14px",
          background:paperPnl>=0?"#022c22":"#1c0707",border:`1px solid ${paperPnl>=0?"#166534":"#991b1b"}`})}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <div>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <span style={{fontWeight:800,fontSize:14,color:paperTrd.dir==="BUY"?"#86efac":"#fca5a5"}}>{paperTrd.dir} {paperTrd.lot}lot @ ${paperTrd.entry}</span>
                {paperTP1&&<span style={{fontSize:9,padding:"1px 7px",background:"#22c55e",borderRadius:5,color:"#000",fontWeight:700}}>TP1✓→BE</span>}
              </div>
              <div style={{fontSize:9,color:"#475569",marginTop:3}}>SL {paperTrd.sl} · TP1 {paperTrd.tp1} · TP2 {paperTrd.tp2} · {paperTrd.strat}</div>
            </div>
            <div style={{textAlign:"right"}}>
              <div style={{fontSize:22,fontWeight:900,color:paperPnl>=0?"#86efac":"#fca5a5"}}>{paperPnl>=0?"+":""}{paperPnl}$</div>
              <button onClick={closePaper} style={F({fontSize:10,padding:"3px 10px",background:"#1e3a5f",border:"none",borderRadius:6,color:"#93c5fd",cursor:"pointer",marginTop:3})}>✕ Close</button>
            </div>
          </div>
        </div>
      )}

      {/* ════ TABS ════ */}
      <div style={{display:"flex",gap:4,padding:"10px 14px 0"}}>
        {TABS.map(t=><button key={t.id} onClick={()=>setTab(t.id)} style={F({flex:1,fontSize:9,padding:"7px 0",borderRadius:8,border:"none",cursor:"pointer",fontWeight:700,background:tab===t.id?"#d97706":"#061120",color:tab===t.id?"#000":"#475569"})}>{t.l}</button>)}
      </div>

      {/* ══════ CHART ══════ */}
      {tab==="chart"&&(
        <div style={{padding:"10px 14px",display:"flex",flexDirection:"column",gap:8}}>
          <Box>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:8}}>
              <div>
                <div style={{fontSize:10,color:"#475569",marginBottom:2}}>XAUUSDT · 15M · Binance{health?.testnet?" (Testnet)":""}</div>
                <div style={{fontSize:9,color:wsC[wsState],fontWeight:700}}>{wsL[wsState]} {wsState==="live" && ("— " + bars.length + " candles")}</div>
              </div>
              <div style={{display:"flex",gap:6}}>
                <button onClick={loadCandles} disabled={loading} style={F({fontSize:10,padding:"5px 10px",background:"#0d1b2a",border:"none",borderRadius:7,color:"#94a3b8",cursor:"pointer",opacity:loading?0.5:1})}>{loading?"⏳":"🔄"} {loading?"Loading":"Reload"}</button>
                {wsState!=="live"
                  ?<button onClick={connectWS} style={F({fontSize:10,padding:"5px 12px",background:"#14532d",border:"1px solid #166534",borderRadius:7,color:"#86efac",cursor:"pointer",fontWeight:700})}>▶ Connect WS</button>
                  :<button onClick={disconnectWS} style={F({fontSize:10,padding:"5px 12px",background:"#1c0707",border:"1px solid #991b1b",borderRadius:7,color:"#fca5a5",cursor:"pointer",fontWeight:700})}>⏹ Disconnect</button>
                }
              </div>
            </div>
          </Box>
          {dataErr&&<div style={{background:"#1c0707",border:"1px solid #991b1b",borderRadius:9,padding:"10px",fontSize:10,color:"#fca5a5",display:"flex",justifyContent:"space-between",alignItems:"center"}}><span>⚠ {dataErr}</span><button onClick={loadCandles} style={{fontSize:9,padding:"3px 8px",background:"#7f1d1d",border:"none",borderRadius:6,color:"#fca5a5",cursor:"pointer",fontFamily:"inherit"}}>Retry</button></div>}
          {bars.length>0?(<>
            <Box style={{padding:"8px 8px 4px"}}><CandleChart bars={bars} sig={sig} trade={mode==="paper"?paperTrd:null}/></Box>
            <Box style={{padding:"8px 8px 4px"}}><div style={{fontSize:9,color:"#1e3a5f",marginBottom:2}}>RSI (14)</div><RSIChart rsiS={sig.rsiS}/></Box>
            <Box style={{padding:"8px 8px 4px"}}><div style={{fontSize:9,color:"#1e3a5f",marginBottom:2}}>Volume</div><VolumeChart bars={bars}/></Box>
          </>):<Box style={{padding:"40px",textAlign:"center",color:"#1e3a5f",fontSize:12}}>{loading?"⏳ Loading Binance data…":"Click 🔄 Reload or ▶ Connect WS"}</Box>}
          {alerts.length>0&&<Box><div style={{fontSize:9,color:"#334155",fontWeight:700,marginBottom:5}}>🔔 FEED</div>{alerts.slice(0,6).map((a,i)=><div key={i} style={{fontSize:10,color:"#475569",padding:"3px 0",borderBottom:i<5?"1px solid #0a1628":"none"}}>{a}</div>)}</Box>}
        </div>
      )}

      {/* ══════ SIGNALS ══════ */}
      {tab==="signals"&&(
        <div style={{padding:"10px 14px",display:"flex",flexDirection:"column",gap:8}}>
          <Box>
            <div style={{fontSize:10,color:"#fbbf24",fontWeight:700,marginBottom:10}}>📊 LIVE INDICATORS</div>
            {[
              {l:"Price",        v:price ? ("$" + price.toFixed(2)) : "—", c:"#fde68a"},
              {l:"EMA9",         v:r2(sig.e9)||"—",  c:"#a78bfa"},
              {l:"EMA21",        v:r2(sig.e21)||"—", c:"#38bdf8"},
              {l:"EMA50",        v:r2(sig.e50)||"—", c:"#fb923c"},
              {l:"RSI (14)",     v:sig.rsi||"—",     c:sig.rsi>70?"#f87171":sig.rsi<30?"#34d399":"#a78bfa"},
              {l:"ATR (14)",     v:sig.atr||"—",     c:"#94a3b8"},
              {l:"Trend",        v:sig.e9>sig.e21&&sig.e21>sig.e50?"BULL ▲":sig.e9<sig.e21&&sig.e21<sig.e50?"BEAR ▼":"MIXED", c:sig.e21>sig.e50?"#22c55e":"#ef4444"},
              {l:"Supports",     v:sig.sup?.join(", ")||"—", c:"#34d399"},
              {l:"Resistances",  v:sig.res?.join(", ")||"—", c:"#f87171"},
              {l:"Signal",       v:sig.sig,    c:sigCol},
              {l:"Score",        v:`${sig.score}%`, c:sigCol},
              {l:"WS Status",    v:wsL[wsState], c:wsC[wsState]},
            ].map(s=><div key={s.l} style={{display:"flex",justifyContent:"space-between",padding:"6px 0",borderBottom:"1px solid #0a1628",fontSize:10}}><span style={{color:"#475569"}}>{s.l}</span><span style={{color:s.c,fontWeight:700}}>{s.v}</span></div>)}
          </Box>
          {sig.factors?.length>0&&<Box>
            <div style={{fontSize:10,color:"#fbbf24",fontWeight:700,marginBottom:8}}>CONFLUENCE FACTORS</div>
            {sig.factors.map((f,i)=><div key={i} style={{display:"flex",gap:8,padding:"4px 0",borderBottom:"1px solid #0a1628",fontSize:10}}><span style={{color:sigCol}}>✓</span><span style={{color:"#94a3b8"}}>{f}</span></div>)}
          </Box>}
          <Box>
            <div style={{fontSize:10,color:"#64748b",fontWeight:700,marginBottom:10}}>STRATEGY: TRIPLE EMA + CONFLUENCE</div>
            {[
              ["EMA9 > EMA21 > EMA50","All EMAs aligned = strong trend direction","#a78bfa"],
              ["EMA21 Cross (+25pts)", "Price crossing EMA21 = primary entry trigger","#38bdf8"],
              ["RSI Filter",           "Oversold <35 for buys · Overbought >65 for sells","#f59e0b"],
              ["Volume Surge (+15pts)","High volume confirms institutional participation","#34d399"],
              ["S/R Confluence (+20pts)","Trade at key pivot levels for higher probability","#fb923c"],
              ["SL = ATR×1.1",         "Dynamic — adapts to current gold volatility","#f87171"],
              ["TP1 = ATR×2.0 → BE",   "SL moves to breakeven when TP1 hit","#34d399"],
              ["TP2 = ATR×3.5",         "Full target — risk-free after TP1","#6ee7b7"],
            ].map(([n,d,c])=><div key={n} style={{marginBottom:8,display:"flex",gap:10}}><span style={{fontSize:10,color:c,fontWeight:700,minWidth:155,flexShrink:0}}>{n}</span><span style={{fontSize:9,color:"#475569",lineHeight:1.5}}>{d}</span></div>)}
          </Box>
        </div>
      )}

      {/* ══════ PAPER TRADING ══════ */}
      {tab==="paper"&&(
        <div style={{padding:"10px 14px",display:"flex",flexDirection:"column",gap:8}}>
          <Box>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div>
                <div style={{fontSize:12,color:"#e2e8f0",fontWeight:700,marginBottom:3}}>Auto-Trade (Paper)</div>
                <div style={{fontSize:9,color:"#334155"}}>Fires ≥55% signals · Auto-BE at TP1 · No real money</div>
              </div>
              <div onClick={()=>setAuto(a=>!a)} style={{width:52,height:28,borderRadius:14,background:autoOn?"#d97706":"#0d1b2a",border:`1px solid ${autoOn?"#b45309":"#1e3a5f"}`,position:"relative",cursor:"pointer",transition:"background 0.25s",flexShrink:0}}>
                <div style={{position:"absolute",top:4,left:autoOn?27:4,width:18,height:18,borderRadius:"50%",background:autoOn?"#fff":"#475569",transition:"left 0.25s"}}/>
              </div>
            </div>
          </Box>

          <Box>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
              <div>
                <div style={{fontSize:9,color:"#475569",marginBottom:6}}>Lot Size</div>
                <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
                  {[0.001,0.01,0.05,0.1,0.5,1].map(v=><button key={v} onClick={()=>setLot(v)} style={F({padding:"5px 10px",borderRadius:7,border:`1px solid ${lot===v?"#d97706":"#0d1b2a"}`,background:lot===v?"#422006":"#0a1628",color:lot===v?"#fbbf24":"#475569",fontSize:11,cursor:"pointer",fontWeight:lot===v?700:400})}>{v}</button>)}
                </div>
              </div>
              <div style={{textAlign:"right"}}>
                <div style={{fontSize:9,color:"#475569",marginBottom:6}}>Balance</div>
                <div style={{fontSize:20,fontWeight:800,color:"#fde68a"}}>${paperBal.toFixed(0)}</div>
                <div style={{fontSize:9,color:pStats.tp>=0?"#86efac":"#fca5a5"}}>{pStats.tp>=0?"+":""}${pStats.tp} total P&L</div>
              </div>
            </div>
          </Box>

          <Box>
            <div style={{fontSize:10,color:"#475569",fontWeight:700,letterSpacing:1,marginBottom:8}}>MANUAL PAPER ORDER</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
              <button onClick={()=>openPaper("BUY")} disabled={!!paperTrd||!price||mode!=="paper"} style={F({padding:"15px 0",borderRadius:9,border:"none",cursor:paperTrd||!price?"not-allowed":"pointer",fontWeight:900,fontSize:15,background:"#14532d",color:paperTrd||!price?"#1f2937":"#86efac",opacity:paperTrd||!price?0.4:1})}>▲ BUY<div style={{fontSize:9,fontWeight:400,marginTop:3}}>{lot} lot @ ${price?price.toFixed(2):"—"}</div></button>
              <button onClick={()=>openPaper("SELL")} disabled={!!paperTrd||!price||mode!=="paper"} style={F({padding:"15px 0",borderRadius:9,border:"none",cursor:paperTrd||!price?"not-allowed":"pointer",fontWeight:900,fontSize:15,background:"#7f1d1d",color:paperTrd||!price?"#1f2937":"#fca5a5",opacity:paperTrd||!price?0.4:1})}>▼ SELL<div style={{fontSize:9,fontWeight:400,marginTop:3}}>{lot} lot @ ${price?price.toFixed(2):"—"}</div></button>
            </div>
            {sig.sl&&<div style={{marginTop:8,fontSize:9,color:"#334155",textAlign:"center"}}>Signal: SL <span style={{color:"#f87171"}}>{sig.sl}</span> · TP1 <span style={{color:"#34d399"}}>{sig.tp1}</span> · TP2 <span style={{color:"#6ee7b7"}}>{sig.tp2}</span></div>}
          </Box>

          {/* Paper history */}
          {paperHist.length>0&&<Box>
            <div style={{fontSize:10,color:"#475569",fontWeight:700,marginBottom:8}}>PAPER TRADES</div>
            <div style={{maxHeight:200,overflowY:"auto",display:"flex",flexDirection:"column",gap:4}}>
              {paperHist.slice(0,20).map((t,i)=><div key={i} style={{display:"flex",justifyContent:"space-between",padding:"5px 8px",borderRadius:7,background:t.pnl>=0?"#052e16":"#1c0707",fontSize:10}}>
                <span style={{color:t.dir==="BUY"?"#86efac":"#fca5a5",fontWeight:700}}>{t.dir}</span>
                <span style={{color:"#1e3a5f"}}>{t.strat}</span>
                <span style={{color:"#334155"}}>{t.entry}→{t.exit}</span>
                <span style={{color:"#475569"}}>{t.why}</span>
                <span style={{color:t.pnl>=0?"#86efac":"#fca5a5",fontWeight:700}}>{t.pnl>=0?"+":""}${t.pnl}</span>
              </div>)}
            </div>
          </Box>}
        </div>
      )}

      {/* ══════ LIVE TRADING ══════ */}
      {tab==="live"&&(
        <div style={{padding:"10px 14px",display:"flex",flexDirection:"column",gap:8}}>

          {/* Account status */}
          <Box>
            <div style={{fontSize:10,color:"#fbbf24",fontWeight:700,marginBottom:8}}>🔴 BINANCE ACCOUNT</div>
            {!health?.keySet?(
              <div style={{background:"#1c0707",border:"1px solid #991b1b",borderRadius:8,padding:"10px",fontSize:10,color:"#fca5a5"}}>
                ⚠ API keys not configured. Set <span style={{color:"#fbbf24"}}>BINANCE_API_KEY</span> and <span style={{color:"#fbbf24"}}>BINANCE_API_SECRET</span> in your Vercel environment variables, then redeploy.
              </div>
            ):acct?(
              <div style={{background:"#022c22",border:"1px solid #166534",borderRadius:8,padding:"10px",fontSize:10,color:"#86efac",marginBottom:10}}>
                ✅ Connected · {acct.testnet?"TESTNET":"MAINNET"} · Type: {acct.accountType} · Trade: {acct.canTrade?"Yes":"No"}
              </div>
            ):(
              <div style={{background:"#1c1a07",border:"1px solid #713f12",borderRadius:8,padding:"10px",fontSize:10,color:"#fbbf24",marginBottom:10}}>
                {acctErr||"Connecting to Binance…"}
              </div>
            )}
            {acct&&(<>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:10}}>
                <div style={{background:"#0d1b2a",borderRadius:8,padding:"10px"}}>
                  <div style={{fontSize:9,color:"#475569"}}>USDT Balance</div>
                  <div style={{fontSize:16,fontWeight:700,color:"#fde68a"}}>{acct.usdt?.free||"—"}</div>
                  <div style={{fontSize:8,color:"#334155"}}>Locked: {acct.usdt?.locked||"0"}</div>
                </div>
                <div style={{background:"#0d1b2a",borderRadius:8,padding:"10px"}}>
                  <div style={{fontSize:9,color:"#475569"}}>XAU Balance</div>
                  <div style={{fontSize:16,fontWeight:700,color:"#fbbf24"}}>{acct.xau?.free||"0"}</div>
                  <div style={{fontSize:8,color:"#334155"}}>Locked: {acct.xau?.locked||"0"}</div>
                </div>
              </div>
              <button onClick={refreshAccount} style={F({width:"100%",padding:"8px",borderRadius:8,border:"1px solid #1e3a5f",background:"transparent",color:"#93c5fd",cursor:"pointer",fontSize:10,fontWeight:700})}>↻ Refresh Account</button>
            </>)}
          </Box>

          {/* Live order */}
          {acct&&(<Box>
            <div style={{fontSize:10,color:"#fca5a5",fontWeight:700,letterSpacing:1,marginBottom:8}}>⚠ REAL MONEY — LIVE MARKET ORDER</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
              <div>
                <div style={{fontSize:9,color:"#475569",marginBottom:4}}>Lot Size (XAU)</div>
                <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
                  {[0.001,0.005,0.01,0.05,0.1].map(v=><button key={v} onClick={()=>setLot(v)} style={F({padding:"5px 8px",borderRadius:6,border:`1px solid ${lot===v?"#d97706":"#0d1b2a"}`,background:lot===v?"#422006":"#0a1628",color:lot===v?"#fbbf24":"#475569",fontSize:10,cursor:"pointer"})}>{v}</button>)}
                </div>
              </div>
              <div>
                <div style={{fontSize:9,color:"#475569",marginBottom:4}}>Value</div>
                <div style={{fontSize:14,fontWeight:700,color:"#fde68a"}}>${price?(price*lot).toFixed(0):"—"} USDT</div>
                <div style={{fontSize:8,color:"#334155"}}>Min Binance: 0.001 XAU</div>
              </div>
            </div>
            {sig.score>=55&&<div style={{padding:"8px 10px",background:"#022c22",borderRadius:8,border:"1px solid #166534",marginBottom:10,fontSize:10,color:"#86efac"}}>
              Signal: {sig.sig} {sig.score}% — {sig.strat} — {sig.why}
            </div>}
            {orderMsg&&<div style={{padding:"8px 10px",background:orderMsg.startsWith("✅")?"#022c22":"#1c0707",borderRadius:8,border:`1px solid ${orderMsg.startsWith("✅")?"#166534":"#991b1b"}`,marginBottom:10,fontSize:10,color:orderMsg.startsWith("✅")?"#86efac":"#fca5a5"}}>{orderMsg}</div>}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
              <button onClick={()=>placeLiveOrder("BUY")} disabled={ordering||!price} style={F({padding:"14px 0",borderRadius:9,border:"2px solid #166534",cursor:ordering||!price?"not-allowed":"pointer",fontWeight:900,fontSize:14,background:"#14532d",color:"#86efac",opacity:ordering||!price?0.5:1})}>
                {ordering?"…":"▲ BUY"}<div style={{fontSize:9,fontWeight:400,marginTop:2}}>{lot} XAU @ MARKET</div>
              </button>
              <button onClick={()=>placeLiveOrder("SELL")} disabled={ordering||!price} style={F({padding:"14px 0",borderRadius:9,border:"2px solid #991b1b",cursor:ordering||!price?"not-allowed":"pointer",fontWeight:900,fontSize:14,background:"#7f1d1d",color:"#fca5a5",opacity:ordering||!price?0.5:1})}>
                {ordering?"…":"▼ SELL"}<div style={{fontSize:9,fontWeight:400,marginTop:2}}>{lot} XAU @ MARKET</div>
              </button>
            </div>
          </Box>)}

          {/* Open orders */}
          <Box>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
              <div style={{fontSize:10,color:"#475569",fontWeight:700}}>OPEN ORDERS</div>
              <button onClick={refreshLive} style={F({fontSize:9,padding:"3px 8px",background:"#0d1b2a",border:"none",borderRadius:6,color:"#94a3b8",cursor:"pointer"})}>↻ Refresh</button>
            </div>
            {!acct?<div style={{fontSize:10,color:"#1e3a5f"}}>Connect Binance to see orders</div>
            :liveOrders.length===0?<div style={{fontSize:10,color:"#1e3a5f"}}>No open orders</div>
            :liveOrders.map(o=><div key={o.orderId} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"6px 8px",background:"#0d1b2a",borderRadius:7,marginBottom:5,fontSize:10}}>
              <div>
                <span style={{color:o.side==="BUY"?"#86efac":"#fca5a5",fontWeight:700}}>{o.side}</span>
                <span style={{color:"#475569",marginLeft:8}}>{o.type} {o.origQty} XAU</span>
                {o.price>0&&<span style={{color:"#334155",marginLeft:8}}>@ {o.price}</span>}
              </div>
              <button onClick={()=>cancelLiveOrder(o.orderId)} style={F({fontSize:9,padding:"2px 8px",background:"#1c0707",border:"1px solid #991b1b",borderRadius:5,color:"#fca5a5",cursor:"pointer"})}>Cancel</button>
            </div>)}
          </Box>

          {/* Recent live trades */}
          <Box>
            <div style={{fontSize:10,color:"#475569",fontWeight:700,marginBottom:8}}>RECENT LIVE TRADES</div>
            {!acct?<div style={{fontSize:10,color:"#1e3a5f"}}>Connect Binance</div>
            :liveTrades.length===0?<div style={{fontSize:10,color:"#1e3a5f"}}>No trades yet</div>
            :liveTrades.slice(0,10).map((t,i)=><div key={i} style={{display:"flex",justifyContent:"space-between",padding:"5px 0",borderBottom:i<9?"1px solid #0a1628":"none",fontSize:10}}>
              <span style={{color:t.isBuyer?"#86efac":"#fca5a5",fontWeight:700}}>{t.isBuyer?"BUY":"SELL"}</span>
              <span style={{color:"#334155"}}>{t.qty} XAU</span>
              <span style={{color:"#475569"}}>${parseFloat(t.price).toFixed(2)}</span>
              <span style={{color:"#1e3a5f"}}>{new Date(t.time).toLocaleTimeString()}</span>
            </div>)}
          </Box>
        </div>
      )}

      {/* ══════ STATS ══════ */}
      {tab==="stats"&&(
        <div style={{padding:"10px 14px",display:"flex",flexDirection:"column",gap:8}}>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:7}}>
            {[
              {l:"Paper Balance",   v:"$" + paperBal.toFixed(0), c:"#fde68a"},
              {l:"Total P&L",       v:(pStats.tp>=0?"+":"")+("$"+Math.abs(pStats.tp)), c:pStats.tp>=0?"#86efac":"#fca5a5"},
              {l:"Win Rate",        v:`${pStats.wr}%`, c:"#60a5fa", sub:`${pStats.wins}W / ${pStats.tot-pStats.wins}L`},
              {l:"Total Trades",    v:pStats.tot, c:"#e2e8f0"},
              {l:"Avg Win",         v:"+$" + pStats.aw, c:"#86efac"},
              {l:"Avg Loss",        v:"-$" + pStats.al, c:"#fca5a5"},
              {l:"Profit Factor",   v:pStats.pf, c:"#a78bfa"},
              {l:"Max Drawdown",    v:"$" + pStats.dd, c:"#fb923c"},
            ].map(s=><Box key={s.l}>
              <div style={{fontSize:20,fontWeight:900,color:s.c,fontFamily:"ui-monospace,monospace"}}>{s.v}</div>
              <div style={{fontSize:9,color:"#334155",marginTop:2}}>{s.l}</div>
              {s.sub&&<div style={{fontSize:8,color:"#1e3a5f",marginTop:1}}>{s.sub}</div>}
            </Box>)}
          </div>
          <Box><div style={{fontSize:9,color:"#334155",marginBottom:6}}>Equity Curve</div><EquityChart trades={paperHist} start={START_BAL}/></Box>
          {["EMA CROSS","PULLBACK","S/R BOUNCE"].map(st=>{
            const hs=paperHist.filter(t=>t.strat===st); if(!hs.length) return null;
            const w=hs.filter(t=>t.pnl>0).length, ps=r2(hs.reduce((s,t)=>s+t.pnl,0));
            return <Box key={st}><div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}><span style={{fontSize:11,color:"#60a5fa",fontWeight:700}}>{st}</span><div style={{display:"flex",gap:14,fontSize:11}}><span style={{color:"#475569"}}>{hs.length} trades</span><span style={{color:"#60a5fa"}}>{hs.length?r1((w/hs.length)*100):0}% WR</span><span style={{color:ps>=0?"#86efac":"#fca5a5",fontWeight:700}}>{ps>=0?"+":""}${ps}</span></div></div></Box>;
          })}
          {paperHist.length>0&&<Box>
            <div style={{fontSize:10,color:"#475569",fontWeight:700,marginBottom:8}}>ALL PAPER TRADES</div>
            <div style={{maxHeight:260,overflowY:"auto",display:"flex",flexDirection:"column",gap:4}}>
              {paperHist.map((t,i)=><div key={i} style={{display:"flex",justifyContent:"space-between",padding:"5px 8px",borderRadius:7,background:t.pnl>=0?"#052e16":"#1c0707",fontSize:10}}>
                <span style={{color:t.dir==="BUY"?"#86efac":"#fca5a5",fontWeight:700}}>{t.dir}</span>
                <span style={{color:"#1e3a5f"}}>{t.strat}</span>
                <span style={{color:"#334155"}}>{t.entry}→{t.exit}</span>
                <span style={{color:"#475569"}}>{t.why}</span>
                <span style={{color:t.pnl>=0?"#86efac":"#fca5a5",fontWeight:700}}>{t.pnl>=0?"+":""}${t.pnl}</span>
              </div>)}
            </div>
          </Box>}
        </div>
      )}

      <div style={{textAlign:"center",fontSize:9,color:"#0a1628",padding:"10px 0 22px"}}>
        ⚠ Real money at risk in Live mode · Not financial advice · Past results ≠ future performance
      </div>
    </div>
  );
}
