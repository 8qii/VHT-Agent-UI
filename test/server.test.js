import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer, targets } from '../server.js';

test('grouped services route to distinct upstreams with streaming and no arbitrary URL proxy',async()=>{
 const seen=[], upstreams=[];
 for(const arm of ['native-grouped','mcp-grouped','native-real','mcp-real','native-full-real']){
  const server=http.createServer((req,res)=>{seen.push([arm,req.headers['x-demo-user']]);res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: '+arm+'\n\n');setTimeout(()=>res.end('data: done\n\n'),50);});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));upstreams.push(server);
 }
 const before={...targets};targets['native-grouped']=`http://127.0.0.1:${upstreams[0].address().port}`;targets['mcp-grouped']=`http://127.0.0.1:${upstreams[1].address().port}`;targets['native-real']=`http://127.0.0.1:${upstreams[2].address().port}`;targets['mcp-real']=`http://127.0.0.1:${upstreams[3].address().port}`;
 targets['native-full-real']=`http://127.0.0.1:${upstreams[4].address().port}`;
 const ui=createServer();await new Promise(r=>ui.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${ui.address().port}`;
 try{
  const config=await(await fetch(base+'/ui-config')).json();assert.notEqual(config.targets['native-grouped'],config.targets['mcp-grouped']);assert.equal(config.services['native-grouped'].sandbox,true);assert.equal(config.services['native-real'].sandbox,undefined);assert.match(config.services['native-real'].sourceNote,/khách hàng thật/);
  for(const arm of ['native-grouped','mcp-grouped','native-real','mcp-real','native-full-real']){
   const r=await fetch(base+'/backend/'+arm+'/api/chat/runs/r/events',{headers:{'X-Demo-User':arm}});const reader=r.body.getReader();
   assert.equal(new TextDecoder().decode((await reader.read()).value),'data: '+arm+'\n\n');await reader.cancel();
  }
  assert.deepEqual(seen,[['native-grouped','native-grouped'],['mcp-grouped','mcp-grouped'],['native-real','native-real'],['mcp-real','mcp-real'],['native-full-real','native-full-real']]);
  assert.equal((await fetch(base+'/backend/arbitrary/api/chat/sessions')).status,404);
  assert.equal((await fetch(base+'/backend/native-grouped/internal/evidence')).status,404);
 }finally{Object.assign(targets,before);for(const s of [ui,...upstreams]){s.closeAllConnections();await new Promise(r=>s.close(r));}}
});

test('local proxy forwards auth, streams incrementally and rejects cross-origin writes', async () => {
  const calls = [];
  const backend = http.createServer((req, res) => {
    calls.push({ path: req.url, user: req.headers['x-demo-user'], auth: req.headers.authorization });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.flushHeaders();
    res.write(': heartbeat\n\n'); setTimeout(() => res.end('event: snapshot\ndata: {}\n\n'), 100);
  });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  const before = targets.goose; targets.goose = `http://127.0.0.1:${backend.address().port}`;
  const ui = createServer(); await new Promise(resolve => ui.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${ui.address().port}`;
  try {
    const response = await fetch(base + '/backend/goose/api/chat/runs/r/events', { headers: { 'X-Demo-User': 'fixture-owner', Authorization: 'Bearer fixture-token' } });
    const reader = response.body.getReader(); const first = await reader.read();
    assert.equal(new TextDecoder().decode(first.value), ': heartbeat\n\n');
    assert.equal(calls[0].user, 'fixture-owner'); assert.equal(calls[0].auth, 'Bearer fixture-token'); assert.equal(calls[0].path, '/api/chat/runs/r/events'); await reader.cancel();
    const denied = await fetch(base + '/backend/goose/api/chat/sessions', { method: 'POST', headers: { Origin: 'https://other.test' }, body: '{}' });
    assert.equal(denied.status, 403); assert.equal(calls.length, 1);
    assert.equal((await fetch(base + '/backend/goose/internal/config')).status, 404);
    const html = await fetch(base); assert.equal(html.status, 200); assert(html.headers.get('content-security-policy').includes("object-src 'none'"));
  } finally { targets.goose = before; ui.closeAllConnections(); backend.closeAllConnections(); await Promise.all([new Promise(resolve => ui.close(resolve)), new Promise(resolve => backend.close(resolve))]); }
});

test('Library proxy forwards upload idempotency and conditional headers without exposing internal routes',async()=>{
 let seen;
 const backend=http.createServer((req,res)=>{let body='';req.on('data',b=>body+=b);req.on('end',()=>{seen={path:req.url,key:req.headers['idempotency-key'],match:req.headers['if-match'],user:req.headers['x-demo-user'],body};res.writeHead(201,{'Content-Type':'application/json'});res.end('{"file":{"id":"fixture"}}');});});
 await new Promise(r=>backend.listen(0,'127.0.0.1',r));const old=targets['native-real'];targets['native-real']=`http://127.0.0.1:${backend.address().port}`;
 const ui=createServer();await new Promise(r=>ui.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${ui.address().port}`;
 try{
  const r=await fetch(base+'/backend/native-real/api/library/uploads',{method:'POST',headers:{'X-Demo-User':'owner','Idempotency-Key':'one-upload','If-Match':'"v1"','Content-Type':'multipart/form-data; boundary=f'},body:'fixture-body'});
  assert.equal(r.status,201);assert.deepEqual(seen,{path:'/api/library/uploads',key:'one-upload',match:'"v1"',user:'owner',body:'fixture-body'});
  assert.equal((await fetch(base+'/backend/native-real/internal/documents')).status,404);
 }finally{targets['native-real']=old;for(const s of[ui,backend]){s.closeAllConnections();await new Promise(r=>s.close(r));}}
});
