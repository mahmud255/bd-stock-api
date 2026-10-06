const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {decodePrices, number} = require('../dist/src/models/market');
const {StockDataService} = require('../dist/src/services/DsePriceService');
const {config} = require('../dist/src/env');
const {range} = require('../dist/src/utils/validation');
const {symbol} = require('../dist/src/utils/validation');
const prices = JSON.parse(readFileSync(__dirname + '/fixtures/prices.json','utf8'));

test('HTTP transport retries one transient failure with certificate verification intact', async t => {
  const http=require('node:http');
  const {createUpstreamClient}=require('../dist/src/utils/axiosConfig');
  let calls=0;
  const server=http.createServer((_req,res)=>{
    calls++;res.statusCode=calls===1?503:200;
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify(calls===1?{unavailable:true}:prices));
  }).listen(0,'127.0.0.1');
  await new Promise(resolve=>server.on('listening',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const client=createUpstreamClient({...config,dseBaseUrl:'http://127.0.0.1:'+server.address().port});
  assert.equal(client.defaults.httpsAgent,undefined);
  assert.equal((await client.get('/api/live/prices')).data.rows.length,4);
  assert.equal(calls,2);
});

test('DS30 membership rejects partial and duplicate constituent lists', async () => {
  for(const rows of [[{code:'GP'}],Array.from({length:30},()=>({code:'GP'}))]) {
    const service=new StockDataService(config,{get:async()=>({data:{rows}})});
    await assert.rejects(service.members('DS30'),e=>e.status===502);
  }
  const codes=Array.from({length:30},(_v,i)=>'STOCK'+i);
  const service=new StockDataService(config,{get:async()=>({data:{rows:codes.map(code=>({code}))}})});
  assert.deepEqual((await service.members('DS30')).data,codes);
});

test('numeric values handle all separators and preserve missing values', () => {
  assert.equal(number('1,234,567'),1234567);
  for(const value of ['', '-', 'NaN', '240.2abc', null, Infinity]) assert.equal(number(value),null);
});
test('actual DSE codes may contain parentheses and ampersands', () => {
  for(const code of ['AMCL(PRAN)','KAY&QUE']) {
    assert.equal(symbol(code.toLowerCase()),code);
    const wire={...prices,rows:[[code,...prices.rows[0].slice(1)]]};
    assert.equal(decodePrices(wire).rows[0].trading_code,code);
  }
  assert.throws(()=>symbol('../GP'),e=>e.status===400);
});
test('wire decoder follows named columns and calculates change against YCP', () => {
  const result = decodePrices(prices);
  assert.equal(result.rows[1].change_percent,10);
  assert.equal(result.rows[2].change_percent,-10);
  assert.equal(result.rows[3].ltp,null);
  assert.equal(result.rows[3].change_percent,null);
  assert.equal(result.rows[0].value_mn,10.53);
  const reordered = { ...prices, cols:[...prices.cols].reverse(), rows:prices.rows.map(r=>[...r].reverse()) };
  assert.deepEqual(decodePrices(reordered),result);
});
test('empty, duplicate, malformed or all-null feeds fail explicitly', () => {
  for(const data of [
    {...prices, rows:[]}, {...prices, rows:[prices.rows[0],prices.rows[0]]},
    {...prices, cols:['code']}, {...prices, rows:[[1]]},
    {...prices, rows:[prices.rows[3]]}
  ]) assert.throws(()=>decodePrices(data),e=>e.status===502);
});
test('calendar validation rejects impossible dates, reverse ranges and oversized ranges', () => {
  for(const [a,b] of [['2026-02-30','2026-03-01'],['2026-03-02','2026-03-01'],['2020-01-01','2026-01-01']]) {
    assert.throws(()=>range(a,b),e=>e.status===400);
  }
  assert.equal(range('2024-02-29','2024-03-01').from,'2024-02-29');
});

test('concurrent quote requests share one upstream call and cheap readiness never fetches', async () => {
  let calls=0;
  const service=new StockDataService(config,{get:async()=>{calls++; await new Promise(resolve=>setTimeout(resolve,15));return {data:prices};}});
  assert.equal(service.readiness().ready,false);
  assert.equal(calls,0);
  const [a,b]=await Promise.all([service.latest(),service.latest()]);
  assert.equal(calls,1);assert.deepEqual(a,b);
  assert.equal(service.readiness().ready,true);
  assert.equal(a.meta.quote_time,null);
});
test('stale fallback retains original fetch time and expires within the configured bound', async () => {
  let now=1700000000000,fail=false,calls=0;
  const service=new StockDataService({...config,cacheTtlMs:1000,staleTtlMs:3000},{get:async()=>{
    calls++;if(fail)throw new Error('private diagnostic');return {data:prices};
  }},()=>now);
  const first=await service.latest();fail=true;now+=1500;
  const stale=await service.latest();
  assert.equal(stale.meta.stale,true);assert.equal(stale.meta.fetched_at,first.meta.fetched_at);
  assert.equal(service.readiness().ready,false);
  await service.latest();assert.equal(calls,2);
  now+=6000;
  await assert.rejects(service.latest(),e=>e.status===502&&!e.message.includes('private'));
});

const bar=(date,extra={})=>({date,tradingCode:'GP',openp:10,high:12,low:9,closep:11,ltp:11,ycp:10,volume:100,value:0.001,trade:10,...extra});
test('archive pagination collects all pages and returns dates in ascending order', async () => {
  const pages=[];
  const service=new StockDataService(config,{get:async(_path,options)=>{
    pages.push(options.params.page);
    return {data:{rows:options.params.page===1?[bar('2026-10-06')]:[bar('2026-10-05')],total:2,pageSize:1,page:options.params.page}};
  }});
  const result=await service.history('gp','2026-10-01','2026-10-06');
  assert.deepEqual(pages,[1,2]);assert.deepEqual(result.data.map(r=>r.date),['2026-10-05','2026-10-06']);
  assert.equal(result.data[0].open,10);
});
test('empty archives remain empty and invalid OHLC/identifiers fail', async () => {
  for(const rows of [[bar('2026-10-06',{high:8})],[bar('2026-10-06',{tradingCode:'OTHER'})]]) {
    const service=new StockDataService(config,{get:async()=>({data:{rows,total:1,pageSize:500}})});
    await assert.rejects(service.history('GP','2026-10-01','2026-10-06'),e=>e.status===502);
  }
  const service=new StockDataService(config,{get:async()=>({data:{rows:[],total:0,pageSize:500}})});
  assert.deepEqual((await service.history('GP','2026-10-01','2026-10-06')).data,[]);
});
test('upstream timeout is sanitized and remains distinguishable', async () => {
  const service=new StockDataService(config,{get:async()=>{throw Object.assign(new Error('private host/token'),{code:'ECONNABORTED'});}});
  await assert.rejects(service.latest(),e=>e.status===504&&!e.message.includes('private'));
});
