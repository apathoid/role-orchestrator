import { formatActivity, formatExecution, formatOperation, formatFindingRecords, thinkingFragment } from './presentation.js';
/** @import {ControlNotice} from './local-control.js' */
/** @import {Operation} from '../core/operation.js' */
/** @import {PresentationMode} from './presentation.js' */

/** @param {PresentationMode | undefined} mode @param {(text:string)=>Promise<unknown>} print @param {(fragment:{source:string,header:string,text:string})=>Promise<unknown>} [printChunk] */
export function cliPresentation(mode, print, printChunk) {
  let closed = false;
  return {
    /** @param {ControlNotice} notice */
    async notice(notice) {
      if (!mode || closed) return;
      if(notice.channel==='activity'&&printChunk){
        const fragment=thinkingFragment(notice.event,mode);
        if(fragment){await printChunk(fragment);return;}
      }
      const text = notice.channel === 'activity' ? formatActivity(notice.event,mode)
        : notice.channel === 'execution' ? formatExecution(notice.event,mode) : '[Delivery gap] ' + notice.droppedCount + ' notices dropped';
      if (text) await print(text);
      if(notice.channel==='execution'&&notice.findings&&!closed) {
        for(const finding of formatFindingRecords(notice.findings,mode)){
          if(closed)break;
          await print(finding.text);
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
      void print(text);
    },
    close() { closed = true; },
  };
}
