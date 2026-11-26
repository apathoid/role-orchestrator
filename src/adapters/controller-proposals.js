import { decodeControllerIntent } from '../core/controller-intent.js';
import { boundedFieldError } from '../core/decode.js';
/** @import {FieldError} from '../core/decode.js' */

/**
 * Technical, invocation-local proposal registry. No Action is admitted here.
 * Requests are registered synchronously at the trusted MCP call boundary,
 * then classified in that order (not completion/HTTP response order).
 */

const maxPendingIntentBytes = 8 * 1024 * 1024;

/** @param {{signal: AbortSignal, isActive?: () => boolean, attemptId: string, preflight?: import('../core/ports.js').ControllerPreflight}} scope */
export function createPendingControllerDecisions({ signal, isActive, attemptId, preflight }) {
  let open = true;
  let sequence = 0;
  let bytes = 0;
  /** @type {Map<string, {root:string}>} */
  const known = new Map();
  /** @type {{ref:string,root:string,value:unknown} | undefined} */
  let selected;
  /** @type {FieldError | undefined} */
  let invalidReason;
  let conflicted = false;
  /** @type {'budget' | undefined} */
  let fatal;
  /** @type {{root: string, reason: 'request_id_conflict' | 'serialization_failed'} | undefined} */
  let unresolvedTransport;
  let processing = Promise.resolve();

  const live = () => open && !signal.aborted && isActive?.() !== false;
  /** @param {string} path @param {string} expected */
  const error = (path, expected) => ({ code: /** @type {const} */ ('INVALID_PROPOSAL'),
    path: path.slice(0, 512), expected: expected.slice(0, 512) });

  /**
   * An observed invalid replacement invalidates only its proven lineage,
   * never an unrelated valid candidate. An unrelated valid submission creates
   * a recoverable conflict until an explicit known-lineage replacement.
   * @param {string} ref @param {unknown} input
   */
  function classify(ref, input) {
    /** @param {FieldError} reason */
    const rejected = reason => {
      invalidReason = boundedFieldError(reason);
      return { kind:'rejected', proposalRef:ref, registered:known.has(ref), reason:invalidReason };
    };
    if (signal.aborted || isActive?.() === false) return { kind:'unavailable', reason:'closed' };
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return rejected(error('$', 'submit_decision arguments object'));
    }
    const args = /** @type {Record<string,unknown>} */ (input);
    let root = ref;
    if (args.replaces !== undefined) {
      if (typeof args.replaces !== 'string' || !args.replaces.trim()) {
        return rejected(error('$.replaces', 'a known proposalRef string in this invocation'));
      }
      const source = known.get(args.replaces);
      if (!source) return rejected(error('$.replaces', 'a known proposalRef in this invocation'));
      root = source.root;
    }
    known.set(ref, {root});
    for (const key of Object.keys(args)) {
      if (key !== 'intent' && key !== 'replaces') {
        if (args.replaces !== undefined && selected?.root === root) {
          selected = undefined;
          conflicted = false;
        }
        return rejected(error('$.' + key, 'intent or replaces'));
      }
    }
    const parsed = decodeControllerIntent(args.intent);
    if (parsed.kind === 'rejected') {
      if (args.replaces !== undefined && selected?.root === root) {
        selected = undefined;
        conflicted = false;
      }
      return rejected(parsed.reason);
    }
    if (selected && (args.replaces === undefined || selected.root !== root)) {
      conflicted = true;
      return {...rejected(error('$.replaces', 'a proposalRef from the currently selected lineage')), selectedProposalRef:selected.ref};
    }
    // Same-lineage explicit replacements use registration order; a correction
    // to either side of a conflict may select a new unique candidate.
    selected = {ref, root, value:parsed.value};
    if (unresolvedTransport?.root === root) unresolvedTransport = undefined;
    invalidReason = undefined;
    conflicted = false;
    // The candidate is already registered. Preflight is optional advisory
    // feedback, never a second admission, a veto or a delivery prerequisite.
    let feedback;
    try { feedback = preflight?.(parsed.value); }
    catch { feedback = {kind:'unchecked',reason:'unavailable',advisory:true}; }
    return {kind:'proposal_pending', proposalRef:ref, registered:true,
      note:'Structurally received; no Action is admitted before native turn completion.',
      ...(feedback && {preflight:feedback})};
  }

  /**
   * Call immediately after a complete, attributable MCP tools/call is read.
   * @param {unknown} input
   * @returns {Promise<unknown>}
   */
  function register(input) {
    if (!live()) return Promise.resolve({kind:'unavailable',reason:'closed'});
    let size;
    try { size = Buffer.byteLength(JSON.stringify(input) ?? '', 'utf8'); }
    catch {
      // A second serialization at the registry's existing byte accounting
      // boundary can also fail. Keep the same ordered transport observation.
      observeRejectedReplacement(input,'serialization_failed');
      return Promise.resolve({kind:'unavailable',reason:'serialization_failed'});
    }
    const ref = 'proposal:' + attemptId + ':' + (++sequence);
    if (bytes + size > maxPendingIntentBytes) {
      // This is technical loss, never an invalid model Decision or permission
      // to resurrect a previous candidate as though the request was unseen.
      return Promise.resolve(exceedLimit());
    }
    bytes += size;
    const result = processing.then(() => classify(ref,input));
    processing = result.then(() => {}, () => {});
    return result;
  }

  /**
   * A complete attributable tools/call may fail before ordinary proposal
   * validation (reused JSON-RPC id or failed serialization). Account only
   * for a reliably known explicit replacement of the selected lineage.
   * @param {unknown} input
   * @param {'request_id_conflict' | 'serialization_failed'} [reason]
   */
  function observeRejectedReplacement(input, reason = 'request_id_conflict') {
    if (!live()) return;
    // Register this transport fact in the same trusted arrival-order queue
    // as successful submissions; do not invent a proposalRef for it.
    const observed = processing.then(() => {
      const args = input && typeof input === 'object' && !Array.isArray(input)
        ? /** @type {Record<string, unknown>} */ (input) : undefined;
      const source = typeof args?.replaces === 'string' && args.replaces.trim()
        ? known.get(args.replaces) : undefined;
      if (!source || selected?.root !== source.root) return;
      selected = undefined;
      unresolvedTransport = { root:source.root, reason };
    });
    processing = observed.then(() => {}, () => {});
  }

  function exceedLimit() {
    fatal = 'budget';
    return {kind:'unavailable',reason:'budget',maxBytes:maxPendingIntentBytes};
  }

  async function finalize() {
    open = false;
    // The finality barrier accounts for all registrations before the cut,
    // including validations whose microtasks have not run yet.
    await processing;
    if (signal.aborted || isActive?.() === false) return {kind: /** @type {const} */ ('unavailable'), reason:'closed'};
    if (fatal) return {kind: /** @type {const} */ ('unavailable'), reason:fatal};
    if (conflicted) return {kind: /** @type {const} */ ('conflict')};
    if (selected) return {kind: /** @type {const} */ ('intent'), value:selected.value, proposalRef:selected.ref};
    if (unresolvedTransport) return {kind: /** @type {const} */ ('unavailable'), reason:unresolvedTransport.reason};
    if (invalidReason) return {kind: /** @type {const} */ ('invalid'), reason:invalidReason};
    return {kind: /** @type {const} */ ('missing')};
  }

  return {register, finalize, observeRejectedReplacement, exceedLimit, close() { open = false; }};
}
