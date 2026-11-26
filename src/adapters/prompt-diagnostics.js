import { createHash } from 'node:crypto';
import { emitDiagnostic } from '../core/diagnostics.js';

/** @import {Invocation} from '../core/ports.js' */
/** @import {DiagnosticPort, Clock, IdFactory} from '../core/diagnostics.js' */
/** @typedef {Record<string,string|number|boolean|null>} Details */
/** @typedef {(invocation:Invocation, phase:string, details:Details, prompt?:string)=>void} PromptReporter */

// The raw source cap is independent of provider and history budgets.
const defaultCaptureBytes = 16 * 1024;
const maximumCaptureBytes = 1024 * 1024;
/** @param {{diagnostics:DiagnosticPort, privateDiagnostics?:DiagnosticPort, clock:Clock, ids:IdFactory, captureBodies?:boolean, promptCaptureMaxBytes?:number}} options @returns {PromptReporter} */
export function createPromptReporter({diagnostics, privateDiagnostics, clock, ids, captureBodies, promptCaptureMaxBytes=defaultCaptureBytes}) {
  const captureLimit=Math.min(maximumCaptureBytes,Math.max(1,promptCaptureMaxBytes));
  let sequence = 0;
  return (invocation, phase, details, prompt) => {
    try {
      if (invocation.kind !== 'controller') return;
      const identity = { schemaVersion: /** @type {const} */ (1), receivedAt: clock.now(),
        level: /** @type {const} */ ('info'), component:'adapter', operationId:invocation.operationId,
        attemptId:invocation.attemptId, reasonCode:'OBSERVED' };
      const measured = { ...details, profileId:invocation.profile.profileId,
        providerId:invocation.profile.providerId,
        ...(prompt===undefined?{}:{serializedPromptBytes:Buffer.byteLength(prompt,'utf8'),
          promptSha256:createHash('sha256').update(prompt,'utf8').digest('hex')}) };
      emitDiagnostic(diagnostics, {...identity,eventName:'adapter.prompt.'+phase,eventId:ids.newId(),
        sequence:++sequence,details:measured});
      if (prompt === undefined || !captureBodies || !privateDiagnostics) return;
      // A partial final line may contain half a credential. Retain only
      // completed lines, and conservatively omit lines containing a known sensitive key name.
      // UTF-8 prefix boundary; do not retain a partial JSON line or a
      // partial credential at the truncation boundary. Search only up to
      // the configured number of code units (UTF-8 is never smaller).
      let end=prompt.length;
      if (Number(measured.serializedPromptBytes)>captureLimit) {
        const bytes=Buffer.from(prompt.slice(0,captureLimit),'utf8');
        const prefix=bytes.subarray(0,captureLimit);
        const newline=prefix.lastIndexOf(10);
        end=newline<0?0:prefix.subarray(0,newline+1).toString('utf8').length;
      }
      const sample = prompt.slice(0,end);
      const body = sample.split('\n').map(line =>
        /(?:password|secret|credential|token|api[_-]?key|authorization|cookie|private[_-]?key)/i.test(line)
          ? '[LINE OMITTED: SENSITIVE FIELD]' : line).join('\n');
      emitDiagnostic(privateDiagnostics,{...identity,eventName:'adapter.prompt.capture',eventId:ids.newId(),
        sequence:++sequence,details:{...measured,prompt:body,captureSourceBytes:Buffer.byteLength(sample),
          captureCompleteness:end===0?'unavailable':end===prompt.length?'complete_before_redaction':'partial',
          ...(end===0&&{captureUnavailableReason:'no_complete_line_within_limit'}),
          representation:'redacted_text', captureLimitBytes:captureLimit, captureStartBytes:0,
          captureEndBytes:Buffer.byteLength(sample)}});
    } catch { /* Diagnostics never affect dispatch. */ }
  };
}

/** @param {PromptReporter|undefined} report @param {Invocation} invocation @param {string} phase @param {Details} details @param {string} [prompt] */
export function reportPrompt(report,invocation,phase,details,prompt) {
  try { report?.(invocation,phase,details,prompt); } catch { /* Optional observer. */ }
}
