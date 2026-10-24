'use strict';

// Translation of SCDP_Deriv_Analysis_Settings_Demo.xml.  ATR stop/target are
// analytical values only: the XML never closes a Rise/Fall contract with them.
const DEFAULTS = Object.freeze({ symbol:'frxEURUSD', granularity:60, duration:1, duration_unit:'m', durationUnit:'m', currency:'USD', pipSize:5, emaPeriod:50, rsiPeriod:14, rsiLevel:50, crossWindow:1, useAdxFilter:true, adxMin:20, atrPeriod:14, atrStopMult:2, atrTargetMult:.5, expiryCandles:1, closedCandleOnly:true, soundAlert:true, noRepeatDirection:false, baseStake:1, useMartingale:false, martingaleFactor:2, maxStake:4, maxLoss:10, takeProfit:5, maxTrades:20, maxConsecutiveLosses:3 });
const num = x => Number(x), finite = Number.isFinite;
const rounded = (x, digits) => +x.toFixed(digits);
function validCandle(c) { return c && [c.open,c.high,c.low,c.close].every(x => finite(num(x))); }
function closes(cs) { return cs.map(c => num(c.close)); }
// Scalar DBot EMA: unrounded recursion; round only the returned scalar.
function ema(values, p, pipSize=5) {
  p=Math.floor(num(p)); if(!p || values.length<p)return null;
  let e=values.slice(0,p).reduce((a,b)=>a+b,0)/p;
  const out=Array(p-1).fill(null);out.push(rounded(e,pipSize));const k=2/(p+1);
  for(let i=p;i<values.length;i++){e=(values[i]-e)*k+e;out.push(rounded(e,pipSize));}return out;
}
// DBot EMA array rounds its seed only; recursive array values remain unrounded.
function emaArray(values,p,pipSize=20){
  if(values.length<p)return [];
  let e=rounded(values.slice(0,p).reduce((a,b)=>a+b,0)/p,pipSize),out=[e];
  for(let i=p;i<values.length;i++){
    e=(values[i]-e)*2/(p+1)+e;
    out.push(e);
  }return out;
}
function rsi(values,p) {
  p=Math.floor(num(p)); if (!p || values.length<=p) return null;
  let gain=0, loss=0;
  for(let i=1;i<=p;i++){const d=values[i]-values[i-1]; if(d>0)gain+=d; else loss-=d;}
  gain/=p; loss/=p;
  const calc=()=>gain===0?0:loss===0?100:100-100/(1+gain/loss), out=Array(p).fill(null); out.push(calc());
  for(let i=p+1;i<values.length;i++){const d=values[i]-values[i-1]; gain=(gain*(p-1)+Math.max(0,d))/p; loss=(loss*(p-1)+Math.max(0,-d))/p; out.push(calc());}
  return out;
}
function explicitRanges(cs) {
  const tr=[], plus=[], minus=[];
  for(let i=0;i<cs.length;i++) {
    const h=num(cs[i].high), l=num(cs[i].low);
    let range=h-l, pdm=0, mdm=0;
    if(i>0) {
      const gh=Math.abs(h-num(cs[i-1].close)), gl=Math.abs(l-num(cs[i-1].close));
      if(gh>range) range=gh; if(gl>range) range=gl;
      const up=h-num(cs[i-1].high), down=num(cs[i-1].low)-l;
      // XML uses strict comparisons: ties produce no directional movement.
      if(up>down && up>0) pdm=up; else if(down>up && down>0) mdm=down;
    }
    tr.push(range); plus.push(pdm); minus.push(mdm);
  }
  return {tr,plus,minus};
}
function smoothXml(values,p) {
  const out=Array(values.length).fill(null); if(values.length<p)return out;
  let x=0; for(let i=0;i<p;i++)x+=values[i]; x/=p; out[p-1]=x;
  for(let i=p;i<values.length;i++){x=(x*(p-1)+values[i])/p;out[i]=x;} return out;
}
function atr(cs,p) { const {tr}=explicitRanges(cs); return smoothXml(tr,Math.floor(num(p))); }
function adx(cs,p=14) {
  p=Math.floor(num(p)); const {tr,plus,minus}=explicitRanges(cs), at=smoothXml(tr,p), ap=smoothXml(plus,p), am=smoothXml(minus,p);
  const dx=Array(cs.length).fill(null), out=Array(cs.length).fill(null);
  for(let i=p-1;i<cs.length;i++) { const a=at[i], b=ap[i], c=am[i]; if(!finite(a)||a===0) dx[i]=0; else { const diP=100*b/a, diM=100*c/a; dx[i]=(diP+diM===0?0:100*Math.abs(diP-diM)/(diP+diM)); } }
  // XML accumulates DX through i=27 (1-based) and divides by 14, then Wilder-smooths.
  const first=2*p-2; if(first>=cs.length)return out; let x=0;
  for(let i=p-1;i<=first;i++)x+=dx[i]||0;
  x/=p; out[first]=x;
  for(let i=first+1;i<cs.length;i++){x=(x*(p-1)+(dx[i]||0))/p;out[i]=x;} return out;
}
// DBot MACDA returns [histogram, MACD line, signal] only from slow+signal-2 onward.
function macd(values, fast=12, slow=26, signal=9, pipSize=5) {
  if(values.length<slow)return null;
  const f=emaArray(values,fast,20),s=emaArray(values,slow,20);
  const pad=(arr)=>[...Array(values.length-arr.length).fill(0),...arr];
  const fp=pad(f),sp=pad(s),line=sp.map((x,i)=>rounded(fp[i]-x,pipSize));
  const sg=pad(emaArray(line.slice(slow-1),signal,20));
  return line.map((x,i)=>[rounded(x-sg[i],pipSize),x,rounded(sg[i],pipSize)]).slice(slow+signal-2);
}

class Strategy {
  constructor(config={}) { this.config={...DEFAULTS,...config}; if(this.config.durationUnit&&!config.duration_unit)this.config.duration_unit=this.config.durationUnit; if(!this.config.durationUnit)this.config.durationUnit=this.config.duration_unit; this.config.duration=this.config.expiryCandles;this.config.durationUnit='m';this.config.duration_unit='m'; this._state={stake:num(this.config.baseStake),sessionProfit:0,tradesCount:0,lossStreak:0,lastAnalyzedCandle:0,lastDirection:null,lastProfit:0}; }
  _risk(){const c=this.config,s=this._state; return c.takeProfit>0&&c.maxLoss>0&&c.maxTrades>0&&c.maxConsecutiveLosses>0&&s.sessionProfit<c.takeProfit&&s.sessionProfit-s.stake>=-c.maxLoss&&s.tradesCount<c.maxTrades&&s.lossStreak<c.maxConsecutiveLosses&&s.stake>0&&s.stake<=c.maxStake&&c.baseStake>0&&c.martingaleFactor>=1;}
  canTrade(){return this._risk();}
  evaluate(candles){
    const cs=Array.isArray(candles)?candles.filter(validCandle):[], c=this.config,s=this._state;
    const offset=c.closedCandleOnly?2:1, idx=cs.length-offset, result={direction:null,stake:s.stake,candle:null,indicators:null,reason:null,canTrade:this.canTrade()};
    if(idx<0||!this.canTrade()){result.reason=!this.canTrade()?'risk_limit':'warmup';return result;}
    const integers=[c.emaPeriod,c.rsiPeriod,c.atrPeriod,c.crossWindow,c.expiryCandles];
    if(!integers.every(Number.isInteger)||c.emaPeriod<2||c.rsiPeriod<2||c.atrPeriod<2||c.crossWindow<1||c.expiryCandles<1||!(c.rsiLevel>0&&c.rsiLevel<100)||c.adxMin<0||!(c.atrStopMult>0&&c.atrTargetMult>0)){result.reason='invalid_config';return result;}
    const length=idx+1;
    if(length<100||length<c.emaPeriod||length<=c.rsiPeriod||length<c.atrPeriod||length<=c.crossWindow+33){result.reason='warmup';return result;}
    const epoch=cs[idx].epoch??cs[idx].time??idx;
    if(c.closedCandleOnly&&s.lastAnalyzedCandle!==0&&epoch===s.lastAnalyzedCandle){result.reason='already_analyzed';return result;}
    s.lastAnalyzedCandle=epoch; result.candle=epoch;
    const vals=closes(cs), ep=ema(vals,c.emaPeriod,c.pipSize), rp=rsi(vals,c.rsiPeriod), ma=macd(vals,12,26,9,c.pipSize);
    const av=adx(cs,14), at=atr(cs,c.atrPeriod), adxValue=av&&av[idx], atrValue=at&&at[idx];
    if(!ep||!rp||!ma||idx>=ep.length||!finite(ep[idx])||!finite(rp[idx])||idx<33||!finite(adxValue)||!finite(atrValue)){result.reason='warmup';return result;}
    const macdFirst=33, mi=idx-macdFirst, window=Math.max(1,Math.floor(num(c.crossWindow))), cur=ma[mi]?.[0]; let crossUp=false,crossDown=false;
    for(let j=0;j<window;j++){const now=ma[mi-j]?.[0], prev=ma[mi-j-1]?.[0]; if(!finite(now)||!finite(prev))continue; if(now>0&&prev<=0)crossUp=true; if(now<0&&prev>=0)crossDown=true;}
    const above=vals[idx]>ep[idx], below=vals[idx]<ep[idx], rsiRise=rp[idx]>c.rsiLevel, rsiFall=rp[idx]<c.rsiLevel, adxOk=!c.useAdxFilter||adxValue>c.adxMin;
    let direction=null; if(crossUp&&above&&rsiRise&&adxOk)direction='CALL'; if(crossDown&&below&&rsiFall&&adxOk)direction='PUT'; if(direction&&c.noRepeatDirection&&direction===s.lastDirection)direction=null;
    if(direction) s.lastDirection=direction;
    result.direction=direction; result.reason=direction?'signal':'conditions'; result.indicators={ema:ep[idx],rsi:rp[idx],macdHistogram:cur,macdLine:ma[mi][1],macdSignal:ma[mi][2],crossUp,crossDown,adx:adxValue,atr:atrValue,analyticalStop:finite(atrValue)?(direction==='PUT'?vals[idx]+c.atrStopMult*atrValue:vals[idx]-c.atrStopMult*atrValue):null,analyticalTarget:finite(atrValue)?(direction==='PUT'?vals[idx]-c.atrTargetMult*atrValue:vals[idx]+c.atrTargetMult*atrValue):null}; return result;
  }
  settled(profit){const p=num(profit);if(!finite(p))throw new TypeError('profit must be finite');const s=this._state,c=this.config;s.lastProfit=p;s.sessionProfit+=p;s.tradesCount++;if(p<0){s.lossStreak++;if(c.useMartingale)s.stake*=c.martingaleFactor;else s.stake=c.baseStake;}else{s.lossStreak=0;s.stake=c.baseStake;}return this.snapshot();}
  snapshot(){return {symbol:this.config.symbol,granularity:this.config.granularity,duration:this.config.duration,duration_unit:this.config.duration_unit,durationUnit:this.config.durationUnit,currency:this.config.currency,stake:this._state.stake,sessionProfit:this._state.sessionProfit,tradesCount:this._state.tradesCount,lossStreak:this._state.lossStreak,lastAnalyzedCandle:this._state.lastAnalyzedCandle,lastDirection:this._state.lastDirection,lastProfit:this._state.lastProfit,canTrade:this.canTrade()};}
  exportState(){return {version:1,state:{...this._state}};}
  restoreState(obj){const x=obj&&obj.state?obj.state:obj;if(!x||typeof x!=='object')throw new TypeError('invalid strategy state');for(const k of Object.keys(this._state)){if(x[k]!==undefined){if(k==='lastDirection')this._state[k]=x[k]===null?null:String(x[k]);else {const v=num(x[k]);if(!finite(v))throw new TypeError(`invalid state ${k}`);this._state[k]=v;}}}return this.snapshot();}
  setPrecision(pipSize){if(!Number.isInteger(pipSize)||pipSize<0||pipSize>20)throw new Error('Invalid market pip_size');this.config.pipSize=pipSize;}
  setLastDirection(direction){if(direction!==null&&direction!=='CALL'&&direction!=='PUT')throw new TypeError('direction must be CALL, PUT, or null');this._state.lastDirection=direction;}
}
module.exports={Strategy,DEFAULTS,ema,rsi,adx,atr,macd};
