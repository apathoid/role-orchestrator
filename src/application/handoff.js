import { workspaceContextFor } from '../core/operation.js';
import { compactContext, unavailableContext } from './context-bundle.js';
import { coordinationFacts, operationHistory } from './controller-context.js';
/** @import {LookupStatus} from './recovery.js' */
/** @import {ContextItem} from '../core/observation.js' */
/** @import {Action} from '../core/contracts.js' */
/** @import {Operation, Reason} from '../core/operation.js' */
/** @import {Catalog, CatalogEntry, Invocation, SkillInstructions} from '../core/ports.js' */

/** @typedef {Omit<Invocation, 'attemptId' | 'signal' | 'timeoutMs' | 'idempotencyKey' | 'context'>} Handoff */

/**
 * The catalog and authority reference are supplied by the Host. Role and skill
 * instructions travel separately and cannot change the selected profile or grant.
 * @param {Operation} operation
 * @param {Action} action
 * @param {readonly CatalogEntry[]} catalog
 * @returns {{kind: 'accepted', handoff: Handoff} | {kind: 'rejected', reason: Reason, resource: string, category: import('../core/operation.js').ActionFailureCategory}}
 */
export function prepareHandoff(operation, action, catalog) {
  /** @param {string} resource @param {import('../core/operation.js').ActionFailureCategory} category @returns {{kind: 'rejected', reason: Reason, resource: string, category: import('../core/operation.js').ActionFailureCategory}} */
  const missing = (resource, category) => ({
    kind: 'rejected', resource, category, reason: {
      code: 'CAPABILITY_UNAVAILABLE', operationId: operation.operationId, actionId: action.actionId,
      dispatchCertainty: 'not_sent', effect: 'none',
    },
  });

  const profile = catalog.find(item => item.kind === 'profile' && item.value.profileId === action.profileId);
  if (profile?.kind !== 'profile') return missing(action.profileId, 'profile');
  const instructions = [];
  if (action.roleId) {
    const role = catalog.find(item => item.kind === 'role' && item.value.id === action.roleId);
    if (role?.kind !== 'role') return missing(action.roleId, 'role');
    instructions.push(role.value.instructions);
  }
  /** @type {SkillInstructions[]} */
  const skillInstructions = [];
  for (const id of new Set(action.skills ?? [])) {
    const skill = catalog.find(item => item.kind === 'skill' && item.value.id === id);
    if (skill?.kind !== 'skill') return missing(id, 'skill');
    const { version, unavailable, instructions: inline } = skill.value;
    const identity = { id, ...(version === undefined ? {} : { version }) };
    // Inline instructions are one complete source, not a second copy of the
    // dynamically loaded source. An explicitly unavailable source stays so.
    skillInstructions.push(unavailable ? { ...identity, status: 'unavailable', reason: unavailable }
      : typeof inline === 'string' && inline.length ? { ...identity, status: 'complete', instructions: inline }
      : { ...identity, status: 'unavailable', reason: 'not_loaded' });
  }

  return {
    kind: 'accepted', handoff: {
      kind: 'delegate', operationId: operation.operationId, actionId: action.actionId,
      objective: action.objective, instructions, ...(skillInstructions.length ? { skillInstructions } : {}),
      profile: profile.value, workspaceContext: workspaceContextFor(operation),
      userConstraints: operation.request.userConstraints, authorityRef: operation.authorityRef,
      attachments: operation.request.attachments.filter(attachment => action.contextRefs.includes(attachment.ref)),
      requiredCapabilities: action.requiredCapabilities,
      expectedResult: action.expectedResult, continuationReference: action.continuationReference,
    },
  };
}


/**
 * Materialize exactly one selected source per skill, preserving catalog identity
 * and the existing aggregate skill-text limit. Never silently substitute a
 * different version or imply delivery of missing material.
 * @param {readonly SkillInstructions[]} selected
 * @param {Catalog} catalog @param {number} maxBytes @param {AbortSignal} signal
 * @returns {Promise<SkillInstructions[]>}
 */
export async function materializeSkillInstructions(selected, catalog, maxBytes, signal) {
  /** @type {SkillInstructions[]} */
  const result = [];
  let remaining = maxBytes;
  for (const entry of selected) {
    signal.throwIfAborted();
    const identity = { id: entry.id, ...(entry.version === undefined ? {} : { version: entry.version }) };
    /** @param {string} reason @returns {SkillInstructions} */
    const unavailable = reason => ({ ...identity, status: 'unavailable', reason });
    let material = entry;
    if (entry.status === 'unavailable' && entry.reason === 'not_loaded') {
      if (!catalog.loadSkill) material = unavailable('loader_unavailable');
      else if (remaining < 1) material = unavailable('budget');
      else {
        try { material = await catalog.loadSkill(entry.id, remaining, signal); }
        catch { material = unavailable('source_unavailable'); }
      }
    }
    signal.throwIfAborted();
    if (!material || material.id !== entry.id) {
      result.push(unavailable('identity_mismatch'));
      continue;
    }
    if (material.status === 'unavailable') {
      result.push(unavailable(material.reason ?? 'resource_unavailable'));
      continue;
    }
    if (entry.version !== undefined && material.version !== entry.version) {
      result.push(unavailable('version_changed'));
      continue;
    }
    if ((material.status !== 'complete' && material.status !== 'truncated') ||
        typeof material.instructions !== 'string' || (material.status === 'complete' && !material.instructions)) {
      result.push(unavailable('resource_unavailable'));
      continue;
    }
    if (remaining < 1) {
      result.push(unavailable('budget'));
      continue;
    }
    let end = 0;
    for (const character of material.instructions) {
      const size = Buffer.byteLength(JSON.stringify(character)) - 2;
      if (size > remaining) break;
      remaining -= size;
      end += character.length;
    }
    result.push({ id: entry.id, ...(material.version === undefined ? {} : { version: material.version }),
      status: material.status === 'truncated' || end < material.instructions.length ? 'truncated' : 'complete',
      instructions: material.instructions.slice(0, end), ...(material.reason ? { reason: material.reason } : {}) });
  }
  return result;
}

/**
 * @param {Operation} operation @param {readonly string[]} refs @param {number} maxBytes
 * @param {ReadonlyMap<string, LookupStatus>} [lookups] @returns {ContextItem[]}
 */
export function handoffContext(operation, refs, maxBytes, lookups) {
  const selected = new Set(refs);
  const facts = coordinationFacts(operation, lookups);
  const includeFacts = facts.unresolvedAttempts.length || facts.cancellations.length;
  const factsRef = 'host:operation-state';
  if (includeFacts) selected.delete(factsRef);
  /** @type {Map<string, ContextItem>} */
  const found = new Map();
  for (const item of operationHistory(operation)) {
    if (selected.has(item.ref) && !found.has(item.ref)) found.set(item.ref, item);
  }
  const attachments = new Set(operation.request.attachments.map(item => item.ref));
  const records = [...selected].filter(ref => found.has(ref) || !attachments.has(ref))
    .map(ref => found.get(ref) ?? unavailableContext(ref, 'missing'));
  let bounded = compactContext(records, maxBytes, true);
  if (bounded.unrepresented > 0) {
    // Reserve room for a single constant-size technical summary and compact
    // again. Use the maximal possible count to reserve enough decimal digits.
    /** @param {number} count @returns {ContextItem} */
    const summary = count => ({ ref: 'host:context-budget', source: 'host_observed',
      completeness: 'complete', value: { omitted: count, selected: records.length, maxBytes } });
    const summaryBytes = Buffer.byteLength(JSON.stringify(summary(records.length))) + 1;
    bounded = compactContext(records, Math.max(0, maxBytes - summaryBytes), true);
    bounded.context.push(summary(bounded.unrepresented));
  }
  const { context } = bounded;
  if (includeFacts) {
    context.push({ ref: factsRef, source: 'host_observed', completeness: 'complete', value: facts });
  }
  return context;
}
