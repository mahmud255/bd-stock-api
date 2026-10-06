const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {createApp} = require('../dist/src/app');
const {StockDataService} = require('../dist/src/services/DsePriceService');
const {config} = require('../dist/src/env');
const prices=JSON.parse(readFileSync(__dirname+'/fixtures/prices.json','utf8'));
async function start(t,overrides={}) {
  let calls=0;
  const settings={...config,apiKey:'',corsOrigins:['https://example.test'],rateLimit:120,...overrides};
  const service=new StockDataService(settings,{get:async path=>{
    calls++;
    if(path==='/api/live/prices')return {data:prices};
    if(path==='/api/live/market')return {data:{
      indices:[{key:'DSEX',value:5000,change:-10,percent:-0.2,prev:5010}],
      totals:{trades:100,volume:1000,turnover:20,marketCap:1000000,tradeTime:'Source local time'},
      breadth:{advanced:1,declined:1,unchanged:1,traded:3},session:prices.session
    }};
    if(path==='/api/live/data-archive/day-end')return {data:{rows:[],total:0,pageSize:500,page:1}};
    if(path==='/api/live/data-archive/instruments')return {data:{instruments:['GP']}};
    throw new Error('secret detail');
  }});
  const server=createApp(service,settings).listen(0,'127.0.0.1');
  await new Promise(resolve=>server.on('listening',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  return {base:'http://127.0.0.1:'+server.address().port,service,calls:()=>calls};
}
test('health/docs/spec/readiness work without scraping',async t=>{
  const a=await start(t);
  assert.equal((await fetch(a.base+'/health')).status,200);
  assert.equal((await fetch(a.base+'/docs')).status,200);
  const spec=await (await fetch(a.base+'/openapi.json')).json();
  assert.equal(spec.openapi,'3.0.3');assert.ok(spec.paths['/v1/dse/stocks/{symbol}']);
  assert.equal((await fetch(a.base+'/ready')).status,503);assert.equal(a.calls(),0);
});
test('quotes support filtering and single-symbol lookup with consistent metadata',async t=>{
  const a=await start(t);
  const list=await (await fetch(a.base+'/v1/dse/stocks?search=gp')).json();
  assert.equal(list.data.length,1);assert.equal(list.data[0].trading_code,'GP');
  assert.equal(list.meta.quote_time,null);assert.equal(list.meta.session.phase,'closed');
  const stock=await (await fetch(a.base+'/v1/dse/stocks/gp')).json();
  assert.equal(stock.data.ltp,240.2);
  assert.equal((await fetch(a.base+'/v1/dse/stocks/UNKNOWN')).status,404);
  assert.equal((await fetch(a.base+'/ready')).status,200);
});
test('movers use YCP and only traded instruments',async t=>{
  const a=await start(t);
  const gain=await (await fetch(a.base+'/v1/dse/market/movers?type=gainers')).json();
  const loss=await (await fetch(a.base+'/v1/dse/market/movers?type=losers')).json();
  assert.deepEqual(gain.data.map(r=>r.trading_code),['GAIN']);
  assert.deepEqual(loss.data.map(r=>r.trading_code),['LOSS']);
  assert.equal(gain.meta.change_basis,'ltp_vs_ycp');
});
test('indices and official totals preserve units and source market time',async t=>{
  const a=await start(t);
  const indices=await (await fetch(a.base+'/v1/dse/indices')).json();
  assert.equal(indices.data[0].symbol,'DSEX');
  const summary=await (await fetch(a.base+'/v1/dse/market/summary')).json();
  assert.equal(summary.data.value_mn,20);assert.equal(summary.data.value_crore,2);
  assert.equal(summary.data.market_cap_mn,1);
});
test('invalid query inputs are rejected before touching the source',async t=>{
  const a=await start(t);
  for(const route of [
    '/v1/dse/stocks?limit=0','/v1/dse/stocks?search[]=GP',
    '/v1/dse/market/movers?type=invalid','/v1/dse/history/GP?start=2026-02-30&end=2026-03-01',
    '/v1/dse/history/GP?start=2020-01-01&end=2026-10-06','/v1/dse/historical?start=2026-10-01&end=2026-10-06',
  ]) assert.equal((await fetch(a.base+route)).status,400,route);
  assert.equal(a.calls(),0);
});
test('optional API key protects data routes while health stays available',async t=>{
  const a=await start(t,{apiKey:'test-only-key'});
  assert.equal((await fetch(a.base+'/health')).status,200);
  assert.equal((await fetch(a.base+'/v1/dse/stocks')).status,401);
  assert.equal((await fetch(a.base+'/v1/dse/stocks',{headers:{'X-API-Key':'wrong'}})).status,401);
  assert.equal((await fetch(a.base+'/v1/dse/stocks',{headers:{'X-API-Key':'test-only-key'}})).status,200);
});
test('CORS allows configured origins without credentialed wildcard access',async t=>{
  const a=await start(t);
  const allowed=await fetch(a.base+'/v1/dse/stocks',{headers:{Origin:'https://example.test'}});
  assert.equal(allowed.headers.get('access-control-allow-origin'),'https://example.test');
  assert.equal(allowed.headers.get('access-control-allow-credentials'),null);
  const denied=await fetch(a.base+'/v1/dse/stocks',{headers:{Origin:'https://other.test'}});
  assert.equal(denied.headers.get('access-control-allow-origin'),null);
});
test('rate limits return 429 and Retry-After without affecting liveness',async t=>{
  const a=await start(t,{rateLimit:1});
  assert.equal((await fetch(a.base+'/v1/dse/stocks')).status,200);
  const r=await fetch(a.base+'/v1/dse/stocks');assert.equal(r.status,429);assert.ok(r.headers.get('retry-after'));
  assert.equal((await fetch(a.base+'/health')).status,200);
});
test('legacy latest retains header keys and errors remain JSON without diagnostics',async t=>{
  const a=await start(t);
  const legacy=await (await fetch(a.base+'/v1/dse/latest')).json();
  assert.equal(legacy.data[0]['TRADING CODE'],'GP');
  assert.equal(legacy.data[0]['LTP*'],'240.2');
  assert.equal((await fetch(a.base+'/v1/dse/not-a-route')).status,404);
  const bad=await fetch(a.base+'/v1/dse/top30');
  assert.equal(bad.status,502);
  const text=await bad.text();assert.ok(!text.includes('secret'));assert.ok(!text.includes('stack'));
});
