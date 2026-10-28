import test from 'node:test';
import assert from 'node:assert/strict';
import { traceStep, mergeTracePage, displayTrace, TRACE_ITEM_LIMIT } from '../public/trace-view.js';
const event=(sequence,kind,data,extra={})=>({sequence,kind,data,runtimeRequestId:'r',runtimeSessionId:'s',...extra});
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
