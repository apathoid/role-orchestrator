import { resourceSnapshot } from '../core/operation.js';
import { eventFindings } from '../core/finding.js';

/** @import {ActivityNotice, ActivityEvent} from '../core/ports.js' */
/** @import {DiagnosticEvent} from '../core/diagnostics.js' */
/** @import {Event, Operation} from '../core/operation.js' */
/** @import {SessionUpdate} from '@agentclientprotocol/sdk' */
/** @import {ExecutionFact} from '../application/execution-facts.js' */
/** @typedef {'compact' | 'detailed' | 'debug'} PresentationMode */
/** @typedef {'inline'|'notices'} ProgressDisplay */
/** @typedef {'header'|'thinking'|'tool'|'finding'|'error'|'success'|'neutral'} PresentationTone */

/** Display only: preserve underlying payload and final answer. @param {string} text */
export function terminalText(text) {
  return text.replace(/(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c|$)/g, '')
    .replace(/(?:\x1b[P^_X]|[\x90\x98\x9e\x9f])[\s\S]*?(?:\x1b\\|\x9c|$)/g, '')
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '');
}

/** Bounded stream sanitizer: remembers only the active control sequence kind.
 * Untrusted fragments are sanitized before trusted ANSI styling.
 */
export function createTerminalSanitizer() {
  /** @type {'text'|'esc'|'csi'|'osc'|'string'|'oscEsc'|'stringEsc'} */
  let state='text';
  return {
    reset(){state='text';},
    /** @param {string} fragment */
    push(fragment){
      let output='';
      for(const ch of fragment){
        const code=ch.codePointAt(0)??0;
        if(state==='esc'){
          state=ch==='['?'csi':ch===']'?'osc':'P^_X'.includes(ch)?'string':'text';
          continue;
        }
        if(state==='csi'){
          if(code>=0x40&&code<=0x7e)state='text';
          else if(ch==='\x1b')state='esc';
          continue;
        }
        if(state==='oscEsc'||state==='stringEsc'){
          state=ch==='\\'?'text':state==='oscEsc'?'osc':'string';
          continue;
        }
        if(state==='osc'||state==='string'){
          if(code===0x9c||(state==='osc'&&code===7))state='text';
          else if(ch==='\x1b')state=state==='osc'?'oscEsc':'stringEsc';
          continue;
        }
        if(code===0x1b){state='esc';continue;}
        if(code===0x9b){state='csi';continue;}
        if(code===0x9d){state='osc';continue;}
        if([0x90,0x98,0x9e,0x9f].includes(code)){state='string';continue;}
        if((code<32&&code!==9&&code!==10)||(code>=127&&code<=159)||
          (code>=0x202a&&code<=0x202e)||(code>=0x2066&&code<=0x2069))continue;
        output+=ch;
      }
      return output;
    },
  };
}

/** @param {string} text @param {number} [limit] */
export function boundedText(text,limit=4096){
  const safe=terminalText(text);
  if(safe.length<=limit)return safe;
  const end=safe.charCodeAt(limit-1)>=0xd800&&safe.charCodeAt(limit-1)<=0xdbff?limit-1:limit;
  return safe.slice(0,end)+'… [display truncated]';
}

/** @param {ExecutionFact} fact */
export function factLabel(fact){
  return (fact.invocationKind==='controller'?'Controller':boundedText(fact.roleId??'Worker',80).replace(/[\n\t]/g,' '))+
    (fact.attemptOrdinal!==undefined?' #'+fact.attemptOrdinal:'')+
    (fact.profileId?' · '+boundedText(fact.profileId,120).replace(/[\n\t]/g,' '):'');
}

/** @param {unknown} value @returns {Record<string, unknown>} */
function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value) : {};
}
/** @param {unknown} value */
const string = value => typeof value === 'string' ? value : undefined;
/** @param {ActivityEvent} event */
export function nativeText(event) {
  const payload = object(event.payload);
  if (typeof event.payload === 'string') return event.payload;
  const content = object(payload.content), item = object(payload.item);
  if (content.type === 'text') return string(content.text);
  return string(item.text) ?? string(payload.text) ?? (event.kind === 'finding' ? string(payload.claim) : undefined);
}

/** @param {ActivityNotice} event @param {PresentationMode} mode @param {string} [sourceLabel] */
export function formatActivity(event, mode, sourceLabel) {
  if (event.kind === 'gap') return terminalText('[Activity gap] ' + event.droppedCount + ' notices dropped' +
    (event.attemptId ? ' attempt=' + event.attemptId : '') +
    (event.sequenceRange ? ' sequence=' + event.sequenceRange.first + '–' + event.sequenceRange.last : ''));
  const prefix = '[' + (sourceLabel??event.profileId + '/' + event.attemptId) + '] ';
  const details = mode === 'debug' ? ' (' + [event.providerId, event.nativeKind, event.nativeId, 'seq=' + event.sequence].filter(Boolean).join(' ') + ')' : '';
  let body;
  if (event.kind === 'reasoning' || event.kind === 'user_message' || event.kind === 'finding') {
    const text = nativeText(event);
    if (text === undefined) return;
    body = (event.kind === 'reasoning' ? 'Thinking' : event.kind === 'finding' ? 'Reported finding' : 'Message') + details + ': ' + text;
  } else {
    const payload = object(event.payload), item = object(payload.item);
    if (event.kind === 'tool') {
      const title = string(payload.title) ?? string(item.type) ?? event.nativeKind ?? 'native tool';
      const status = string(payload.status) ?? string(item.status);
      const command = string(item.command) ?? string(payload.command);
      body = 'Tool ' + boundedText(title,240) + (status ? ' · ' + status : '') + (command ? ' · '+boundedText(command,240) : '') + details;
    } else if (event.kind === 'plan' && mode !== 'compact') {
      const entries = Array.isArray(payload.entries) ? payload.entries : item.items;
      if (!Array.isArray(entries)) return;
      body = 'Plan' + details + ':\n' + entries.map(entry => {
        const row = object(entry);
        return '- ' + (string(row.content) ?? string(row.text) ?? '') +
          (typeof row.status === 'string' ? ' [' + row.status + ']' : typeof row.completed === 'boolean' ? ' [' + (row.completed ? 'completed' : 'pending') + ']' : '');
      }).join('\n');
    }
  }
  return body === undefined ? undefined : terminalText(prefix + body);
}

/** Only native streamed text fragments, not repeated snapshots. @param {ActivityNotice} event @param {PresentationMode} mode @param {string} [sourceLabel] */
export function thinkingFragment(event,mode,sourceLabel) {
  if(event.kind!=='reasoning'||event.nativeKind!=='agent_thought_chunk')return;
  const text=nativeText(event);
  if(text===undefined)return;
  return {source:JSON.stringify([event.operationId,event.attemptId,event.nativeId??null]),
    header:'['+(sourceLabel??event.profileId+'/'+event.attemptId)+'] Thinking'+(mode==='debug'?' ('+event.providerId+')':'')+': ',text};
}

/** @type {Record<string,string>} */
const lifecycleLabels={
  'operation.accepted':'Operation accepted','attempt.dispatched':'Invocation dispatched',
  'attempt.outcome':'Outcome recorded','attempt.late_outcome':'Late outcome recorded','attempt.outcome_discrepancy':'Outcome discrepancy','attempt.historical_outcome_report':'Historical outcome report (classification not recorded)','attempt.cancel_requested':'Cancellation requested',
  'operation.cancelled':'Operation cancelled','action.cancelled':'Action cancelled','operation.waiting':'Operation waiting',
  'operation.finished':'Assessment recorded','operation.continued':'Request continued',
  'operation.recovered':'Operation recovered','controller.invalid_proposal':'Invalid model proposal',
  'action.rejected':'Action rejected','action.deferred':'Action deferred',
  'permission.requested':'Permission requested','permission.resolved':'Permission resolved',
  'permission.expired':'Permission expired','interaction.requested':'Interaction requested',
  'interaction.resolved':'Interaction resolved'
};
const lifecycle = new Set(['operation.accepted', 'attempt.dispatched', 'attempt.outcome',
  'attempt.cancel_requested', 'operation.cancelled', 'action.cancelled', 'operation.waiting', 'operation.finished',
  'operation.continued', 'operation.recovered', 'controller.invalid_proposal', 'action.rejected', 'action.deferred',
  'permission.requested', 'permission.resolved', 'permission.expired', 'interaction.requested', 'interaction.resolved']);

/** @param {DiagnosticEvent} event @param {PresentationMode} mode @param {ExecutionFact} [fact] */
export function formatExecution(event, mode, fact) {
  if (event.eventName === 'delivery.gap') return terminalText('[Execution gap] ' + event.details?.droppedCount + ' notices dropped');
  if (mode !== 'debug' && !lifecycle.has(event.eventName) && fact?.kind!=='attempt.outcome' && event.level !== 'error' && event.level !== 'warn') return;
  const identity = fact?.attemptId ? factLabel(fact) : event.attemptId ? (event.actionId === event.attemptId ? 'Controller' : 'Attempt') + ' ' + event.attemptId
    : event.actionId ? 'Action ' + event.actionId : 'Operation ' + (event.operationId ?? '');
  const extra = mode === 'debug' ? ' event=' + event.eventId + ' seq=' + event.sequence + ' at=' + event.receivedAt +
    (fact?.attemptId?' attempt='+fact.attemptId:'') : '';
  const title=mode==='debug'?event.eventName:lifecycleLabels[event.eventName]??event.eventName;
  const route=fact&&event.eventName==='attempt.dispatched'?
    (fact.modelSelector?' · selector='+boundedText(fact.modelSelector,160):'')+
    (fact.reasoning?.mode==='selectable'?' · effort='+boundedText(fact.reasoning.level,80):fact.reasoning?.mode==='native'?' · native effort':'')+
    (fact.objective?'\n  '+boundedText(fact.objective):''):'';
  const terminal=fact?.kind==='attempt.outcome'?
    ' · reported terminal='+fact.terminal+' · reported effect='+fact.effect+(fact.late?' · late report':''):
    fact?.kind==='controller.invalid_proposal'&&fact.invalidPath!==undefined?
      ' · '+boundedText(fact.invalidPath,240).replace(/[\n\t]/g,' ')+' expected '+boundedText(fact.expected??'',240).replace(/[\n\t]/g,' '):
    fact?.cancellation&&['attempt.cancel_requested','operation.cancelled','action.cancelled'].includes(fact.kind)?' · source='+fact.cancellation:
    fact?.kind==='operation.finished'&&fact.assessmentOverall?' · '+fact.assessmentOverall:
    fact?.kind==='operation.waiting'&&fact.waitingKind?' · '+fact.waitingKind:'';
  const reason=mode==='debug'||!['attempt.dispatched','attempt.outcome','operation.accepted','operation.finished','operation.continued'].includes(event.eventName)
    ?' · '+event.reasonCode:'';
  return terminalText('[' + identity + '] ' + title + terminal + reason + route + extra);
}

/** @param {Event} event @param {PresentationMode} mode */
export function formatRecordedFindings(event, mode) {
  return formatFindingRecords(eventFindings(event)??[],mode);
}
/** @param {readonly import('../core/finding.js').Finding[]} findings @param {PresentationMode} mode */
export function formatFindingRecords(findings,mode) {
  return findings.map(finding => ({
    id: finding.findingId,
    author: finding.author,
    text: terminalText('[Recorded finding ' + boundedText(finding.findingId,160).replace(/[\n\t]/g,' ') + ' · ' + boundedText(finding.author,120).replace(/[\n\t]/g,' ') + '] ' + boundedText(finding.claim) +
      ' — ' + boundedText(finding.subject,1024) +
      (finding.uncertainties.length ? '\nUncertainty: ' + boundedText(finding.uncertainties.join('; '),2048) : '') +
      (mode !== 'compact' && finding.supports.length ? '\nSupports: ' + boundedText(finding.supports.join(', '),2048) : '') +
      (finding.supersedes ? '\nSupersedes: ' + finding.supersedes : '')),
  }));
}

/** @param {Operation} state @param {PresentationMode} mode */
export function formatOperation(state, mode) {
  const terminal=state.status==='finished'?state.assessment?.overall??'finished':state.status;
  const controllers=state.attempts.filter(a=>a.actionId===a.attemptId).length;
  const workers=state.attempts.filter(a=>a.actionId!==a.attemptId);
  const unique=new Set(workers.map(a=>a.actionId)).size;
  const dispatched=state.attempts.filter(a=>a.dispatchedAt!==undefined).length;
  const charged=resourceSnapshot(state).charged;
  const findings=state.events.reduce((count,event)=>count+(eventFindings(event)?.length??0),0);
  const unknown=state.attempts.some(a=>a.outcome?.effect==='unknown'||a.outcome?.terminal==='unknown');
  const heading=terminal==='complete'?'✓ Operation complete':terminal==='cancelled'?'■ Operation cancelled':'◇ Operation '+terminal;
  const status=(state.cancellation?' · source='+state.cancellation:'')+
    (state.waiting?.kind==='technical'?' · '+state.waiting.reason.code:'');
  const count=controllers+' Controller attempt'+(controllers===1?'':'s')+' · '+workers.length+' Worker attempt'+(workers.length===1?'':'s')+
    (workers.length?' ('+unique+' distinct Action'+(unique===1?'':'s')+')':'')+' · '+findings+' recorded finding'+(findings===1?'':'s');
  const details=mode==='compact'?'':'\n  Operation '+state.operationId+
    ' · dispatch records '+dispatched+'/'+state.attempts.length+' · budget charged '+charged+'/'+state.limits.maxInvocations+
    '\n'+state.attempts.map(attempt=>'  '+(attempt.actionId===attempt.attemptId?'Controller':attempt.actionId)+
      ' '+attempt.attemptId+' · '+(attempt.route?.profileId??'route unknown')+
      ' · '+(attempt.outcome?.terminal??attempt.status)+' · dispatch='+attempt.dispatchCertainty+
      (attempt.outcome?' · effect='+attempt.outcome.effect:'')+(attempt.cancellation?' · cancellation='+attempt.cancellation:'')).join('\n');
  const unresolved=state.assessment?.unresolvedQuestions?.length??0;
  return terminalText(heading+status+'\n  '+count+(unknown?'\n  Unknown effects/outcomes remain.':'')+
    (unresolved?'\n  '+unresolved+' unresolved question'+(unresolved===1?'':'s')+'.':'')+details);
}

/** Same mapping for tool updates and permission/elicitation references. @param {string} attemptId @param {string} nativeId */
export function scopedNativeId(attemptId, nativeId) {
  return JSON.stringify([attemptId, nativeId]);
}

/** Map only actual standard native updates, never fabricate a lifecycle tool or thought.
 * @param {ActivityNotice} event @param {PresentationMode} mode @param {boolean} controller @returns {SessionUpdate | undefined}
 */
export function acpActivity(event, mode, controller) {
  if (event.kind === 'gap' || !event.payload || typeof event.payload !== 'object') return;
  const payload = object(event.payload);
  const update = /** @type {SessionUpdate} */ (event.payload);
  const _meta = { ...object(payload._meta), roleOrchestratorSource: {
    operationId:event.operationId,attemptId:event.attemptId,profileId:event.profileId,providerId:event.providerId,
    sequence:event.sequence, ...(event.actionId!==undefined&&{actionId:event.actionId}), ...(event.invocationKind!==undefined&&{invocationKind:event.invocationKind}), ...(event.nativeId !== undefined && {nativeId:event.nativeId}),
    ...(event.nativeKind !== undefined && {nativeKind:event.nativeKind}), source:event.source,
  } };
  if (event.kind === 'reasoning') {
    if (payload.sessionUpdate === 'agent_thought_chunk' && update.sessionUpdate === 'agent_thought_chunk') {
      return { ...update, _meta, ...(update.messageId == null ? {} : { messageId: scopedNativeId(event.attemptId, update.messageId) }) };
    }
    if (event.nativeKind === 'item.completed' && object(payload.item).type === 'reasoning') {
      const text = nativeText(event);
      if (text !== undefined) return { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text }, _meta,
        ...(event.nativeId !== undefined && {messageId:scopedNativeId(event.attemptId,event.nativeId)}) };
    }
  }
  if (event.kind === 'user_message' && payload.sessionUpdate === 'agent_message_chunk' && update.sessionUpdate === 'agent_message_chunk') {
    return { ...update, _meta, ...(update.messageId == null ? {} : { messageId: scopedNativeId(event.attemptId, update.messageId) }) };
  }
  if (event.kind === 'tool' && (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') &&
      typeof update.toolCallId === 'string') {
    return { ...update, _meta, toolCallId: scopedNativeId(event.attemptId, update.toolCallId) };
  }
  if (event.kind === 'plan' && mode !== 'compact' && controller && update.sessionUpdate === 'plan') return { ...update,_meta };
}

/** Standard ACP notices are presentation only, never session history.
 * @param {DiagnosticEvent} event @param {readonly import('../core/finding.js').Finding[]|undefined} findings @param {PresentationMode} mode @param {ExecutionFact} [fact]
 * @returns {SessionUpdate[]}
 */
export function acpExecutionNotices(event,findings,mode,fact) {
  /** @type {SessionUpdate[]} */
  const notices=[];
  const title=formatExecution(event,mode,fact);
  const source={operationId:event.operationId,attemptId:event.attemptId,actionId:event.actionId,eventId:event.eventId,sequence:event.sequence};
  if(title) notices.push({sessionUpdate:'notice',title,severity:event.level==='error'?'error':event.level==='warn'?'warning':'info',
    _meta:{roleOrchestratorSource:{...source,source:'execution',eventName:event.eventName,reasonCode:event.reasonCode}}});
  for(const finding of findings??[]) notices.push({sessionUpdate:'notice',severity:'info',
    title:'Recorded finding '+finding.findingId+' · '+finding.author,
    description:finding.claim+' — '+finding.subject+
      (finding.uncertainties.length?'\nUncertainty: '+boundedText(finding.uncertainties.join('; '),2048):'')+
      (mode!=='compact'&&finding.supports.length?'\nSupports: '+boundedText(finding.supports.join(', '),2048):'')+
      (finding.supersedes?'\nSupersedes: '+finding.supersedes:''),
    _meta:{roleOrchestratorSource:{...source,source:'recorded_finding',findingId:finding.findingId,author:finding.author}}});
  return notices;
}

/** @param {string} operationId @param {number} count @param {string} reason @param {string} [attemptId] @returns {SessionUpdate} */
export function acpDeliveryGap(operationId,count,reason,attemptId) {
  return {sessionUpdate:'notice',severity:'warning',title:'Presentation gap',description:count+' notices not delivered ('+reason+')',
    _meta:{roleOrchestratorSource:{source:'delivery',operationId,attemptId,droppedCount:count,reason}}};
}

/** Visible attribution and complete boundaries even for clients which merge chunks.
 * Source metadata is presentation provenance, never authority.
 * @param {string} text @param {Record<string,unknown>} source @param {string} [identity]
 * @returns {SessionUpdate}
 */
export function acpOwnMessage(text,source,identity){
  const safe=boundedText(text,16000).replace(/[\\\x60*_{}\[\]()<>#!|~]/g,'\\$&').replace(/\n/g,'\n  ');
  return {sessionUpdate:'agent_message_chunk',content:{type:'text',text:'\n\nRO · '+safe+'\n\n'},
    ...(identity!==undefined&&{messageId:'ro:'+JSON.stringify([source.operationId,source.source,identity])}),
    _meta:{roleOrchestratorSource:source}};
}

/** @param {string} operationId @param {string} requestId @param {boolean} continuing @param {ProgressDisplay} display @param {boolean} [historical] @returns {SessionUpdate} */
export function acpAccepted(operationId,requestId,continuing,display,historical=false){
  const title=continuing?'Request continued':'Operation accepted';
  const source={source:'request',operationId,requestId,eventName:continuing?'operation.continued':'operation.accepted',...(historical&&{recovered:true})};
  return display==='inline'?acpOwnMessage(title+' · '+operationId,source,requestId):
    {sessionUpdate:'notice',title,severity:'info',_meta:{roleOrchestratorSource:source}};
}

/** @param {DiagnosticEvent} event @param {readonly import('../core/finding.js').Finding[]|undefined} findings @param {PresentationMode} mode @param {ExecutionFact} [fact] @param {boolean} [historical] @returns {SessionUpdate[]} */
export function acpExecutionInline(event,findings,mode,fact,historical=false){
  /** @type {SessionUpdate[]} */
  const updates=[];
  const displayMode=mode==='debug'?'detailed':mode;
  const text=formatExecution(event,displayMode,fact);
  const source={operationId:event.operationId,attemptId:event.attemptId,actionId:event.actionId,
    eventId:fact?.journalEventId??event.eventId,eventName:event.eventName,reasonCode:event.reasonCode,...(historical&&{recovered:true})};
  if(text) updates.push(acpOwnMessage(text,{...source,source:fact?'journal':'execution'},source.eventId));
  for(const finding of formatFindingRecords(findings??[],displayMode)){
    updates.push(acpOwnMessage(finding.text,{...source,source:'recorded_finding',findingId:finding.id,author:finding.author},finding.id));
  }
  return updates;
}

/** @param {string} operationId @param {number} count @param {string} reason @param {ProgressDisplay} display @param {boolean} notices @param {string} [attemptId] @returns {SessionUpdate|undefined} */
export function acpProgressGap(operationId,count,reason,display,notices,attemptId){
  if(display==='notices')return notices?acpDeliveryGap(operationId,count,reason,attemptId):undefined;
  return acpOwnMessage('Presentation gap · '+count+' updates '+(reason==='overflow'?'dropped':'not confirmed')+' ('+reason+')',
    {source:'delivery',operationId,attemptId,droppedCount:count,reason});
}
