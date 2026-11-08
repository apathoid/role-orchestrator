/** @import {Outcome} from './contracts.js' */
import { arrayOf, count, decode, id, invalid, jsonValue, measurement, oneOf, optional, record } from './decode.js';

/** @type {import('./decode.js').Decoder<number>} */
const exitCode = (value, path) => typeof value === 'number' && Number.isSafeInteger(value)
  ? value : invalid(path, 'an integer exit code');
const completeness = oneOf('complete', 'truncated', 'unavailable');
const source = oneOf('user', 'host_observed', 'provider_reported', 'model_claim');
const sourceKind = oneOf('user', 'model', 'provider_tool', 'provider_report', 'host_transport');
const exit = record({ kind: oneOf('agent_exit', 'tool_exit'), code: exitCode });

/** @type {Record<ReturnType<typeof sourceKind>, ReturnType<typeof source>>} */
const sources = {
  user: 'user', model: 'model_claim', provider_tool: 'provider_reported',
  provider_report: 'provider_reported', host_transport: 'host_observed',
};

const provenance = record({
  kind: sourceKind, sourceId: id, receivedAt: measurement, exit: optional(exit),
});
const artifactFields = record({ ref: id, size: count, originalSize: count, truncated: (input, path) => typeof input === 'boolean' ? input : invalid(path, 'a boolean') });
/** @type {import('./decode.js').Decoder<ArtifactReference>} */
const artifact = (input, path) => {
  const value = artifactFields(input, path);
  if (!/^sha256:[a-f0-9]{64}$/u.test(value.ref)) invalid(path + '.ref', 'a SHA-256 reference');
  if (value.originalSize < value.size || value.truncated !== (value.size < value.originalSize)) {
    invalid(path, 'consistent artifact sizes and truncation');
  }
  return value;
};
const summaryFields = { coveredObservationRefs: arrayOf(id) };
const summary = record({ author: id, ...summaryFields });
const summaryReport = record({ kind: oneOf('model_summary'), text: id, ...summaryFields });
const itemFields = record({
  ref: id, source, completeness, value: optional(jsonValue), provenance: optional(provenance),
  artifact: optional(artifact), summary: optional(summary),
});

/** @typedef {{ref: string, size: number, originalSize: number, truncated: boolean}} ArtifactReference
 * @typedef {{kind: 'user' | 'model' | 'provider_tool' | 'provider_report' | 'host_transport',
 *   sourceId: string, receivedAt?: number, exit?: {kind: 'agent_exit' | 'tool_exit', code: number}}} Provenance
 * @typedef {{ref: string, source: ReturnType<typeof source>, completeness: ReturnType<typeof completeness>,
 *   value?: unknown, provenance?: Provenance, artifact?: ArtifactReference, summary?: ReturnType<typeof summary>}} Observation
 * @typedef {Observation & {receivedSequence?: {revision: number, index: number}, attemptId?: string,
 *   kind?: 'finding', excerpt?: string, unavailableReason?: 'missing' | 'budget' | 'payload',
 *   outputKind?: Outcome['outputRefs'][number]['kind']}} ContextItem
 * @typedef {{ref: string, sourceId: string, completeness: Observation['completeness'], value?: unknown} & (
 *   {kind: 'agent_exit', exitCode: number} |
 *   {kind: 'provider_tool', exitCode?: number} |
 *   {kind: 'model' | 'provider_report' | 'host_transport'}
 * )} AdapterObservation
 * @typedef {AdapterObservation | Omit<Observation, 'provenance' | 'artifact' | 'summary'> | ReturnType<typeof summaryReport>} ProviderObservation
 */

/** @type {import('./decode.js').Decoder<Observation>} */
export const contextItem = (input, path) => {
  const value = itemFields(input, path);
  const origin = value.provenance;
  if (origin && sources[origin.kind] !== value.source) invalid(path + '.source', 'the source for the provenance kind');
  if (origin?.exit && origin.kind !== (origin.exit.kind === 'agent_exit' ? 'host_transport' : 'provider_tool')) {
    invalid(path + '.provenance.exit.kind', 'an exit scoped to the observed process or reported tool');
  }
  if (value.artifact && (value.value !== undefined || value.summary ||
      value.completeness !== (value.artifact.truncated ? 'truncated' : 'complete'))) {
    invalid(path + '.artifact', 'a standalone artifact with consistent completeness');
  }
  if (value.summary && (origin?.kind !== 'model' || origin.sourceId !== value.summary.author ||
      typeof value.value !== 'string' || !value.value.trim() || value.completeness !== 'complete' ||
      !validCoverage(value.summary.coveredObservationRefs))) {
    invalid(path + '.summary', 'an attributed model summary with unique observation references');
  }
  return value;
};

/** @param {readonly string[]} refs */
function validCoverage(refs) {
  return refs.length > 0 && new Set(refs).size === refs.length;
}

/** @param {unknown} input */
export function decodeSummaryReport(input) {
  const result = decode(summaryReport, input);
  return result.kind === 'accepted' && validCoverage(result.value.coveredObservationRefs) ? result.value : undefined;
}

/** @param {Omit<Observation, 'source' | 'provenance'>} item @param {Provenance} origin @returns {Observation} */
export function observation(item, origin) {
  return { ...item, source: sources[origin.kind], provenance: origin };
}

const adapterFields = { ref: id, sourceId: id, completeness, value: optional(jsonValue) };
const adapterObservation = record({
  ...adapterFields, kind: oneOf('agent_exit', 'provider_tool', 'model', 'provider_report', 'host_transport'), exitCode: optional(exitCode),
});
const legacyObservation = record({ ref: id, source, completeness, value: optional(jsonValue) });

/** @param {ProviderObservation} input @param {number} receivedAt @returns {Observation | undefined} */
export function receiveProviderObservation(input, receivedAt) {
  if (input && Object.hasOwn(input, 'kind')) {
    const parsed = decode(adapterObservation, input);
    if (parsed.kind === 'rejected') return undefined;
    const { kind, sourceId, exitCode, ...item } = parsed.value;
    if (kind === 'agent_exit') {
      return exitCode === undefined ? undefined : observation(item, {
        kind: 'host_transport', sourceId, receivedAt, exit: { kind: 'agent_exit', code: exitCode },
      });
    }
    if (exitCode !== undefined && kind !== 'provider_tool') return undefined;
    return observation(item, {
      kind, sourceId, receivedAt,
      ...(exitCode === undefined ? {} : { exit: { kind: 'tool_exit', code: exitCode } }),
    });
  }
  const parsed = decode(legacyObservation, input);
  if (parsed.kind === 'rejected') return undefined;
  const { source, ...item } = parsed.value;
  // An opaque legacy payload supplies no verified process or tool identity.
  return observation(item, { kind: source === 'model_claim' ? 'model' : 'provider_report', sourceId: item.ref, receivedAt });
}

/** @param {Outcome} outcome @param {readonly Observation[]} observations @returns {Outcome} */
export function attributeProviderOutputRefs(outcome, observations) {
  return {
    ...outcome,
    outputRefs: outcome.outputRefs.map(ref => {
      const item = observations.find(item => item.ref === ref.ref);
      const isExit = ref.kind === 'agent_exit' || ref.kind === 'tool_exit';
      if (isExit && item?.provenance?.exit?.kind === ref.kind) {
        return { ...ref, source: ref.kind === 'agent_exit' ? 'host_observed' : 'provider_reported' };
      }
      const source = item?.source ?? ref.source;
      return {
        ...ref,
        source: source === 'model_claim' ? 'model_claim' : 'provider_reported',
        kind: isExit ? 'observation' : ref.kind,
      };
    }),
  };
}
