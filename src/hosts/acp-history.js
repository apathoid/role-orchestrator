import { historicalOutcomeReports } from '../core/snapshot.js';
import { journalReasonCode } from '../core/operation.js';
import { eventFindings } from '../core/finding.js';
import { executionFact } from '../application/execution-facts.js';
import { boundedText, acpAccepted, acpExecutionInline, acpOwnMessage } from './presentation.js';

/** @import {Event, Operation} from '../core/operation.js' */
/** @import {ContentBlock, SessionUpdate, StopReason} from '@agentclientprotocol/sdk' */
/** @import {PresentationMode, ProgressDisplay} from './presentation.js' */
/** @typedef {{requestId:string,fingerprint:string,controllerProfile?:string,userSettings?:import('../core/contracts.js').UserSettings,agentSkill?:ReturnType<typeof import('../core/contracts.js').agentSkill>,operationId?:string,responseEventId?:string,progressDisplay?:ProgressDisplay}} SessionRequest */
/** @typedef {{sessionId:string,cwd:string,controllerProfile?:string,userSettings?:import('../core/contracts.js').UserSettings,skillsAdvertised?:boolean,operations:string[],requests:SessionRequest[]}} Session */
/** @typedef {Pick<Operation,'operationId'|'status'|'waiting'|'assessment'>} ReplyState */
/** @typedef {{text?:string,stopReason:StopReason}} Reply */
/** @typedef {(operationId:string,turn:import('../core/ports.js').OrderedTurn,signal:AbortSignal,onOmitted:(ref:string)=>void)=>Promise<ContentBlock[]|undefined>} ReplayContent */

/** @param {string} sessionId @param {string} requestId */
export const operationRequestId=(sessionId,requestId)=>'acp:'+sessionId+':'+requestId;

/** Same authoritative response mapping for live and exact historical boundaries.
 * @param {ReplyState} operation @returns {Reply}
 */
export function operationReply(operation){
  if(operation.status==='cancelled')return {stopReason:'cancelled'};
  if(operation.status==='finished')return {stopReason:'end_turn',text:operation.assessment?.answer};
  if(operation.waiting?.kind==='question')return {stopReason:'end_turn',text:operation.waiting.question};
  if(operation.waiting?.kind==='technical'){
    const reason=operation.waiting.reason;
    return {stopReason:reason.code==='RESOURCE_LIMIT'?'max_turn_requests':'refusal',text:reason.profileId?
      'Error: '+reason.code+' operation='+operation.operationId+' profile='+reason.profileId+
        ' reasoningLevel='+(reason.reasoningLevel??'(default)')+' available='+(reason.availableLevels??[]).join(',')+
        (reason.reasoningCause?' cause='+reason.reasoningCause:''):
      'Waiting: '+reason.code};
  }
  return {stopReason:'end_turn'};
}

/** Exact initial/continued request association, never Operation membership alone.
 * @param {Operation} operation @param {string} durableId
 */
export function turnRange(operation,durableId){
  const events=operation.events;
  let start=0,text=operation.request.text,content=operation.request.content,continuing=false;
  if(operation.request.requestId!==durableId){
    const index=events.findIndex(event=>event.kind==='operation.continued'&&event.input.requestId===durableId);
    if(index<0)return;
    const event=events[index];
    if(event.kind!=='operation.continued')return;
    start=index+1;text=event.input.text;content=event.input.content;continuing=true;
  }
  const next=events.findIndex((event,index)=>index>=start&&event.kind==='operation.continued');
  return {start,end:next<0?events.length:next,text,content,continuing};
}

/** @param {Event} event @returns {Reply|undefined} */
function eventReply(event){
  if(event.kind==='operation.finished')return operationReply({operationId:event.operationId,status:'finished',assessment:event.assessment});
  if(event.kind==='operation.waiting')return operationReply({operationId:event.operationId,status:'waiting',waiting:event.waiting});
  if(event.kind==='operation.cancelled')return operationReply({operationId:event.operationId,status:'cancelled'});
}

/** Capture only the response actually returned by this completed submission.
 * @param {Operation} operation @param {string} durableId
 */
export function responseBoundary(operation,durableId){
  const range=turnRange(operation,durableId);
  if(!range||range.end!==operation.events.length)return;
  const kind=operation.status==='finished'?'operation.finished':operation.status==='waiting'?'operation.waiting':
    operation.status==='cancelled'?'operation.cancelled':undefined;
  if(!kind)return;
  for(let i=range.end-1;i>=range.start;i--){
    const event=operation.events[i];
    if(event.kind===kind)return event.eventId;
  }
}

/** Older records can recover a response only if exactly one durable candidate exists.
 * @param {Operation} operation @param {string} durableId @param {string} [responseEventId]
 */
export function historicalReply(operation,durableId,responseEventId){
  const range=turnRange(operation,durableId);
  if(!range)return;
  /** @type {{index:number,reply:Reply}|undefined} */
  let candidate;
  for(let i=range.start;i<range.end;i++){
    const event=operation.events[i],reply=eventReply(event);
    if(responseEventId!==undefined){
      if(event.eventId===responseEventId&&reply)return {index:i,reply};
      continue;
    }
    if(reply){
      if(candidate)return;
      candidate={index:i,reply};
    }
  }
  return candidate;
}

/** Stream user/answer text below the ACP frame limit without changing text.
 * @param {string} text @param {boolean} user @param {(update:SessionUpdate)=>Promise<void>} emit @param {AbortSignal} [signal]
 */
async function replayText(text,user,emit,signal){
  const size=64*1024;
  for(let offset=0;!signal?.aborted&&(offset<text.length||offset===0);){
    let end=Math.min(offset+size,text.length);
    if(end<text.length&&text.charCodeAt(end-1)>=0xd800&&text.charCodeAt(end-1)<=0xdbff)end--;
    await emit({sessionUpdate:user?'user_message_chunk':'agent_message_chunk',content:{type:'text',text:text.slice(offset,end)}});
    if(end===text.length)break;
    offset=end;
  }
}

/** @param {Operation} operation @param {number} index @param {PresentationMode} mode @param {ReturnType<typeof historicalOutcomeReports>} reports */
function journalUpdates(operation,index,mode,reports){
  const event=operation.events[index],fact=executionFact(operation,event);
  if(event.kind==='operation.continued')return [];
  // Classification comes from the validated historical prefix, never today's terminal state.
  const report=event.kind==='attempt.outcome'?reports.get(event.eventId):undefined;
  const eventName=event.kind==='attempt.outcome'?(report?.eventName??'attempt.historical_outcome_report'):event.kind;
  const reasonCode=event.kind==='attempt.outcome'?(report?.reasonCode??'CLASSIFICATION_NOT_RECORDED'):journalReasonCode(event);
  // Presentation projection only: no DiagnosticPort emission or replay.
  return acpExecutionInline({schemaVersion:1,eventId:event.eventId,operationId:operation.operationId,
    receivedAt:event.receivedAt,sequence:index+1,component:'core',level:eventName==='controller.invalid_proposal'||eventName==='attempt.outcome_discrepancy'?'warn':'info',
    eventName,reasonCode,attemptId:fact.attemptId,actionId:fact.actionId},
    eventFindings(event),mode,fact,true);
}

/** Chronological session turns; snapshots are reused only within this load and
 * released on switch/last request. No copied journal or replayed tools.
 * @param {Session} session @param {(id:string)=>Promise<Operation>} inspect
 * @param {(update:SessionUpdate)=>Promise<void>} emit @param {PresentationMode} mode
 * @param {ProgressDisplay} display @param {AbortSignal} [signal] @param {ReplayContent} [replayContent]
 */
export async function replayHistory(session,inspect,emit,mode,display,signal,replayContent){
  // Keep at most one full snapshot, even when many Operations interleave.
  // A revisit reads the append-only journal again; recorded response IDs remain exact.
  /** @type {Operation|undefined} */
  let snapshot;
  /** @type {ReturnType<typeof historicalOutcomeReports>} */
  let reports=new Map();
  let classified=false;
  /** @type {Map<string,number>} */
  const remaining=new Map(),seenBoundary=new Map();
  const seen=new Set();
  /** Exact durable turn references, not guessed from title or chronological time. */
  /** @type {Map<string,Set<string>>} */
  const associated=new Map();
  for(const req of session.requests)if(req.operationId){
    let ids=associated.get(req.operationId);
    if(!ids)associated.set(req.operationId,ids=new Set());
    ids.add(operationRequestId(session.sessionId,req.requestId));
  }
  /** @param {Operation} operation @param {string} id @param {string} text @param {string} origin */
  async function unassociated(operation,id,text,origin){
    if(signal?.aborted)return;
    await emit(acpOwnMessage(
      'Recovered '+origin+' for Operation '+operation.operationId+
      ' (not associated with a recorded session turn; chronological position/answer unknown)'+
      (text?'\n'+boundedText(text,2048):''),
      {source:'history',operationId:operation.operationId,recovered:true,requestId:id},
      'orphan:'+id));
  }
  for(const request of session.requests)if(request.operationId)remaining.set(request.operationId,(remaining.get(request.operationId)??0)+1);
  /** Recovered user records are independent of inline/notices presentation mode.
   * Traverse only gaps outside known session turns, never infer turn chronology.
   * @param {Operation} operation @param {number} from @param {number} to
   */
  async function orphanRecords(operation,from,to){
    const known=associated.get(operation.operationId);
    if(from===0&&to>0&&!known?.has(operation.request.requestId)){
      await unassociated(operation,operation.request.requestId,operation.request.text,'initial Request');
    }
    for(let index=from;!signal?.aborted&&index<to;index++){
      const item=operation.events[index];
      if(item.kind==='operation.continued'&&!known?.has(item.input.requestId)){
        await unassociated(operation,item.input.requestId,item.input.text,'continuation');
      }
    }
  }
  /** Technical journal facts are optional inline presentation, not user-turn recovery.
   * @param {Operation} operation @param {number} from @param {number} to
   */
  async function background(operation,from,to){
    let heading=false;
    for(let index=from;!signal?.aborted&&index<to;index++){
      for(const update of journalUpdates(operation,index,mode,reports)){
        if(!heading){
          heading=true;
          await emit(acpOwnMessage('Recovered Operation '+operation.operationId+' · facts outside the recorded response boundary',
            {source:'history',operationId:operation.operationId,recovered:true},'background:'+operation.events[from]?.eventId));
        }
        await emit(update);
      }
    }
  }
  for(const request of session.requests){
    if(signal?.aborted)return;
    const id=request.operationId;
    if(!id||!session.operations.includes(id))continue;
    if(snapshot?.operationId!==id){snapshot=undefined;reports.clear();classified=false;snapshot=await inspect(id);}
    const operation=snapshot;
    if(signal?.aborted)return;
    const durableId=operationRequestId(session.sessionId,request.requestId);
    const range=turnRange(operation,durableId);
    const inline=(request.progressDisplay??display)==='inline';
    if(inline&&!classified){reports=historicalOutcomeReports(operation);classified=true;}
    if(range){
      seen.add(id);
      const prior=seenBoundary.get(id);
      const earlier=range.start-(range.continuing?1:0);
      if((prior??0)<earlier){
        await orphanRecords(operation,prior??0,earlier);
        if(inline)await background(operation,prior??0,earlier);
      }
      if(range.content){
        /** @type {string[]} */ const omitted=[];
        const blocks=await replayContent?.(id,{requestId:durableId,text:range.text,content:range.content},signal??new AbortController().signal,ref=>omitted.push(ref));
        if(blocks)for(const content of blocks){if(signal?.aborted)return;await emit({sessionUpdate:'user_message_chunk',content});}
        else {
          await replayText(range.text,true,emit,signal);
          await emit(acpOwnMessage('Historical user content unavailable; embedded payloads were not reconstructed',
            {source:'history',operationId:id,requestId:durableId,recovered:true},durableId));
        }
        for(const ref of omitted)await emit(acpOwnMessage('Historical user block unavailable: '+ref,{source:'history',operationId:id,requestId:durableId,recovered:true},durableId));
      }else await replayText(range.text,true,emit,signal);
      if(signal?.aborted)return;
      if(inline){const accepted=acpAccepted(id,durableId,range.continuing,'inline',true,mode);
        if(accepted)await emit(accepted);}
      const response=historicalReply(operation,durableId,request.responseEventId);
      const end=response?response.index+1:range.end;
      if(inline)for(let i=range.start;!signal?.aborted&&i<end;i++)for(const update of journalUpdates(operation,i,mode,reports)){
        if(signal?.aborted)return;
        await emit(update);
      }
      if(signal?.aborted)return;
      if(response){
        if(response.reply.text!==undefined)await replayText(response.reply.text,false,emit,signal);
      }else{
        await emit(acpOwnMessage('Historical response boundary unavailable; no answer inferred for this request',
          {source:'history',operationId:id,requestId:durableId,recovered:true},durableId));
      }
      seenBoundary.set(id,end);
    }else{
      await emit(acpOwnMessage('Recorded session association unavailable for request '+durableId+
        ' in Operation '+id+'; no user text or answer inferred',
        {source:'history',operationId:id,requestId:durableId,recovered:true},'missing-association:'+durableId));
    }
    const left=(remaining.get(id)??1)-1;
    remaining.set(id,left);
    if(left===0){
      const boundary=seenBoundary.get(id);
      if(boundary!==undefined&&boundary<operation.events.length){
        await orphanRecords(operation,boundary,operation.events.length);
        if(inline)await background(operation,boundary,operation.events.length);
      }
      snapshot=undefined;reports.clear();classified=false;seenBoundary.delete(id);
    }
  }
  for(const id of session.operations)if(!signal?.aborted&&!seen.has(id)){
    await emit(acpOwnMessage('Recovered Operation '+id+
      ' · no authoritative session turn association; no chronological user answer inferred',
      {source:'history',operationId:id,recovered:true},'missing-turns'));
    if(signal?.aborted)return;
    /** @type {Operation|undefined} */
    let operation;
    try{operation=await inspect(id);}catch{ /* An unavailable legacy snapshot is not a turn. */ }
    if(!operation||signal?.aborted)continue;
    await orphanRecords(operation,0,operation.events.length);
    if(display==='inline'){
      reports=historicalOutcomeReports(operation);
      await background(operation,0,operation.events.length);
    }
    reports.clear();
  }
}
