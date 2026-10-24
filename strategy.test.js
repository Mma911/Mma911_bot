'use strict';
const assert=require('node:assert/strict');
const {Strategy,ema,rsi,macd,adx,atr}=require('../strategy');
function candles(values){return values.map((close,i)=>({epoch:i+1,open:close,high:close+0.2,low:close-0.2,close}));}
function bullish(){return candles([...Array(99).fill(100),101,101]);}
function bearish(){return candles([...Array(99).fill(100),99,99]);}

// XML uses the candle at offset 2, and indicators require all their warmup data.
{
  const s=new Strategy({useAdxFilter:false,closedCandleOnly:true});
  assert.equal(s.evaluate(candles(Array(20).fill(100))).reason,'warmup');
  assert.equal(s.evaluate(candles(Array(110).fill(100))).reason,'conditions');
}
// MACDA field 0 is histogram; field 1 is MACD line and field 2 is signal.
{
  const values=Array.from({length:140},(_,i)=>i<50?100:100+(i-50)*(i%2?0.8:-0.2));
  const m=macd(values);
  assert.equal(m.length,107); // 140 - (26 + 9 - 2)
  assert.notEqual(m.at(-1)[0],m.at(-1)[1]);
  assert.notEqual(m.at(-1)[1],m.at(-1)[2]);
  const s=new Strategy({useAdxFilter:false});
  const result=s.evaluate(candles(values));
  assert.equal(result.indicators.macdHistogram,m.at(-2)[0]); // offset 2
  assert.equal(result.indicators.macdLine,m.at(-2)[1]);
  assert.equal(result.indicators.macdSignal,m.at(-2)[2]);
}
// The two purchase branches are strict: CALL needs close > EMA; PUT needs close < EMA.
{
  const call=new Strategy({useAdxFilter:false,closedCandleOnly:true}).evaluate(bullish());
  assert.equal(call.direction,'CALL'); assert.equal(call.indicators.crossUp,true);
  const put=new Strategy({useAdxFilter:false,closedCandleOnly:true}).evaluate(bearish());
  assert.equal(put.direction,'PUT'); assert.equal(put.indicators.crossDown,true);
  const equal=new Strategy({useAdxFilter:false,emaPeriod:50}).evaluate(candles([...Array(99).fill(100),100,100]));
  assert.equal(equal.direction,null);
}
// Explicit XML ATR uses first TR = high-low and Wilder seed at period 14.
{
  const cs=candles(Array.from({length:30},(_,i)=>100+i*.1));
  const av=atr(cs,14), xv=adx(cs,14);
  assert.equal(av.slice(0,13).every(x=>x===null),true);
  assert.ok(Math.abs(av[13]-.4)<1e-12);
  assert.equal(xv.slice(0,26).every(x=>x===null),true);
  assert.ok(Math.abs(xv[26]-100)<1e-12);
}
// Session risk, snapshot aliases, and export/restore remain compatible with execution.js.
{
  const s=new Strategy({useAdxFilter:false,maxLoss:2,maxTrades:20,maxConsecutiveLosses:3,useMartingale:true,martingaleFactor:2,maxStake:4});
  assert.equal(s.canTrade(),true); s.setLastDirection('CALL'); s.settled(-1);
  assert.equal(s.snapshot().stake,2); assert.equal(s.snapshot().lossStreak,1);
  s.settled(-2); assert.equal(s.snapshot().stake,4); assert.equal(s.canTrade(),false);
  assert.equal(s.snapshot().durationUnit,'m');
  const before=s.exportState(), t=new Strategy({useAdxFilter:false}); t.restoreState(before);
  assert.deepEqual(t.exportState(),before); assert.equal(t.snapshot().lastDirection,'CALL');
}
// Indicator primitive warmups are deterministic and never silently fabricate values.
assert.equal(ema([1,2],3),null); assert.equal(rsi([1,2],3),null); assert.deepEqual(macd(Array(30).fill(1)),[]);
console.log('strategy tests: ok');

// Regression: the XML requires at least 100 analyzed (closed) candles.
assert.equal(new Strategy().evaluate(candles(Array(100).fill(1.08))).reason,'warmup');
const reference=require('./indicator-reference.json');
assert.equal(ema(reference.values,50,5).at(-1),reference.ema50);
assert.ok(Math.abs(rsi(reference.values,14).at(-1)-reference.rsi14)<1e-12);
assert.deepEqual(JSON.parse(JSON.stringify(macd(reference.values,12,26,9,5))),reference.macd);
assert.ok(reference.macd.some(row=>row[0]!==0),'forex precision must not erase every MACD signal');
assert.equal(rsi(Array(110).fill(1.08),14).at(-1),0,'DBot flat series RSI is zero');
