import test from 'node:test';
import assert from 'node:assert/strict';
import { initialRun, reduceRun, safeActivity, applyActivitySnapshot, activityDuration, formatDuration, activityPhase } from '../public/core.js';
const start={spanId:'s1',stage:'model',state:'started',startedAt:'2026-10-27T10:00:00Z',modelCallId:'m1',durationMs:null,durationSource:'runtime_monotonic'};
const event=(sequence,detail)=>({version:2,kind:'agent.progress',sessionId:'session',runId:'run',sequence,activityDetail:detail});
test('realtime spans update by identity; same tool name and parallel calls never collapse',()=>{
 let s=reduceRun(initialRun('session','run'),event(1,start));
 s=reduceRun(s,event(2,{...start,spanId:'tool1',stage:'tool',toolName:'read',toolCallId:'a'}));
 s=reduceRun(s,event(3,{...start,spanId:'tool2',stage:'tool',toolName:'read',toolCallId:'b'}));
 s=reduceRun(s,event(4,{...start,state:'completed',endedAt:'2026-10-27T10:00:09Z',durationMs:9390}));
 assert.equal(s.activitySpans.length,3);assert.equal(s.activitySpans.find(x=>x.spanId==='s1').durationMs,9390);
 assert.equal(s.activitySpans.filter(x=>x.state==='started').length,2);
});
test('snapshot at cursor hydrates then subsequent replay ends same span; old event cannot overwrite watermark',()=>{
 let s=applyActivitySnapshot(initialRun('session','run'),{runId:'run',lastSequence:5,spans:[{sequence:4,detail:start}],serverNow:'2026-10-27T10:00:00Z',captureStatus:'observed',totalElapsedMs:100});
 s.sequence=0;s=reduceRun(s,event(4,{...start,state:'failed'}));
 assert.equal(s.activitySpans[0].state,'started');
 s=reduceRun(s,event(6,{...start,state:'completed',durationMs:24}));assert.equal(s.activitySpans[0].durationMs,24);
 assert.equal(s.activitySpans.length,1);
});
test('metadata projection never persists tool payload, thinking, or private unknown fields',()=>{
 const x=safeActivity({...start,prompt:'SECRET',result:{text:'SECRET'},reasoning:'SECRET'},1);
 assert.ok(!JSON.stringify(x).includes('SECRET'));
 assert.equal(safeActivity({...start,state:'invented'}),null);
 assert.equal(safeActivity({...start,durationMs:-1}).durationMs,null);
});
test('live clocks are estimates; ended or disconnected runs never invent missing duration',()=>{
 const t=Date.parse(start.startedAt);
 assert.equal(activityDuration(start,t+2000),2000);
 assert.equal(activityDuration(start,t+2000,0,false),null);
 assert.equal(activityDuration({...start,state:'interrupted'},t+2000),null);
 assert.equal(activityDuration({...start,state:'completed',durationMs:24}),24);
 assert.equal(formatDuration(9390),'9.39 s');assert.equal(formatDuration(24),'24 ms');
 assert.equal(formatDuration(null),'Chưa có số đo');
});

test('terminal activity readback stops stale running status; running snapshot cannot reopen a terminal run',()=>{
 const state={...initialRun('session','run'),status:'Running'};
 const done=applyActivitySnapshot(state,{runId:'run',spans:[],runStatus:'Completed',totalElapsedMs:1234});
 assert.equal(done.status,'Completed');assert.equal(done.terminal,true);
 assert.equal(applyActivitySnapshot(done,{runId:'run',spans:[],runStatus:'Running'}).status,'Completed');
});
test('phase labels explain grounding continuations without asserting hidden model intent',()=>{
 const tool={stage:'tool',toolName:'mcp__grounding__submit_grounded_answer',state:'failed'}, model={stage:'model'};
 assert.match(activityPhase([tool,model],1),/có thể sửa/);
 assert.match(activityPhase([tool,model,tool,model],3),/chưa xác minh/);
 assert.match(activityPhase([{...tool,state:'completed'},model],1),/sau kiểm chứng/);
});

test('Agent duration stays separate from review wait and Accept duration',()=>{
 const s=applyActivitySnapshot(initialRun('s','r'),{runId:'r',spans:[],totalElapsedMs:103790,
  agentElapsedMs:28700,agentStopped:true,reviewWaitMs:13800,
  operations:[{operationId:'op',kind:'Accept',status:'Succeeded',elapsedMs:61300}]});
 assert.equal(s.activityAgentMs,28700);assert.equal(s.activityAgentStopped,true);
 assert.equal(s.activityReviewWaitMs,13800);assert.equal(s.activityOperations[0].elapsedMs,61300);
 assert.equal(s.activityTotalMs,103790);
});
