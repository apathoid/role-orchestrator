import { boundContextItem } from './context-bundle.js';
import { operationHistory } from './controller-context.js';
import { observation } from '../core/observation.js';

/** @import {Operation} from '../core/operation.js' */
/** @import {ContextFetch, ContextPort, ContextShare, StateStore} from '../core/ports.js' */
/** @import {Observation} from '../core/observation.js' */

/**
 * A hash names bytes in the store. Only a typed receipt in the source
 * operation identifies which bytes this invocation can actually retrieve.
 * @param {{
 *   state: Operation, store: StateStore, maxBytes: number, profileId: string, attemptId: string,
 *   selected?: ReadonlySet<string>, allowShare?: ContextShare, isActive: () => boolean,
 *   newId: () => string, now: () => number, receive: (item: Observation) => void
 * }} scope
 * @returns {ContextPort}
 */
export function bindContextAccess(scope) {
  const { state, store, maxBytes, profileId, attemptId, selected, isActive } = scope;
  /** @param {Extract<ContextFetch, {kind: 'unavailable'}>['reason']} reason @returns {ContextFetch} */
  const unavailable = reason => ({ kind: 'unavailable', reason });
  return {
    async fetch(ref, sourceOperationId = state.operationId) {
      if (!isActive()) return unavailable('closed');
      if (typeof ref !== 'string' || !ref.trim() || typeof sourceOperationId !== 'string' ||
          (selected && !selected.has(ref))) return unavailable('denied');
      const sharedRequest = sourceOperationId !== state.operationId;
      const allowed = () => !sharedRequest ||
        scope.allowShare?.({ sourceOperationId, targetOperationId: state.operationId, ref, profileId }) === true;
      let source = state;
      if (sharedRequest) {
        try {
          if (!allowed()) return unavailable('denied');
          const shared = await store.load(sourceOperationId);
          if (!isActive()) return unavailable('closed');
          if (!allowed()) return unavailable('denied');
          if (!shared || shared.operationId !== sourceOperationId) return unavailable('missing');
          source = shared;
        } catch {
          return unavailable(isActive() ? 'missing' : 'closed');
        }
      }
      const item = operationHistory(source).find(item => item.ref === ref);
      if (!item) return unavailable('missing');
      if (item.artifact) {
        try {
          if (item.artifact.size > maxBytes) {
            const presence = await store.artifactPresence?.(item.artifact);
            if (!isActive()) return unavailable('closed');
            if (!allowed()) return unavailable('denied');
            return unavailable(presence === 'retention' ? 'retention' : 'budget');
          }
          const result = await store.readArtifact?.(item.artifact, item.artifact.size);
          if (!isActive()) return unavailable('closed');
          if (!allowed()) return unavailable('denied');
          if (result?.kind !== 'available') {
            if (result?.kind === 'integrity_error') return unavailable('integrity_error');
            return unavailable(result?.reason ?? 'payload');
          }
          if (result.bytes.byteLength !== item.artifact.size) return unavailable('integrity_error');
          return { kind: 'available', item: structuredClone(item), bytes: result.bytes };
        } catch {
          return unavailable(isActive() ? 'payload' : 'closed');
        }
      }
      if (item.completeness === 'unavailable') return unavailable('payload');
      const bounded = boundContextItem(item, maxBytes, maxBytes);
      return bounded ? { kind: 'available', item: structuredClone(bounded) } : unavailable('budget');
    },

    async captureArtifact(bytes) {
      if (!isActive() || !(bytes instanceof Uint8Array) || !store.writeArtifact) return undefined;
      try {
        const artifact = await store.writeArtifact(bytes, Math.min(maxBytes, bytes.byteLength));
        if (!isActive()) return undefined;
        const ref = 'artifact:' + scope.newId();
        scope.receive(observation({ ref, artifact, completeness: artifact.truncated ? 'truncated' : 'complete' },
          { kind: 'provider_report', sourceId: attemptId, receivedAt: scope.now() }));
        return ref;
      } catch {
        return undefined;
      }
    },
  };
}
