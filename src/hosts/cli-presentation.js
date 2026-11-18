import { createCliTools } from './cli-tools.js';
import { sourceTone } from './cli-styling.js';
import { formatActivity, formatExecution, formatOperation, formatFindingRecords, thinkingFragment, factLabel, boundedText, nativeText } from './presentation.js';

/** The existing broker reports only attempt/operation scope, not the native
 * requestId. Never label an outcome as belonging to a particular #N question.
 * These reasons report a broker transition, not provider-side acceptance.
 * @param {import('../core/diagnostics.js').DiagnosticEvent} event
 * @returns {{message:string,alert:boolean}|undefined} */
export function cliRequestOutcome(event){
  /** @type {Record<string,string>} */
  const interaction={
    INTERACTION_ANSWERED:'Question response recorded by broker (provider ACK not confirmed)',
    INTERACTION_CANCELLED:'Question cancelled',
    INTERACTION_TIMED_OUT:'Question timed out',
    INTERACTION_UNAVAILABLE:'Question unavailable',
    INTERACTION_INVALID:'Question invalid',
    INTERACTION_ERROR:'Question error reported',
  };
  /** @type {Record<string,string>} */
  const permission={
    ALLOW:'Permission selection recorded · allow option (provider ACK not confirmed)',
    DENY:'Permission selection recorded · deny option (provider ACK not confirmed)',
    STANDING_ALLOW:'Standing permission selection · allow option',
    STANDING_DENY:'Standing permission decision · deny',
    DENIED:'Permission denied',
    UNAVAILABLE:'Permission unavailable',
    PERMISSION_UNAVAILABLE:'Permission unavailable',
    INVALID:'Permission invalid',
    CANCELLED:'Permission request cancelled',
  };
  if(event.eventName==='interaction.resolved'){
    const message=Object.hasOwn(interaction,event.reasonCode)?interaction[event.reasonCode]:
      'Question outcome reported (details in debug)';
    return {message,alert:!['INTERACTION_ANSWERED'].includes(event.reasonCode)};
  }
  if(event.eventName==='permission.resolved'||event.eventName==='permission.expired'){
    const message=Object.hasOwn(permission,event.reasonCode)?permission[event.reasonCode]:
      'Permission outcome reported (details in debug)';
    return {message,alert:!['ALLOW','DENY','STANDING_ALLOW','STANDING_DENY'].includes(event.reasonCode)};
  }
}

/** @import {ControlNotice} from './local-control.js' */
/** @import {Operation} from '../core/operation.js' */
/** @import {PresentationMode, PresentationTone} from './presentation.js' */

/** @param {PresentationMode | undefined} mode @param {(text:string|readonly {text:string,tone?:PresentationTone}[],tone?:PresentationTone)=>Promise<unknown>} print @param {(fragment:{source:string,header:string,text:string,indent?:string,headerTone?:PresentationTone,sourceHeaderLength?:number})=>Promise<unknown>} [printChunk] @param {()=>void} [resetChunks] */
export function cliPresentation(mode, print, printChunk, resetChunks) {
  let closed=false;
  const tools=createCliTools();
  /** @type {Map<string,string>} */
  const aliases=new Map();
  /** Stable coloring is derived only from trusted execution facts. */
  /** @type {Map<string,PresentationTone>} */
  const tones=new Map();
  /** @type {string|undefined} */
  let acceptedId;
  /** @type {string|undefined} */
  let currentSource;
  /** @param {string} id @param {string} label */
  function select(id,label){
    if(currentSource===id)return '';
    currentSource=id;return '\n'+label+'\n';
  }
  /** @param {string} text @param {number} [count] */
  const indent=(text,count=2)=>text.split('\n').map(line=>' '.repeat(count)+line).join('\n');
  /** @param {string} id @param {string} alias @param {string|readonly {text:string,tone?:PresentationTone}[]} message @param {PresentationTone} [tone] */
  function sourcePrint(id,alias,message,tone='neutral'){
    const heading=select(id,alias);
    return print([...(heading?[{text:heading,tone:tones.get(id)??'neutral'}]:[]),
      ...(typeof message==='string'?[{text:message,tone}]:message)]);
  }
  return {
    /** Trusted attempt identity established from execution facts, never guessed. */
    sourceFor: (/** @type {string} */ attemptId)=>aliases.get(attemptId),
    /** @param {string} attemptId */
    toneFor: attemptId=>tones.get(attemptId),
    /** @param {string} id */
    accepted(id) {
      if(!mode||closed||acceptedId===id)return;
      acceptedId=id;currentSource=undefined;
      void print('Role Orchestrator · '+mode+' · '+(mode==='debug'?'Operation '+id:id.slice(0,8)),'header').catch(()=>{});
    },
    /** @param {ControlNotice} notice */
    async notice(notice) {
      if(!mode||closed)return;
      if(notice.channel==='execution'&&notice.fact?.attemptId){
        if(aliases.size>=128&&!aliases.has(notice.fact.attemptId)){
          const first=aliases.keys().next().value;
          if(first!==undefined){aliases.delete(first);tones.delete(first);}
        }
        aliases.set(notice.fact.attemptId,factLabel(notice.fact));
        tones.set(notice.fact.attemptId,sourceTone(notice.fact));
      }
      if(notice.channel==='gap'||(notice.channel==='activity'&&notice.event.kind==='gap')||(notice.channel==='execution'&&notice.event.eventName==='delivery.gap')){
        tools.clear();currentSource=undefined;resetChunks?.();
      }
      if(notice.channel==='execution'&&notice.event.eventName==='operation.cancelled')tools.clear();
      if(notice.channel==='activity'&&notice.event.kind!=='gap'){
        const event=notice.event;
        const alias=aliases.get(event.attemptId)??boundedText(event.profileId+'/'+event.attemptId,240).replace(/[\n\t]/g,' ');
        if(event.kind==='tool'){
          const line=tools.accept(event,mode);
          if(line)await sourcePrint(event.attemptId,alias,indent(line.text),line.tone);
          return;
        }
        if(printChunk){
          const fragment=thinkingFragment(event,mode,alias);
          if(fragment){
            // Input owner also restarts the header after a prompt or a non-text boundary.
            const heading=select(event.attemptId,alias);
            const technical=mode==='debug'?' ['+boundedText(event.providerId,80)+' '+boundedText(event.nativeKind??'',80)+(event.nativeId?' id='+boundedText(event.nativeId,120):'')+']':'';
            await printChunk({...fragment,header:heading+'\n  Thinking · '+alias+technical+'\n',
              sourceHeaderLength:heading.length,headerTone:tones.get(event.attemptId)??'muted',indent:'  '});
            return;
          }
        }
        if(event.kind==='reasoning'){
          const text=nativeText(event);
          if(text!==undefined){
            await sourcePrint(event.attemptId,alias,'\n  Thinking · '+alias+'\n'+indent(text),'thinking');
            return;
          }
        }
        const text=formatActivity(event,mode,alias);
        if(text){
          const prefix='['+alias+'] ',body=indent(text.startsWith(prefix)?text.slice(prefix.length):text);
          await sourcePrint(event.attemptId,alias,event.kind==='finding'
            ?[{text:'  ◆ ',tone:'accent'},{text:body.slice(2),tone:'neutral'}]:body);
        }
        return;
      }
      const resolution=notice.channel==='execution'&&mode!=='debug'?cliRequestOutcome(notice.event):undefined;
      if(notice.channel==='execution'&&resolution){
        // A source can be trusted at attempt scope, but not tied to a specific
        // pending form/permission alias: the event carries no native requestId.
        const identity=notice.fact?.attemptId?factLabel(notice.fact):
          notice.event.attemptId?(aliases.get(notice.event.attemptId) ??
            'Attempt '+boundedText(notice.event.attemptId,80)):'Unattributed request';
        currentSource=undefined;
        /** @type {{text:string,tone?:PresentationTone}[]} */
        const segments=[
          {text:'\n'+(resolution.alert?'! ':'? '),tone:resolution.alert?'error':'accent'},
          {text:identity+' · ',tone:'muted'},
          {text:resolution.message,tone:'neutral'},
        ];
        if(mode==='detailed')segments.push({text:' · request ID not in execution event',tone:'muted'});
        await print(segments);
      }else if(notice.channel==='execution'&&notice.event.eventName==='attempt.dispatched'&&notice.fact?.attemptId){
        const fact=notice.fact,alias=factLabel(fact);
        currentSource=fact.attemptId;
        const route=[fact.modelSelector?'selector='+fact.modelSelector:undefined,
          fact.reasoning?.mode==='selectable'?'effort='+fact.reasoning.level:fact.reasoning?.mode==='native'?'native effort':undefined].filter(Boolean).join(' · ');
        const objective=fact.objective?'\n'+indent('Objective: '+boundedText(fact.objective)):'';
        const technical=mode==='debug'?'\n'+indent('attempt='+fact.attemptId+' event='+notice.event.eventId+' seq='+notice.event.sequence+' at='+notice.event.receivedAt+' reason='+notice.event.reasonCode):'';
        /** @type {{text:string,tone?:PresentationTone}[]} */
        const dispatchSegments=[
          {text:'\n'+(fact.invocationKind==='controller'?'● ':'├─ ')+alias,tone:sourceTone(fact)},
          {text:'\n'+indent('Invocation dispatched'+(route?' · '+boundedText(route,480):'')),tone:'muted'},
        ];
        if(objective)dispatchSegments.push({text:objective,tone:'neutral'});
        if(technical)dispatchSegments.push({text:technical,tone:'muted'});
        await print(dispatchSegments);
      }else{
        // These are technical lifecycle records already represented by native
        // input or the authoritative answer/summary; keep raw names in debug.
        const hidden=mode!=='debug'&&notice.channel==='execution'&&
          ['operation.accepted','operation.finished','interaction.requested','permission.requested'].includes(notice.event.eventName);
        let text=hidden?undefined:notice.channel==='execution'?formatExecution(notice.event,mode,notice.fact):
          notice.channel==='activity'?formatActivity(notice.event,mode):'[Delivery gap] '+notice.droppedCount+' notices dropped';
        if(text&&notice.channel==='execution'&&mode==='compact'&&notice.event.attemptId){
          const event=notice.event,known=aliases.get(event.attemptId??'');
          if(known){
            const full='['+(event.actionId===event.attemptId?'Controller':'Attempt')+' '+event.attemptId+'] ';
            if(text.startsWith(full))text='['+known+'] '+text.slice(full.length);
          }
          if(['interaction.requested','permission.requested'].includes(event.eventName)&&
            event.reasonCode==='AWAITING_TRUSTED_REPLY'){
            text=text.replace(/ · AWAITING_TRUSTED_REPLY$/, '');
          }
        }
        if(text){
          const fact=notice.channel==='execution'?notice.fact:undefined;
          const event=notice.channel==='execution'?notice.event:undefined;
          if(mode==='compact'&&fact&&event?.eventName==='attempt.outcome'&&fact.attemptId){
            const alias=factLabel(fact);
            await sourcePrint(fact.attemptId,alias,indent('◇ Outcome reported · '+fact.terminal+' · effect='+fact.effect),
              fact.terminal==='failed'||fact.terminal==='unknown'?'error':'neutral');
          }else if(mode==='compact'&&fact?.kind==='operation.finished'){
            currentSource=undefined;
            await print('\n◇ Assessment recorded · '+(fact.assessmentOverall??'status unknown'),'neutral');
          }else{
            currentSource=undefined;
            await print('\n'+text,notice.channel==='execution'&&(notice.event.level==='error'||notice.event.level==='warn')?'error':notice.channel==='execution'?'neutral':'error');
          }
        }
      }
      if(notice.channel==='execution'&&notice.findings&&!closed){
        for(const finding of formatFindingRecords(notice.findings,mode)){
          if(closed)break;
          currentSource=undefined;
          await print([{text:'\n◆ ',tone:'accent'},{text:finding.text,tone:'neutral'}]);
        }
      }
    },
    /** @param {unknown} value @param {boolean} [defer] */
    finish(value,defer=false) {
      if(!mode||closed||!value||typeof value!=='object'||!('events' in value)||!('attempts' in value))return;
      const state=/** @type {Operation} */(value);
      const summary=formatOperation(state,mode);
      const text=Buffer.byteLength(summary)<=512*1024?summary:formatOperation(state,'compact')+'\n[Detailed snapshot omitted; inspect current operation]';
      closed=true;aliases.clear();tones.clear();tools.clear();currentSource=undefined;
      const tone=state.status==='finished'&&state.assessment?.overall==='complete'?'success':'neutral';
      const render=()=>{void print('\n'+text,tone).catch(()=>{});};
      if(defer)return render;
      render();
    },
    close(){closed=true;aliases.clear();tones.clear();tools.clear();currentSource=undefined;},
  };
}
