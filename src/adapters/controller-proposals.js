import { decodeControllerIntent } from '../core/controller-intent.js';

/**
 * Technical, invocation-local proposal registry. No Action is admitted here.
 * Requests are registered synchronously at the trusted MCP call boundary,
 * then classified in that order (not completion/HTTP response order).
 */

const maxPendingIntentBytes = 8 * 1024 * 1024;

/** @param {{signal: AbortSignal, isActive?: () => boolean, attemptId: string}} scope */
export function createPendingControllerDecisions({ signal, isActive, attemptId }) {
  let open = true;
  let sequence = 0;
  let bytes = 0;
  /** @type {Map<string, {root:string}>} */
  const known = new Map();
  /** @type {{ref:string,root:string,value:unknown} | undefined} */
  let selected;
  /** @type {{code:'INVALID_PROPOSAL',path:string,expected:string} | undefined} */
  let invalidReason;
  let conflicted = false;
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
    /** @param {{code:'INVALID_PROPOSAL',path:string,expected:string}} reason */
    const rejected = reason => {
      invalidReason = reason;
      return { kind:'rejected', proposalRef:ref, reason };
    };
    if (signal.aborted || isActive?.() === false) return { kind:'unavailable', reason:'closed' };
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return rejected(error('$', 'submit_decision arguments object'));
    }
    const args = /** @type {Record<string,unknown>} */ (input);
    for (const key of Object.keys(args)) {
      if (key !== 'intent' && key !== 'replaces') return rejected(error('$.' + key, 'intent or replaces'));
    }
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
    const parsed = decodeControllerIntent(args.intent);
    if (parsed.kind === 'rejected') {
      if (args.replaces !== undefined && selected?.root === root) selected = undefined;
      conflicted = false;
      return rejected(parsed.reason);
    }
    if (args.replaces === undefined && selected) {
      conflicted = true;
      return rejected(error('$.replaces', 'an explicit proposalRef to resolve unrelated submissions'));
    }
    // Same-lineage explicit replacements use registration order; a correction
    // to either side of a conflict may select a new unique candidate.
    selected = {ref, root, value:parsed.value};
    invalidReason = undefined;
    conflicted = false;
    return {kind:'proposal_pending', proposalRef:ref,
      note:'Structurally received; no Action is admitted before native turn completion.'};
  }

  /**
   * Call immediately after a complete, attributable MCP tools/call is read.
   * @param {unknown} input
   * @returns {Promise<unknown>}
   */
  function register(input) {
    if (!live()) return Promise.resolve({kind:'unavailable',reason:'closed'});
    const ref = 'proposal:' + attemptId + ':' + (++sequence);
    const size = Buffer.byteLength(JSON.stringify(input) ?? '', 'utf8');
    if (bytes + size > maxPendingIntentBytes) {
      // Budget is a technical failure; do not silently admit a stale candidate.
      selected = undefined;
      conflicted = false;
      invalidReason = error('$', 'submission within invocation control-byte budget');
      return Promise.resolve({kind:'unavailable',reason:'budget',maxBytes:maxPendingIntentBytes});
    }
    bytes += size;
    const result = processing.then(() => classify(ref,input));
    processing = result.then(() => {}, () => {});
    return result;
  }

  async function finalize() {
    open = false;
    // The finality barrier accounts for all registrations before the cut,
    // including validations whose microtasks have not run yet.
    await processing;
    if (signal.aborted || isActive?.() === false) return {kind: /** @type {const} */ ('unavailable'), reason:'closed'};
    if (conflicted) return {kind: /** @type {const} */ ('conflict')};
    if (selected) return {kind: /** @type {const} */ ('intent'), value:selected.value, proposalRef:selected.ref};
    if (invalidReason) return {kind: /** @type {const} */ ('invalid'), reason:invalidReason};
    return {kind: /** @type {const} */ ('missing')};
  }

  return {register, finalize, close() { open = false; }};
}
