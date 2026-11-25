import { decision } from './contracts.js';
import { decode, invalid } from './decode.js';

/**
 * ControllerIntent contains only model-owned Decision v1 fields. The canonical
 * Decision decoder remains the sole authority for their values/combinations.
 * No provider transport types or Host identities enter this contract.
 */

const intentFields = new Set([
  'additions', 'cancellations', 'acceptedActionIds', 'waitPolicy',
  'clarification', 'nextController', 'finalAssessment', 'findings',
]);

/** @param {unknown} value @param {string} path @returns {Record<string, unknown>} */
function plain(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    return invalid(path, 'an object');
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {unknown} value */
const emptyArray = value => value === undefined ? [] : value;

/** @param {unknown} value @param {string} path @param {readonly string[]} fields */
function withEmptyArrays(value, path, fields) {
  const source = plain(value, path);
  const copy = { ...source };
  for (const field of fields) if (!Object.hasOwn(source, field)) copy[field] = [];
  return copy;
}

/** @param {unknown} value @param {string} path */
function actionIntent(value, path) {
  return withEmptyArrays(value, path, ['contextRefs', 'dependsOn']);
}

/** @param {unknown} value @param {string} path */
function findingIntent(value, path) {
  const source = withEmptyArrays(value, path, ['supports', 'uncertainties']);
  if (Object.hasOwn(source, 'author')) invalid(path + '.author', 'a Host-bound author (omit this field)');
  return { ...source, author: 'intent-author' };
}

/** @param {unknown} value @param {string} path */
function assessmentIntent(value, path) {
  const source = withEmptyArrays(value, path, [
    'requirements', 'observationRefs', 'findingRefs', 'unresolvedQuestions',
  ]);
  if (Object.hasOwn(source, 'author')) invalid(path + '.author', 'a Host-bound author (omit this field)');
  return {
    ...source, author: 'intent-author',
    requirements: Array.isArray(source.requirements)
      ? source.requirements.map((item, i) =>
        withEmptyArrays(item, path + '.requirements[' + i + ']', ['observationRefs', 'findingRefs']))
      : source.requirements,
  };
}

/**
 * Validate model-owned intent through the existing canonical Decision v1
 * decoder with inert, private technical placeholders, then strip them.
 * This shares every existing cross-field invariant and decoder error path.
 * @param {unknown} input
 */
export function decodeControllerIntent(input) {
  const parsed = decode((value, path) => {
    const source = plain(value, path);
    for (const field of Object.keys(source)) {
      if (!intentFields.has(field)) invalid(path + '.' + field,
        'a model-owned ControllerIntent field (Host-owned metadata must be omitted)', [...intentFields]);
    }
    const complete = decision({
      schemaVersion: 1, decisionId: 'intent-draft', operationId: 'intent-draft', contextCursor: 0,
      additions: Array.isArray(source.additions)
        ? source.additions.map((action, i) => actionIntent(action, path + '.additions[' + i + ']'))
        : emptyArray(source.additions),
      cancellations: emptyArray(source.cancellations),
      acceptedActionIds: source.acceptedActionIds,
      waitPolicy: source.waitPolicy,
      clarification: source.clarification,
      nextController: source.nextController,
      finalAssessment: source.finalAssessment === undefined ? undefined
        : assessmentIntent(source.finalAssessment, path + '.finalAssessment'),
      findings: Array.isArray(source.findings)
        ? source.findings.map((item, i) => findingIntent(item, path + '.findings[' + i + ']'))
        : source.findings,
    }, path);
    // Construct fresh, whitelisted model data: technical placeholders never
    // escape or become provider-reported identity.
    return {
      additions: complete.additions,
      cancellations: complete.cancellations,
      acceptedActionIds: complete.acceptedActionIds,
      waitPolicy: complete.waitPolicy,
      clarification: complete.clarification,
      nextController: complete.nextController,
      finalAssessment: complete.finalAssessment && {
        overall: complete.finalAssessment.overall,
        requirements: complete.finalAssessment.requirements,
        observationRefs: complete.finalAssessment.observationRefs,
        findingRefs: complete.finalAssessment.findingRefs,
        unresolvedQuestions: complete.finalAssessment.unresolvedQuestions,
        answer: complete.finalAssessment.answer,
      },
      findings: complete.findings?.map(item => ({
        findingId: item.findingId, claim: item.claim, subject: item.subject,
        supports: item.supports, uncertainties: item.uncertainties, supersedes: item.supersedes,
      })),
    };
  }, input);
  // Canonical Decision validation supplies local fields. Author is Host-owned
  // everywhere in the external Intent (unlike legacy Decision); never offer
  // the normalization placeholder as an input field. No path-specific rules.
  if (parsed.kind === 'rejected' && parsed.reason.allowedFields) {
    return {...parsed, reason:{...parsed.reason,
      allowedFields:parsed.reason.allowedFields.filter(field => field !== 'author')}};
  }
  return parsed;
}
