// Deterministic presentation/queue comparison only; no real provider, Zed, or model claims.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createBoundedDelivery } from '../src/application/delivery.js';
import * as current from '../src/hosts/presentation.js';

const baseline=process.argv.includes('--r2')?'6617c0b924a7a4dc1b248772aedaef0e0b3dea37':
  '420358abeea67a4cf40cfb7ae4fa433cd34914e9';
const baselineSource=execFileSync('git',['show',baseline+':src/hosts/presentation.js'],{encoding:'utf8'});
// Import the exact historical presentation projection against unchanged core modules.
const historical=baselineSource
  .replace("from '../core/operation.js'","from '"+new URL('../src/core/operation.js',import.meta.url).href+"'")
  .replace("from '../core/finding.js'","from '"+new URL('../src/core/finding.js',import.meta.url).href+"'");
const old=await import('data:text/javascript;base64,'+Buffer.from(historical).toString('base64'));
const now=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const changedCore=execFileSync('git',['diff','--name-only',baseline,now,'--',
  'src/application/delivery.js'],{encoding:'utf8'}).trim();
assert.equal(changedCore,'','Bounded queue implementation changed: projection comparison is no longer like-for-like');

const scenarios=[
  {name:'direct',workers:0,stream:9,large:false},
  {name:'parallel',workers:2,stream:30,large:false},
  {name:'intense',workers:3,stream:200,large:true},
];
const modes=['compact','debug'],displays=['inline','notices'],clients=['fast','slow','broken','disconnect'];
const median=xs=>{const s=[...xs].sort((a,b)=>a-b);return s[Math.floor(s.length/2)];};
const round=x=>typeof x==='number'?Math.round(x*100)/100:x;
const nativeKinds=['agent_thought_chunk','tool_call','tool_call_update','plan'];
const code=String.fromCharCode(96);

async function sample(view,scenario,mode,display,clientKind){
  const started=performance.now();
  const counts={attempted:0,attemptedNative:0,attemptedOwn:0,delivered:0,deliveredNative:0,
    deliveredOwn:0,attemptedBytes:0,deliveredBytes:0,
    droppedByQueue:0,gapsDelivered:0,notificationFailures:0};
  let firstMs=null,firstNativeMs=null,disconnected=false,transport;
  const delivered=[];
  transport=createBoundedDelivery(async entry=>{
    if(disconnected)return;
    if(clientKind==='slow')await delay(2);
    if(clientKind==='broken'&&counts.delivered>=8){counts.notificationFailures++;throw Error('synthetic-notification-failure');}
    const update=entry.update;
    counts.delivered++;
    counts.deliveredBytes+=Buffer.byteLength(JSON.stringify(update));
    if(nativeKinds.includes(update.sessionUpdate)){counts.deliveredNative++;firstNativeMs??=performance.now()-started;}
    else counts.deliveredOwn++;
    if(update._meta?.roleOrchestratorSource?.source==='delivery')counts.gapsDelivered++;
    firstMs??=performance.now()-started;
    delivered.push(update.sessionUpdate);
    if(clientKind==='disconnect'&&counts.delivered>=7){disconnected=true;transport.close();}
  },(prior,_dropped)=>{
    counts.droppedByQueue++;
    return {count:(prior?.count??0)+1,
      update:view.acpProgressGap('op',(prior?.count??0)+1,'overflow',display,true)};
  });
  const push=update=>{
    if(!update)return;
    counts.attempted++;
    counts.attemptedBytes+=Buffer.byteLength(JSON.stringify(update));
    if(nativeKinds.includes(update.sessionUpdate))counts.attemptedNative++;
    else counts.attemptedOwn++;
    transport.enqueue({update},Buffer.byteLength(JSON.stringify({sessionId:'fixture',update}))+128);
  };
  const progress=(event,finding,fact)=>{
    for(const update of display==='inline'?view.acpExecutionInline(event,finding,mode,fact):
      view.acpExecutionNotices(event,finding,mode,fact))push(update);
  };
  push(view.acpAccepted('op','request',false,display,false,mode));
  let seq=0;
  const operationId='op';
  for(let index=0;index<=scenario.workers;index++){
    const attemptId='attempt-'+index,controller=index===0;
    const fact={kind:'attempt.dispatched',journalEventId:'dispatch-'+index,
      operationId,attemptId,actionId:controller?attemptId:'action-'+index,
      attemptOrdinal:index+1,invocationKind:controller?'controller':'delegate',
      roleId:controller?undefined:'arbitrary',profileId:'same-profile',modelSelector:'requested',
      objective:scenario.large?'Objective '+('A'.repeat(6000)):'Read project'};
    const event=(eventName,level='info',reasonCode='RECORDED')=>({
      schemaVersion:1,operationId,attemptId,actionId:fact.actionId,
      eventId:eventName+'-'+index+'-'+(++seq),sequence:seq,receivedAt:seq,
      component:'core',level,eventName,reasonCode,
    });
    progress(event('attempt.dispatched','info','DISPATCH_STARTED'),[],fact);
    const activity=(kind,payload,nativeKind,nativeId)=>view.acpActivity({
      kind,payload,operationId,attemptId,profileId:'same-profile',providerId:'fixture',sequence:++seq,
      source:'provider_activity',invocationKind:controller?'controller':'delegate',
      nativeKind,nativeId,
    },mode,controller);
    push(activity('plan',{sessionUpdate:'plan',entries:[{content:'Native plan',priority:'medium',status:'pending'}]},'plan'));
    for(let i=0;i<scenario.stream;i++){
      push(activity('reasoning',{sessionUpdate:'agent_thought_chunk',content:{type:'text',
        text:'Thinking '+i+' '+(scenario.large?'🌍'.repeat(30):'')}},'agent_thought_chunk'));
      if(i%5===0){
        push(activity('tool',{sessionUpdate:'tool_call',toolCallId:'tool-'+i,title:'Read',
          kind:'read',status:'in_progress'},'tool_call','tool-'+i));
        push(activity('tool',{sessionUpdate:'tool_call_update',toolCallId:'tool-'+i,
          status:'completed'},'tool_call_update','tool-'+i));
      }
      if(i%8===0){
        progress(event('provider.usage'),[],undefined);
        progress(event('context.materialized'),[],undefined);
      }
      if(i%24===0)await Promise.resolve();
    }
    const finding=index===0?[]:[{findingId:'f-'+index,author:'same-profile',
      claim:scenario.large?'Finding '+('foo_bar()'.repeat(2000))+'\nSupports: fake':
        'Finding claim\nSubject: fake',subject:'src/file.js',
      uncertainties:['Pending verification'],supports:['obs:real']}];
    progress(event('attempt.outcome','info','OUTCOME_RECORDED'),finding,
      {...fact,kind:'attempt.outcome',terminal:'completed',effect:'unknown'});
  }
  progress({schemaVersion:1,operationId,eventId:'done',sequence:++seq,receivedAt:seq,
    level:'info',eventName:'operation.finished',reasonCode:'ASSESSMENT_RECORDED'},[],
    {kind:'operation.finished',assessmentOverall:'complete',hasModelAnswer:true});
  const productionMs=performance.now()-started;
  const drainStart=performance.now();
  const lost=await transport.finish(180);
  const drainMs=performance.now()-drainStart;
  assert.ok(lost>=0&&Number.isFinite(lost));
  return {...counts,notConfirmed:lost,firstMs,firstNativeMs,productionMs,
    drainMs,totalMs:performance.now()-started,final:'Original final '+code+'Markdown'+code,
    deliveredKinds:delivered.filter(x=>nativeKinds.includes(x)).length};
}
const out=[];
for(const scenario of scenarios)for(const mode of modes)for(const display of displays)for(const clientKind of clients){
  const before=[],after=[];
  for(let roundIndex=0;roundIndex<3;roundIndex++){
    const pair=roundIndex%2===0?[old,current]:[current,old];
    const results=[];
    for(const view of pair)results.push(await sample(view,scenario,mode,display,clientKind));
    before.push(results[pair[0]===old?0:1]);
    after.push(results[pair[0]===old?1:0]);
  }
  for(let i=0;i<3;i++){
    assert.equal(before[i].final,after[i].final);
    assert.ok(after[i].attemptedNative>=before[i].attemptedNative,
      'Only Controller native plan may be newly available in compact');
  }
  const numeric=['attempted','attemptedNative','attemptedOwn','delivered','deliveredNative','deliveredOwn',
    'droppedByQueue','gapsDelivered','notificationFailures','attemptedBytes','deliveredBytes',
    'notConfirmed','firstMs','firstNativeMs','productionMs','drainMs','totalMs'];
  const summarize=xs=>Object.fromEntries(numeric.map(key=>[key,
    xs.some(x=>x[key]===null)?null:round(median(xs.map(x=>x[key])))]));
  out.push({scenario:scenario.name,mode,display,client:clientKind,
    baseline:summarize(before),corrected:summarize(after)});
}
for(const result of out)console.log('C15R_GUI_R1_CASE '+JSON.stringify(result));
console.log('C15R_GUI_R1_TRANSPORT '+JSON.stringify({
  baseline,current:now,node:process.version,rounds:3,caseCount:out.length,
  scope:'deterministic ACP presentation+bounded-delivery fixture, not a real Zed/LLM',
  counts:'droppedByQueue counts overflow; notConfirmed from finish can overlap pending gap/failures',
}));
