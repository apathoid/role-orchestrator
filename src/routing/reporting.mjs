// Read-only, provider-neutral aggregation over existing redacted execution traces.
// These statistics are operational evidence only, NEVER semantic accuracy.
import { taskSpecFailureCode } from './task-spec.mjs';
import { routingOutputFailureCode } from './output-failures.mjs';
const OPERATIONS=new Set(['investigate','review','change','plan']);
const WRITES=new Set(['explicit','not_requested','ambiguous']);
const code=s=>typeof s==='string'&&/^[a-zA-Z0-9_.:/-]{1,100}$/.test(s)?s:null;
const select=(value,permitted)=>permitted.includes(value)?value:null;
const READ_ONLY_STATUS=['accepted','invalid','missing'];
const SEL=['recent_commits','commit','range','relative_ref','worktree','staged','unstaged','ticket_commits','union'];
const CONT=['new','current_review','current_implementation','saved_implementation','saved_review','information','revise_plan','reconcile','ambiguous'];
const CONTEXT=['legacy','observe','optimized'];
const REASONS=['legacy_mode','manifest_missing','manifest_unavailable','manifest_invalid','document_digest_mismatch','no_reduction','observe_only','explicit_digest_verified'];
const normalizeRoute=v=>v?{mode:select(v.mode,[...OPERATIONS]),
  writeIntent:select(v.writeIntent,[...WRITES]),continuation:select(v.continuation,CONT),
  selectorType:select(v.selectorType,SEL),targetKind:select(v.targetKind,['none','git'])}:null;
const normalizeContext=v=>v?{requestedMode:select(v.requestedMode,CONTEXT),
  selectedMode:select(v.selectedMode,['legacy','optimized']),fallbackReason:select(v.fallbackReason,REASONS)}:null;
const count=(xs,key)=>Object.fromEntries([...new Set(xs.map(x=>x?.[key]).filter(Boolean))]
  .sort().map(k=>[k,xs.filter(x=>x?.[key]===k).length]));
const ratio=(n,d)=>({numerator:n,denominator:d,value:d?n/d:null,
  status:d?'MEASURED':'NOT_VERIFIED'});
function samples(xs,fn){const vals=xs.map(fn).filter(x=>Number.isFinite(x)&&x>=0);return {
  count:vals.length,missing:xs.length-vals.length,sum:vals.length?vals.reduce((a,b)=>a+b,0):null,
  mean:vals.length?vals.reduce((a,b)=>a+b,0)/vals.length:null,
  status:vals.length===xs.length&&xs.length?'MEASURED':vals.length?'PARTIAL':'NOT_VERIFIED'};}
function pick(events,kind){return events.filter(e=>e?.kind===kind).map(e=>e.data??{});}
const PROVIDER_CODES=new Set(['PROVIDER_CANCELLED','PROVIDER_CRASH','RATE_LIMIT','TIMEOUT','PROVIDER_TIMEOUT','MODEL_UNAVAILABLE','UNCLASSIFIED_PROVIDER_FAILURE']);
const CONTRACT_CODES=new Set(['INVALID_TASK_SPEC','INVALID_STRUCTURED_OUTPUT','MISSING_TASK_SPEC','CONTRACT_FAILURE']);
const ENV_CODES=new Set(['ENVIRONMENT_ERROR','ENVIRONMENT_FAILURE','INFRA_FAILURE','STORAGE_FAILURE','TOOL_UNAVAILABLE']);
const AUTH_CODES=new Set(['AUTHORIZATION_DENIED','WRITE_DENIED','UNAUTHORIZED_CHANGE']);
const USER_CANCEL_CODES=new Set(['SESSION_CANCELLED','CLIENT_REQUEST_CANCELLED']);
const normalizeFailure=(e)=>{
  const raw=e.data??{};
  const reason=raw.code??raw.reason??null;
  if(PROVIDER_CODES.has(reason))return {code:reason,origin:'provider'};
  if(CONTRACT_CODES.has(reason))return {code:reason,origin:'contract'};
  if(ENV_CODES.has(reason))return {code:reason,origin:'environment'};
  if(AUTH_CODES.has(reason))return {code:reason,origin:'authorization'};
  if(USER_CANCEL_CODES.has(reason))return {code:reason,origin:'cancellation'};
  if(!reason&&raw.source==='provider')return {code:'UNCLASSIFIED_PROVIDER_FAILURE',origin:'provider'};
  return {code:null,origin:'unknown'}; // Historical missing/unrecognized reason is not proof of a provider failure.
};

export function aggregateRoutingTraces(traces) {
  const records=[];let replayErrors=0,duplicates=0,partial=0;const seenRuns=new Set();
  for(const input of traces){
    if(!Array.isArray(input)){replayErrors++;continue;}
    const seen=new Set(),events=[];
    for(const ev of input){
      if(ev?.version!==1 || !code(ev.kind) || !code(ev.runId) ||
          typeof ev.timestamp!=='string' || !Number.isFinite(Date.parse(ev.timestamp))) {replayErrors++;continue;}
      const identity=code(ev.eventId)??(Number.isSafeInteger(ev.sequence)&&ev.sequence>0?`${ev.runId}:${ev.sequence}`:null);
      const sequence=Number.isSafeInteger(ev.sequence)&&ev.sequence>0?`${ev.runId}:${ev.sequence}`:null;
      if((identity&&seen.has(identity))||(sequence&&seen.has(sequence))){duplicates++;continue;}
      if(identity)seen.add(identity);
      if(sequence)seen.add(sequence);
      events.push(ev);
    }
    if(!events.length)continue;
    const runKey=JSON.stringify([events[0].sessionId??null,events[0].runId]);
    if(seenRuns.has(runKey)){duplicates+=events.length;continue;}seenRuns.add(runKey);
    const uniqueRole=(kind)=>{
      const seenInvocations=new Set();
      return events.filter(e=>e.kind===kind&&e.data?.role==='router').filter(e=>{
        const id=code(e.correlation?.invocationId)??code(e.data?.invocationId);
        if(!id)return true; // A historical event lacking correlation cannot prove identity.
        if(seenInvocations.has(id)){duplicates++;return false;}
        seenInvocations.add(id);return true;
      });
    };
    const startEvents=uniqueRole('role_start');
    const starts=startEvents.map(e=>e.data);
    const startedIds=new Set(startEvents.map(e=>code(e.correlation?.invocationId)??code(e.data?.invocationId)).filter(Boolean));
    const completed=uniqueRole('role_done').map(e=>e.data);
    const failureEvents=[];const failedInvocations=new Set();
    for(const event of [...uniqueRole('role_error'),...uniqueRole('role_cancelled')].sort((a,b)=>(a.sequence??0)-(b.sequence??0))){
      const id=code(event.correlation?.invocationId)??code(event.data?.invocationId);
      if(id&&failedInvocations.has(id)){duplicates++;continue;}
      if(id)failedInvocations.add(id);
      failureEvents.push(event);
    }
    // Credit at most one failure per observed Router start. An uncorrelated
    // historical failure is attributable only when there is exactly one start
    // and no other failure has already consumed it; otherwise evidence is
    // insufficient. This also prevents rates above 100% on partial traces.
    const creditedStarts=new Set();
    const correlatedFailures=new Set(failureEvents.map(e=>
      code(e.correlation?.invocationId)??code(e.data?.invocationId)).filter(id=>id&&startedIds.has(id)));
    const failures=failureEvents.map(e=>{
      const failure=normalizeFailure(e);
      const invocationId=code(e.correlation?.invocationId)??code(e.data?.invocationId);
      const startKey=invocationId&&startedIds.has(invocationId)?invocationId:
        !invocationId&&starts.length===1&&!correlatedFailures.size?(
          code(startEvents[0].correlation?.invocationId)??code(startEvents[0].data?.invocationId)??'sole-start'):
          null;
      if(!startKey||creditedStarts.has(startKey)){
        // Retain a count of uncorrelated failures, but do not guess origin.
        return {...failure,code:null,origin:'unknown'};
      }
      creditedStarts.add(startKey);
      return failure;
    });
    const route=normalizeRoute(pick(events,'route').at(-1));
    const rawValidation=pick(events,'semantic_intent_validation').at(-1)??null;
    const validation=rawValidation?{status:select(rawValidation.status,READ_ONLY_STATUS),
      reason:select(rawValidation.code,['ROUTER_TASK_MISSING','ROUTER_TASK_INVALID','ROUTER_OUTPUT_UNSTRUCTURED','ROUTER_OUTPUT_MALFORMED','ROUTER_OUTPUT_INCOMPLETE','ROUTER_OUTPUT_AMBIGUOUS','ROUTER_OUTPUT_INVALID']),
      stage:select(rawValidation.stage,['structured_extraction','shape_validation','workflow_validation','task_validation','validated']),
      taskFailureCode:taskSpecFailureCode(rawValidation.taskFailureCode),
      outputFailureCode:routingOutputFailureCode(rawValidation.outputFailureCode)}:null;
    const context=normalizeContext(pick(events,'role_router_context').at(-1));
    const rawTrusted=pick(events,'trusted_continuation').at(-1)??null;
    const trusted=rawTrusted?{kind:select(rawTrusted.kind,['saved_review','saved_implementation','current_review','current_implementation'])}:null;
    const rawAuth=pick(events,'authorization_resolution').at(-1)??null;
    const auth=rawAuth?{status:select(rawAuth.status,['read_only','write_gated','denied'])}:null;
    const outcome=pick(events,'routing_outcome').at(-1)??null;
    const terminal=events.some(e=>['run.finished','run.failed','run.cancelled'].includes(e.kind));
    if(!terminal||events.some(e=>e.kind==='observability.degraded'||e.data?.truncated===true||e.data?.degraded===true))partial++;
    // Router invocations are backed by role_start, not route or success.
    records.push({sessionId:code(events[0]?.sessionId),runId:code(events[0]?.runId),
      timestamp:events[0]?.timestamp??null,invocations:starts.length,
      invocation:starts.length?Object.fromEntries(['provider','model','profile','preset'].map(k=>[k,code(starts.at(-1)[k])])):null,
      finish:completed.at(-1)??null,finishes:completed,failure:failures.at(-1)??null,
      failures,
      route,validation,context,trusted,authorization:auth,outcome,
      terminal,telemetryDegraded:!terminal||events.some(e=>e.kind==='observability.degraded'||e.data?.degraded===true||e.data?.truncated===true)});
  }
  const invokes=records.flatMap(r=>Array.from({length:r.invocations},(_,i)=>({record:r,index:i})));
  const validation=records.filter(r=>r.validation!==null);
  const routed=records.filter(r=>r.route&&OPERATIONS.has(r.route.mode));
  const finished=records.flatMap(r=>r.finishes);
  const fails=records.flatMap(r=>r.failures);
  const providerFails=fails.filter(r=>r.origin==='provider');
  const metric={version:1,source:'execution_trace',qualityGroundTruth:'NOT_VERIFIED',
    semanticAccuracy:null,coverage:{runs:records.length,partialRuns:partial,replayErrors,duplicates,
      withRoute:routed.length,withValidation:validation.length,unknownFailureReasons:fails.filter(r=>r.origin==='unknown').length,withTrustedContinuation:records.filter(r=>r.trusted).length},
    counters:{routerInvocations:invokes.length,validated:validation.filter(r=>r.validation.status==='accepted').length,
      validationFailures:validation.filter(r=>['invalid','missing'].includes(r.validation.status)).length,
      providerFailures:providerFails.length,unknownFailures:fails.filter(r=>r.origin==='unknown').length,authorizationRejections:records.filter(r=>r.authorization?.status==='denied').length,
      trustedContinuations:records.filter(r=>r.trusted).length,
      contextFallbacks:records.filter(r=>r.context?.requestedMode==='optimized'&&r.context.selectedMode==='legacy').length},
    rates:{validationFailure:ratio(validation.filter(r=>['invalid','missing'].includes(r.validation.status)).length,validation.length),
      providerFailure:ratio(providerFails.length,invokes.length),
      authorizationRejection:ratio(records.filter(r=>r.authorization?.status==='denied').length,records.filter(r=>r.authorization).length),
      optimizedFallback:ratio(records.filter(r=>r.context?.requestedMode==='optimized'&&r.context.selectedMode==='legacy').length,
        records.filter(r=>r.context?.requestedMode==='optimized').length)},
    distributions:{operation:count(routed.map(r=>r.route),'mode'),writeIntent:count(routed.map(r=>r.route).filter(r=>WRITES.has(r.writeIntent)),'writeIntent'),
      continuation:count(routed.map(r=>r.route),'continuation'),validation:count(validation.map(r=>r.validation),'status'),
      validationReasons:count(validation.map(r=>r.validation),'reason'),validationStages:count(validation.map(r=>r.validation),'stage'),
      taskValidationReasons:count(validation.map(r=>r.validation),'taskFailureCode'),
      outputValidationReasons:count(validation.map(r=>r.validation),'outputFailureCode'),
      providerErrors:count(providerFails,'code'),failureOrigins:count(fails,'origin'),
      nonProviderErrors:count(fails.filter(r=>r.origin!=='provider'&&r.code),'code'),contextMode:count(records.map(r=>r.context).filter(Boolean),'requestedMode'),
      fallbackReasons:count(records.map(r=>r.context).filter(Boolean),'fallbackReason')},
    usage:{latencyMs:samples(finished,r=>r.elapsedMs),
      inputTokens:samples(finished,r=>r.usage?.inputTokens),
      outputTokens:samples(finished,r=>r.usage?.outputTokens),
      cachedInputTokens:samples(finished,r=>r.usage?.cachedInputTokens)},
    groups:{}, records:records.map(r=>({sessionId:r.sessionId,runId:r.runId,invocations:r.invocations,
      operation:r.route?.mode??null,writeIntent:r.route?.writeIntent??null,
      validation:r.validation?.status??null,context:r.context?.requestedMode??null,
      routeSource:r.trusted?'trusted_continuation':r.invocations?'router':'not_observed',
      provider:r.invocation?.provider??null,model:r.invocation?.model??null,profile:r.invocation?.profile??null,preset:r.invocation?.preset??null,
      terminal:r.terminal,telemetryDegraded:r.telemetryDegraded}))};
  const by=new Map();for(const r of records){
    const key=JSON.stringify([r.invocation?.provider??'unknown',r.invocation?.model??'unknown',
      r.invocation?.preset??'unknown',r.context?.requestedMode??'unknown']);
    if(!by.has(key))by.set(key,[]);by.get(key).push(r);
  }
  metric.groups=Object.fromEntries([...by].map(([key,group])=>[key,{
    runs:group.length,routerInvocations:group.reduce((n,r)=>n+r.invocations,0),
    routed:group.filter(r=>r.route).length,providerFailures:group.reduce((n,r)=>n+r.failures.filter(f=>f.origin==='provider').length,0)}]));
  metric.status=replayErrors||partial||fails.some(f=>f.origin==='unknown')?'PARTIAL':records.length?'MEASURED':'NOT_VERIFIED';
  return metric;
}
export async function routingReport({observer,sessionId=null,runId=null,limit=100,from=null,to=null}={}) {
  if(!observer || typeof observer.getTrace!=='function')throw new TypeError('Execution observer required');
  const start=from?Date.parse(from):null,end=to?Date.parse(to):null;
  if((from&&!Number.isFinite(start))||(to&&!Number.isFinite(end)))throw new TypeError('Invalid report period');
  const sessions=sessionId?[sessionId]:await observer.listSessions({limit:Math.min(1000,limit+1)});
  const traces=[],errors=[];let omitted=Math.max(0,sessions.length-limit);
  for(const id of sessions.slice(0,limit)){
    let ids;
    try {ids=runId?[{runId}]:observer.listRunIds?await observer.listRunIds(id,{limit:1000}):await observer.listRuns(id,{limit:Math.min(limit,20)});
      if(ids.length>20)omitted+=ids.length-20;ids=ids.slice(0,20);}catch{errors.push('READ_ERROR');continue;}
    for(const item of ids){
      try {const events=await observer.getTrace(id,{runId:item.runId,full:true});
        const at=Date.parse(events[0]?.timestamp??'');
        if(events.length && (start===null||at>=start)&&(end===null||at<=end))traces.push(events);
      }catch{errors.push('READ_ERROR');}
    }
  }
  const result=aggregateRoutingTraces(traces);
  result.coverage.readErrors=errors.length;
  result.coverage.omittedByBound=omitted;
  if(errors.length||omitted)result.status='PARTIAL';
  result.period={from:from??null,to:to??null};
  return result;
}
