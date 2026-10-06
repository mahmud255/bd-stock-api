// Live check is explicit and separate from offline CI tests.
const assert = require('node:assert/strict');
const {createApp} = require('../dist/src/app');
(async()=>{
  const server=createApp().listen(0,'127.0.0.1');
  await new Promise(resolve=>server.on('listening',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  const headers=process.env.API_KEY?{'X-API-Key':process.env.API_KEY}:{};
  try {
    for(const route of ['/health','/openapi.json','/v1/dse/stocks','/v1/dse/stocks/GP','/v1/dse/indices',
      '/v1/dse/market/summary','/v1/dse/market/movers?type=gainers','/v1/dse/symbols',
      '/v1/dse/history/GP?start=2026-09-01&end=2026-10-06','/v1/dse/top30','/v1/dse/dsexdata']) {
      const response=await fetch(base+route,{headers,signal:AbortSignal.timeout(45000)});
      const body=await response.json();
      assert.equal(response.status,200,route+' '+JSON.stringify(body.error||{}));
      console.log(route+' -> 200'+(Array.isArray(body.data)?' ('+body.data.length+' records)':''));
    }
  } catch(error) { console.error(error.message);process.exitCode=1; }
  finally { server.close(); }
})();
