import { createCliTools } from './cli-tools.js';
import { formatActivity, formatExecution, formatOperation, formatFindingRecords, thinkingFragment, factLabel, boundedText, nativeText } from './presentation.js';
/** @import {ControlNotice} from './local-control.js' */
/** @import {Operation} from '../core/operation.js' */
/** @import {PresentationMode, PresentationTone} from './presentation.js' */

/** @param {PresentationMode | undefined} mode @param {(text:string,tone?:PresentationTone)=>Promise<unknown>} print @param {(fragment:{source:string,header:string,text:string,indent?:string})=>Promise<unknown>} [printChunk] @param {()=>void} [resetChunks] */
export function cliPresentation(mode, print, printChunk, resetChunks) {
  let closed=false;
  const tools=createCliTools();
  /** @type {Map<string,string>} */
  const aliases=new Map();
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
  return {
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
        if(aliases.size>=128&&!aliases.has(notice.fact.attemptId)){const first=aliases.keys().next().value;if(first!==undefined)aliases.delete(first);}
        aliases.set(notice.fact.attemptId,factLabel(notice.fact));
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
          if(line)await print(select(event.attemptId,alias)+indent(line.text),line.tone);
          return;
        }
        if(printChunk){
          const fragment=thinkingFragment(event,mode,alias);
          if(fragment){
            // Input owner also restarts the header after a prompt or a non-text boundary.
            const heading=select(event.attemptId,alias);
            const technical=mode==='debug'?' ['+boundedText(event.providerId,80)+' '+boundedText(event.nativeKind??'',80)+(event.nativeId?' id='+boundedText(event.nativeId,120):'')+']':'';
            await printChunk({...fragment,header:heading+'\n  Thinking · '+alias+technical+'\n',indent:'  '});
            return;
          }
        }
        if(event.kind==='reasoning'){
          const text=nativeText(event);
          if(text!==undefined){
            await print(select(event.attemptId,alias)+'\n  Thinking · '+alias+'\n'+indent(text),'thinking');
            return;
          }
        }
        const text=formatActivity(event,mode,alias);
        if(text){const prefix='['+alias+'] ';await print(select(event.attemptId,alias)+indent(text.startsWith(prefix)?text.slice(prefix.length):text),event.kind==='finding'?'finding':'neutral');}
        return;
      }
      if(notice.channel==='execution'&&notice.event.eventName==='attempt.dispatched'&&notice.fact?.attemptId){
        const fact=notice.fact,alias=factLabel(fact);
        currentSource=fact.attemptId;
        const route=[fact.modelSelector?'selector='+fact.modelSelector:undefined,
          fact.reasoning?.mode==='selectable'?'effort='+fact.reasoning.level:fact.reasoning?.mode==='native'?'native effort':undefined].filter(Boolean).join(' · ');
        const objective=fact.objective?'\n'+indent('Objective: '+boundedText(fact.objective)):'';
        const technical=mode==='debug'?'\n'+indent('attempt='+fact.attemptId+' event='+notice.event.eventId+' seq='+notice.event.sequence+' at='+notice.event.receivedAt+' reason='+notice.event.reasonCode):'';
        await print('\n'+(fact.invocationKind==='controller'?'● ':'├─ ')+alias+'\n'+indent('Invocation dispatched'+(route?' · '+boundedText(route,480):''))+objective+technical,'header');
      }else{
        const text=notice.channel==='execution'?formatExecution(notice.event,mode,notice.fact):
          notice.channel==='activity'?formatActivity(notice.event,mode):'[Delivery gap] '+notice.droppedCount+' notices dropped';
        if(text){
          const fact=notice.channel==='execution'?notice.fact:undefined;
          const event=notice.channel==='execution'?notice.event:undefined;
          if(mode==='compact'&&fact&&event?.eventName==='attempt.outcome'&&fact.attemptId){
            const alias=factLabel(fact);
            await print(select(fact.attemptId,alias)+indent('◇ Outcome reported · '+fact.terminal+' · effect='+fact.effect),
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
          await print('\n◆ '+finding.text,'finding');
        }
      }
    },
    /** @param {unknown} value @param {boolean} [defer] */
    finish(value,defer=false) {
      if(!mode||closed||!value||typeof value!=='object'||!('events' in value)||!('attempts' in value))return;
      const state=/** @type {Operation} */(value);
      const summary=formatOperation(state,mode);
      const text=Buffer.byteLength(summary)<=512*1024?summary:formatOperation(state,'compact')+'\n[Detailed snapshot omitted; inspect current operation]';
      closed=true;aliases.clear();tools.clear();currentSource=undefined;
      const tone=state.status==='finished'&&state.assessment?.overall==='complete'?'success':'neutral';
      const render=()=>{void print('\n'+text,tone).catch(()=>{});};
      if(defer)return render;
      render();
    },
    close(){closed=true;aliases.clear();tools.clear();currentSource=undefined;},
  };
}
