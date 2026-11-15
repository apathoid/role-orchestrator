import { createCliTools } from './cli-tools.js';
import { formatActivity, formatExecution, formatOperation, formatFindingRecords, thinkingFragment, factLabel } from './presentation.js';
/** @import {ControlNotice} from './local-control.js' */
/** @import {Operation} from '../core/operation.js' */
/** @import {PresentationMode, PresentationTone} from './presentation.js' */

/** @param {PresentationMode | undefined} mode @param {(text:string,tone?:PresentationTone)=>Promise<unknown>} print @param {(fragment:{source:string,header:string,text:string})=>Promise<unknown>} [printChunk] */
export function cliPresentation(mode, print, printChunk) {
  let closed = false;
  const tools=createCliTools();
  /** @type {Map<string,string>} */
  const aliases=new Map();
  /** @type {string|undefined} */
  let acceptedId;
  return {
    /** @param {string} id */
    accepted(id) {
      if(!mode||closed||acceptedId===id)return;
      acceptedId=id;void print('Role Orchestrator · '+mode+' · Operation '+id,'header').catch(()=>{});
    },
    /** @param {ControlNotice} notice */
    async notice(notice) {
      if (!mode || closed) return;
      if(notice.channel==='execution'&&notice.fact?.attemptId){
        if(aliases.size>=128&&!aliases.has(notice.fact.attemptId)){const first=aliases.keys().next().value;if(first!==undefined)aliases.delete(first);}
        aliases.set(notice.fact.attemptId,factLabel(notice.fact));
      }
      if(notice.channel==='gap'||(notice.channel==='activity'&&notice.event.kind==='gap')||(notice.channel==='execution'&&notice.event.eventName==='delivery.gap'))tools.clear();
      const alias=notice.channel==='activity'&&notice.event.kind!=='gap'?aliases.get(notice.event.attemptId):undefined;
      if(notice.channel==='activity'&&notice.event.kind==='tool'){
        const line=tools.accept(notice.event,mode);
        if(line)await print('['+(alias??notice.event.profileId+'/'+notice.event.attemptId)+'] '+line.text,line.tone);
        return;
      }
      if(notice.channel==='activity'&&printChunk){
        const fragment=thinkingFragment(notice.event,mode,alias);
        if(fragment){await printChunk(fragment);return;}
      }
      const text = notice.channel === 'activity' ? formatActivity(notice.event,mode,alias)
        : notice.channel === 'execution' ? formatExecution(notice.event,mode,notice.fact) : '[Delivery gap] ' + notice.droppedCount + ' notices dropped';
      if (text) await print(text,notice.channel==='activity'?(notice.event.kind==='tool'?'tool':notice.event.kind==='finding'?'finding':'neutral'):
        notice.channel==='execution'?(notice.event.level==='error'||notice.event.level==='warn'?'error':notice.event.eventName==='attempt.dispatched'?'header':'neutral'):'error');
      if(notice.channel==='execution'&&notice.findings&&!closed) {
        for(const finding of formatFindingRecords(notice.findings,mode)){
          if(closed)break;
          await print(finding.text,'finding');
        }
      }
    },
    /** @param {unknown} value */
    finish(value) {
      if (!mode || closed || !value || typeof value !== 'object' || !('events' in value) || !('attempts' in value)) return;
      const state = /** @type {Operation} */ (value);
      // The terminal view is current status, not a replay of omitted notices.
      // Recorded findings remain available via explicit inspect.
      const summary = formatOperation(state,mode);
      const text=Buffer.byteLength(summary)<=512*1024?summary:formatOperation(state,'compact')+'\n[Detailed snapshot omitted; inspect current operation]';
      closed = true;
      aliases.clear();tools.clear();
      void print(text,state.status==='finished'&&state.assessment?.overall==='complete'?'success':'neutral').catch(()=>{});
    },
    close() { closed = true; aliases.clear();tools.clear(); },
  };
}
