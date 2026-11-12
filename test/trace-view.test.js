import test from 'node:test';
import assert from 'node:assert/strict';
import { traceStep, traceTotals, traceNeedsFinalRead, mergeTracePage, displayTrace, TRACE_ITEM_LIMIT } from '../public/trace-view.js';
const event=(sequence,kind,data,extra={})=>({sequence,kind,data,runtimeRequestId:'r',runtimeSessionId:'s',...extra});
test('token summary separates cumulative input from peak request and reports missing usage',()=>{
 const t=traceTotals([event(1,'model.request',{}),event(2,'assistant/message',{usage:{inputTokens:100,outputTokens:5}}),
 event(3,'model.request',{}),event(4,'assistant/message',{usage:{inputTokens:150,outputTokens:10}}),
 event(5,'model.request',{}),event(6,'tool/call',{}),event(7,'tool/result',{message:{isError:true}})]);
 assert.deepEqual(t,{modelCalls:3,knownUsageCalls:2,inputTokens:250,outputTokens:15,peakInputTokens:150,toolCalls:1,toolErrors:1});
 assert.equal(traceTotals([event(1,'model.request',{})]).inputTokens,null);
});
test('token summary does not borrow usage from another binding or ambiguous outputs',()=>{
 const t=traceTotals([event(1,'model.request',{}),event(2,'assistant/message',{usage:{inputTokens:999,outputTokens:9}},{runtimeRequestId:'foreign'})]);
 assert.equal(t.knownUsageCalls,0);assert.equal(t.inputTokens,null);
 assert.equal(traceTotals([event(1,'model.request',{}),event(2,'assistant/message',{usage:{inputTokens:10,outputTokens:2}}),event(3,'assistant/message',{usage:{inputTokens:20,outputTokens:3}})]).knownUsageCalls,0);
});
test('create_mcp and skill show exact domain/skill and match results by binding+callId',()=>{
 const items=[event(1,'tool/call',{callId:'a',name:'create_mcp',arguments:'{"kind":"inventory"}'}),
 event(2,'tool/result',{message:{toolCallId:'a',content:[{type:'text',text:'wrong binding'}]}},{runtimeRequestId:'other'}),
 event(3,'tool/result',{message:{toolCallId:'a',content:[{type:'text',text:'{"devices":3}'}]}})];
 const detail=traceStep(items,{stage:'tool',toolCallId:'a'});
 assert.equal(detail.title,'create_mcp · inventory');assert.match(detail.sections[1][1],/"devices": 3/);
 assert(!JSON.stringify(detail).includes('wrong binding'));
 assert.equal(traceStep([event(1,'tool/call',{callId:'b',name:'skill',arguments:{name:'device-config'}})],{stage:'tool',toolCallId:'b'}).title,'skill · device-config');
});
test('model activity IDs join exact request; each prompt and output stays within its request step',()=>{
 const items=[event(1,'model.request',{model:'Gemma',messages:[{role:'user',content:'first prompt'}]},{modelCallId:'model-91'}),
 event(2,'assistant/message',{message:{content:[{type:'text',text:'first output'}]},usage:{outputTokens:5}}),
 event(3,'model.request',{messages:['second']},{modelCallId:'model-92'}),event(4,'assistant/message',{message:{content:['second output']}})];
 const detail=traceStep(items,{stage:'model',modelCallId:'activity-model-91'});
 assert.equal(detail.title,'Model · Gemma');assert.match(detail.sections[0][1],/first prompt/);
 assert.match(detail.sections[2][1],/first output/);assert(!detail.sections[2][1].includes('second output'));
});
test('ambiguous IDs never attach another tool/model payload; missing and failed results are explicit',()=>{
 const c=event(1,'tool/call',{callId:'a',name:'read'});
 assert.match(traceStep([c,{...c,sequence:2,runtimeRequestId:'other'}],{stage:'tool',toolCallId:'a'}).missing,/Trùng/);
 assert.match(traceStep([],{stage:'model',modelCallId:'model-1'}).missing,/Chưa có/);
 const failure=traceStep([c,event(2,'tool/result',{message:{toolCallId:'a',isError:true,content:[{type:'text',text:'NOT_FOUND'}]}})],{stage:'tool',toolCallId:'a'});
 assert.equal(failure.failed,true);assert.equal(failure.sections[1][1],'NOT_FOUND');
});
test('trace pages deduplicate, advance only stored cursor, report source/size limits and preserve truncation',()=>{
 const first=mergeTracePage(null,{items:[event(1,'tool/call',{})],nextAfterSequence:1,captureStatus:'recorded'});
 const next=mergeTracePage(first,{items:[first.items[0],event(2,'tool/result',{})],nextAfterSequence:null,truncated:true});
 assert.equal(next.items.length,2);assert.equal(next.cursor,2);assert.equal(next.hasMore,false);assert(next.truncated);
 const capped=mergeTracePage({items:Array.from({length:TRACE_ITEM_LIMIT},(_,i)=>event(i+1,'x',{})),cursor:TRACE_ITEM_LIMIT,bytes:0},{items:[event(1001,'x',{})]});
 assert(capped.limited);assert.equal(capped.cursor,TRACE_ITEM_LIMIT);
 assert.match(displayTrace('abcdefgh',3),/abc\n…/);
});
test('provider message content accepts both strings and typed blocks as readable role sections',()=>{
 const detail=traceStep([event(1,'model.request',{messages:[{role:'system',content:'Policy\nline2'},{role:'user',content:[{type:'text',text:'Question'}]}]},{modelCallId:'model-1'})],{stage:'model',modelCallId:'activity-model-1'});
 assert.match(detail.sections[0][1],/\[1\] SYSTEM\nPolicy\nline2/);
 assert.match(detail.sections[0][1],/\[2\] USER\nQuestion/);
});

test('trace titles preserve actual identifiers regardless of transport metadata',()=>{
 const call=event(1,'tool/call',{callId:'x',name:'create_mcp',arguments:{kind:'inventory'}});
 const span={stage:'tool',toolCallId:'x'};
 assert.equal(traceStep([call],span,'native').title,'create_mcp · inventory');
 assert.equal(traceStep([call],span).title,'create_mcp · inventory');
 assert.deepEqual(traceStep([call],span,'native'),traceStep([call],span));
 const tool=event(1,'tool/call',{callId:'x',name:'mcp__inventory__inventory_list_devices',arguments:{}});
 assert.equal(traceStep([tool],span,'native').title,'mcp__inventory__inventory_list_devices');
 assert.equal(traceStep([], {stage:'tool',toolName:'mcp__inventory__inventory_list_devices'},'native').title,'mcp__inventory__inventory_list_devices');
});
test('a trace fetched before terminal is refreshed for late model requests and usage',()=>{
 let cache=mergeTracePage(null,{items:[event(1,'model.request',{}),event(2,'assistant/message',{usage:{inputTokens:100,outputTokens:5}}),event(3,'model.request',{})]});
 assert.equal(traceTotals(cache.items).knownUsageCalls,1);
 assert(traceNeedsFinalRead(cache,true));assert(!traceNeedsFinalRead({...cache,loading:true},true));
 cache=mergeTracePage(cache,{items:[event(4,'assistant/message',{usage:{inputTokens:200,outputTokens:6}}),event(5,'model.request',{}),event(6,'assistant/message',{usage:{inputTokens:300,outputTokens:7}})]});
 cache.finalized=true;
 assert.deepEqual([traceTotals(cache.items).modelCalls,traceTotals(cache.items).knownUsageCalls,traceTotals(cache.items).inputTokens],[3,3,600]);
 assert(!traceNeedsFinalRead(cache,true));assert(!traceNeedsFinalRead({...cache,finalized:false},false));
});

test('new group names render without a transport hint and keep original tool IDs',()=>{
 const detail=traceStep([event(1,'tool/call',{callId:'new',name:'load_tool_group',arguments:{kind:'inventory'}})],{stage:'tool',toolCallId:'new'});
 assert.equal(detail.title,'load_tool_group · inventory');
 assert.match(detail.description,/inventory/);
 const business=traceStep([event(1,'tool/call',{callId:'read',name:'inventory__search_devices',arguments:{query:'sw139'}})],{stage:'tool',toolCallId:'read'});
 assert.equal(business.title,'inventory__search_devices');
});
