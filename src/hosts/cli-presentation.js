import { formatActivity, formatExecution, formatOperation, formatRecordedFindings } from './presentation.js';
/** @import {ControlNotice} from './local-control.js' */
/** @import {Operation} from '../core/operation.js' */
/** @import {PresentationMode} from './presentation.js' */

/** @param {PresentationMode | undefined} mode @param {(text:string)=>Promise<unknown>} print */
export function cliPresentation(mode, print) {
  const seen = new Set();
  let closed = false;
  /** @param {Operation} state @param {string} [eventId] */
  async function findings(state,eventId) {
    if (!mode || closed) return;
    for (const event of state.events) {
      if (eventId && event.eventId !== eventId) continue;
      for (const finding of formatRecordedFindings(event,mode)) {
        if (!seen.has(finding.id)) { seen.add(finding.id); await print(finding.text); }
      }
    }
  }
  return {
    /** @param {ControlNotice} notice @param {(id:string)=>Promise<Operation>} [inspect] */
    async notice(notice,inspect) {
      if (!mode || closed) return;
      const text = notice.channel === 'activity' ? formatActivity(notice.event,mode)
        : notice.channel === 'execution' ? formatExecution(notice.event,mode) : '[Delivery gap] ' + notice.droppedCount + ' notices dropped';
      if (text) await print(text);
      if (notice.channel === 'execution' && inspect && notice.event.operationId &&
          ['attempt.outcome','controller.responded'].includes(notice.event.eventName)) {
        await findings(await inspect(notice.event.operationId),notice.event.eventId);
      }
    },
    /** @param {unknown} value */
    finish(value) {
      if (!mode || closed || !value || typeof value !== 'object' || !('events' in value) || !('attempts' in value)) return;
      const state = /** @type {Operation} */ (value);
      // Current authoritative snapshot, not reconstructed lost activity.
      for (const event of state.events) for (const finding of formatRecordedFindings(event,mode)) {
        if (!seen.has(finding.id)) { seen.add(finding.id); void print(finding.text); }
      }
      void print(formatOperation(state,mode));
      closed = true;
    },
    close() { closed = true; },
  };
}
