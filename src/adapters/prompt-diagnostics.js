import { createHash } from 'node:crypto';
import { emitDiagnostic } from '../core/diagnostics.js';

/** @import {Invocation} from '../core/ports.js' */
/** @import {DiagnosticPort, Clock, IdFactory} from '../core/diagnostics.js' */
/** @typedef {Record<string,string|number|boolean|null>} Details */
/** @typedef {(invocation:Invocation, phase:string, details:Details, prompt?:string)=>void} PromptReporter */

// At most 16 Ki code units (64 KiB UTF-8 before redaction). Never copy a
// large prompt into the diagnostic queue. The full raw hash is observational.
const maxCaptureUnits = 16 * 1024;
/** @param {{diagnostics:DiagnosticPort, privateDiagnostics?:DiagnosticPort, clock:Clock, ids:IdFactory, captureBodies?:boolean}} options @returns {PromptReporter} */
export function createPromptReporter({diagnostics, privateDiagnostics, clock, ids, captureBodies}) {
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
      // completed lines, and omit any line with a known sensitive JSON key.
      const end = prompt.length <= maxCaptureUnits ? prompt.length :
        Math.max(0, prompt.lastIndexOf('\n',maxCaptureUnits)+1);
      const sample = prompt.slice(0,end);
      const body = sample.split('\n').map(line =>
        /"(?:[^"\\]|\\.){0,120}(?:password|secret|credential|token|api[_-]?key|authorization|cookie|private[_-]?key)(?:[^"\\]|\\.){0,120}"\s*:/i.test(line)
          ? '[LINE OMITTED: SENSITIVE FIELD]' : line).join('\n');
      emitDiagnostic(privateDiagnostics,{...identity,eventName:'adapter.prompt.capture',eventId:ids.newId(),
        sequence:++sequence,details:{...measured,prompt:body,captureSourceBytes:Buffer.byteLength(sample),
          captureCompleteness:end===0?'unavailable':end===prompt.length?'complete_before_redaction':'partial',
          representation:'redacted_text', captureLimitUnits:maxCaptureUnits}});
    } catch { /* Diagnostics never affect dispatch. */ }
  };
}

/** @param {PromptReporter|undefined} report @param {Invocation} invocation @param {string} phase @param {Details} details @param {string} [prompt] */
export function reportPrompt(report,invocation,phase,details,prompt) {
  try { report?.(invocation,phase,details,prompt); } catch { /* Optional observer. */ }
}
