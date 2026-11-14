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
      // Terminal snapshot is a single bounded display write; inspect remains
      // authoritative if a slow consumer missed too many recorded findings.
      const maximum = 1024 * 1024;
      const summary = formatOperation(state,mode);
      const parts = [Buffer.byteLength(summary) <= maximum / 2 ? summary : formatOperation(state,'compact') + '\n[Detailed snapshot omitted; inspect current operation]'];
      let bytes = Buffer.byteLength(parts[0]), omitted = 0;
      for (const event of state.events) for (const finding of formatRecordedFindings(event,mode)) {
        if (seen.has(finding.id)) continue;
        seen.add(finding.id);
        const size = Buffer.byteLength(finding.text) + 1;
        if (parts.length >= 127 || bytes + size > maximum - 256) { omitted++; continue; }
        parts.push(finding.text); bytes += size;
      }
      if (omitted) parts.push('[Recorded snapshot] ' + omitted + ' findings omitted; inspect current operation');
      closed = true;
      void print(parts.join('\n'));
    },
    close() { closed = true; },
  };
}
