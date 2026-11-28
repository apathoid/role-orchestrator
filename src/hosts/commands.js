import { pathToFileURL } from 'node:url';
import { basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { journalReasonCode, pendingControllerReasoning, resourceSnapshot, workspaceContextFor } from '../core/operation.js';
import { redactDiagnostic } from '../application/redact-diagnostic.js';

/** @import {Operation} from '../core/operation.js' */
/** @typedef {ReturnType<typeof import('../application/orchestrator.js').createOrchestrator>} Coordinator */
/** @typedef {Pick<Coordinator, 'submit' | 'resume' | 'inspect' | 'cancel'> & {configurationRef: string, findRequest?:Coordinator['findRequest'], selectSkill?:(cwd:string,selection:string)=>Promise<import('../adapters/configuration/agent-skills.js').AgentSkill|undefined>, trace?: (operationId: string) => Promise<ReturnType<typeof operationTrace>>}} HostApi */
/** @typedef {{
 *   action: 'run' | 'resume' | 'inspect' | 'cancel' | 'trace' | 'export-diagnostics' | 'diagnose' | 'settings' | 'skills',
 *   requestId: string, operationId?: string, text?: string, cwd?: string, questionId?: string, cancellationSource?: 'client', controllerProfile?: string, userSettings?:import('../core/contracts.js').UserSettings,agentSkillSelection?:string,agentSkill?:ReturnType<typeof import('../core/contracts.js').agentSkill>,attachmentPaths?:string[]
 * }} Command */

/** @param {string} action */
export function isAdministrativeAction(action) {
  return action === 'inspect' || action === 'cancel' || action === 'trace' || action === 'export-diagnostics';
}

export class HostError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** @param {HostApi} api @param {Command} command @param {(id: string) => void} [accepted] */
export async function dispatchCommand(api, command, accepted) {
  const { action, operationId, requestId, text, cwd, questionId, cancellationSource, controllerProfile, userSettings, agentSkillSelection, attachmentPaths } = command;
  let agentSkill=command.agentSkill;
  if(agentSkillSelection!==undefined){
    if(agentSkill||!api.selectSkill||!['run','resume'].includes(action))throw new HostError('INVALID_ARGUMENT','Agent Skill selection unavailable');
    // Advisory lookup: submit/resume still enforce durable request identity.
    // Unrelated unreadable snapshots must not add a CLI-only admission gate.
    const prior=await api.findRequest?.(requestId,false);
    if(prior){
      const continued=prior.events.find(event=>event.kind==='operation.continued'&&event.input.requestId===requestId);
      const stored=action==='run'&&prior.request.requestId===requestId?prior.request:
        action==='resume'&&prior.operationId===operationId&&continued?.kind==='operation.continued'?continued.input:undefined;
      const skill=stored?.agentSkill;
      if(!skill||!(skill.selection!==undefined?skill.selection===agentSkillSelection:skill.name===agentSkillSelection||skill.path===agentSkillSelection))
        throw new HostError('IDENTITY_CONFLICT','Request identity already exists with a different Agent Skill selection');
      agentSkill=skill;
    }else{
      const workspace=action==='resume'&&operationId?workspaceContextFor(await api.inspect(operationId))?.cwd:cwd;
      const selected=await api.selectSkill(workspace??process.cwd(),agentSkillSelection);
      if(!selected)throw new HostError('INVALID_ARGUMENT','Unknown or ambiguous Agent Skill shortcut');
      agentSkill={name:selected.name,path:selected.path,source:selected.source,selection:agentSkillSelection};
    }
  }
  // New dispatch notifies before launch; existing or synthetic submissions may
  // return without invoking the callback. Preserve one acceptance in both cases.
  let notified = false;
  /** @param {string} id */
  const notify = id => { if (!notified) { notified = true; accepted?.(id); } };
  const input=attachmentPaths?.length?{content:[...(text!==undefined?[{kind:'text',text}]:[]),...attachmentPaths.map(path=>({kind:'link',uri:pathToFileURL(path).href,metadata:{name:basename(path)}}))]}:{text};
  if (action === 'run') {
    if (!text?.trim()&&!attachmentPaths?.length) throw new HostError('INVALID_ARGUMENT', 'A nonempty request is required');
    const submission = await api.submit({
      schemaVersion: 1, requestId, ...input, attachments: [], userConstraints: [],
      configurationRef: api.configurationRef, ...(controllerProfile!==undefined&&{controllerProfile}), ...(userSettings&&{userSettings}), ...(agentSkill&&{agentSkill}), ...(cwd && { workspaceContext: { cwd } }),
    }, notify);
    notify(submission.operation.operationId);
    return submission.completion;
  }
  if (!operationId) throw new HostError('INVALID_ARGUMENT', 'An operation id is required');
  if (action === 'resume') {
    if (text !== undefined && !text.trim()&&!attachmentPaths?.length) throw new HostError('INVALID_ARGUMENT', 'Follow-up text is empty');
    if(text===undefined&&!attachmentPaths?.length&&(controllerProfile!==undefined||userSettings||agentSkill))throw new HostError('INVALID_ARGUMENT','User settings require an explicit continuation');
    const submission = await api.resume(operationId, text === undefined&&!attachmentPaths?.length ? undefined : { requestId, ...input, questionId, controllerProfile, userSettings, agentSkill }, notify);
    notify(submission.operation.operationId);
    return submission.completion;
  }
  if (action === 'cancel') return api.cancel(operationId, cancellationSource);
  if (action === 'trace' || action === 'export-diagnostics') {
    // The runtime owns the trusted secret values. A synthetic HostApi may
    // still use the conservatively redacted, secret-unaware projection.
    return api.trace ? api.trace(operationId) : operationTrace(await api.inspect(operationId));
  }
  return api.inspect(operationId);
}

/** @param {Operation} operation @param {{secrets?: readonly string[], knownValueMasking?: 'available_current_values' | 'partial_current_values' | 'unavailable'}} [redaction] */
export function operationTrace(operation, redaction = {}) {
  const limit = 256;
  const { events, operationId, revision } = operation;
  const start = Math.max(0, events.length - limit);
  const missing = [
    'model content', 'tool bodies', 'transient diagnostics',
    ...(start ? ['earlier journal events'] : []),
  ];
  const resources = resourceSnapshot(operation);
  const actionByAttempt = new Map(operation.attempts.map(attempt => [attempt.attemptId, attempt.actionId]));
  const decisions = new Map(events.flatMap(event => event.kind === 'controller.responded'
    ? [[event.decision.decisionId, event.decision]] : []));
  const actions = new Map(events.flatMap(event => event.kind === 'controller.responded'
    ? event.decision.additions.map(action => [action.actionId, action]) : []));
  /** @type {Map<string, import('../core/observation.js').Observation[]>} */
  const receipts = new Map();
  for (const event of events) {
    if (event.kind !== 'attempt.outcome') continue;
    const known = receipts.get(event.outcome.attemptId) ?? [];
    known.push(...(event.observations ?? []));
    receipts.set(event.outcome.attemptId, known);
  }
  const attemptStart = Math.max(0, operation.attempts.length - limit);
  const visibleAttempts = operation.attempts.slice(attemptStart);
  /** @param {Operation['attempts'][number]} attempt */
  function reasoningInfo(attempt) {
    const route = attempt.route;
    const selection = route?.reasoning;
    const controlling = attempt.reasoningDecisionId
      ? decisions.get(attempt.reasoningDecisionId)?.nextController : undefined;
    const requestedLevel = attempt.attemptId === attempt.actionId
      ? controlling?.reasoningLevel : actions.get(attempt.actionId)?.reasoningLevel;
    const acknowledged = (receipts.get(attempt.attemptId) ?? []).some(observation =>
      observation.providerRef === 'acp-reasoning-ack' &&
      observation.provenance?.kind === 'host_transport' &&
      observation.value && typeof observation.value === 'object' &&
      !Array.isArray(observation.value) &&
      'status' in observation.value && observation.value.status === 'config_option_confirmed');
    return {
      requestedLevel, source: selection?.selectionSource,
      effective: selection ?? 'not_recorded', configurationRef: route?.configurationRef,
      nativeConfigAcknowledgment: acknowledged ? 'adapter_confirmed' : 'not_recorded',
      submission: attempt.dispatchCertainty,
    };
  }
  const waiting = operation.waiting?.kind === 'technical'
    ? { kind: 'technical', code: operation.waiting.reason.code,
      attemptId: operation.waiting.reason.attemptId,
      actionId: operation.waiting.reason.actionId,
      dispatchCertainty: operation.waiting.reason.dispatchCertainty,
      effect: operation.waiting.reason.effect,
      profileId: operation.waiting.reason.profileId, reasoningLevel: operation.waiting.reason.reasoningLevel,
      availableLevels: operation.waiting.reason.availableLevels,
      reasoningCause: operation.waiting.reason.reasoningCause, resource: operation.waiting.reason.resource,
      feature:operation.waiting.reason.feature,featureOption:operation.waiting.reason.featureOption,featureCause:operation.waiting.reason.featureCause }
    : operation.waiting?.kind === 'question'
      ? { kind: 'question', questionId: operation.waiting.questionId } : undefined;
  const projection = {
    schemaVersion: 1, operationId, revision, source: 'operation-journal', redacted: true,
    manifest: { schemaVersion: 1, format: 'operation-journal-json-v1',
      origin: 'durable-state', transientDiagnosticsIncluded: false,
      missing, truncatedEvents: start, eventCount: events.length },
    status: operation.status, waiting, resources,
    controllerReasoning: { pending: pendingControllerReasoning(operation) ?? null,
      consumed: visibleAttempts.flatMap(attempt => attempt.reasoningDecisionId
        ? [{attemptId:attempt.attemptId, decisionId:attempt.reasoningDecisionId}] : []) },
    omittedAttempts: attemptStart,
    attempts: visibleAttempts.map(attempt => ({
      attemptId: attempt.attemptId, actionId: attempt.actionId, status: attempt.status,
      profileId: attempt.route?.profileId, providerId: attempt.route?.providerId,
      reasoning: reasoningInfo(attempt),
      ...((attempt.route?.collaborationMode||attempt.route?.approvalMode)&&{nativeSettings:{collaborationMode:attempt.route?.collaborationMode,approvalMode:attempt.route?.approvalMode}}),
      settingFacts:(receipts.get(attempt.attemptId)??[]).filter(item=>item.provenance?.kind==='host_transport'&&(item.providerRef?.startsWith('acp-setting-')||item.ref.startsWith('host:approval-applicability:')||item.ref.startsWith('host:setting:'))).map(item=>item.value),
      dispatchCertainty: attempt.dispatchCertainty,
      effect: attempt.outcome?.effect ?? (attempt.status === 'dispatched' ? 'unknown' : undefined),
      terminal: attempt.outcome?.terminal,
      reasonCode: attempt.outcome?.diagnostics[0]?.code,
    })),
    omitted: missing, omittedEvents: start,
    events: events.slice(start).map((event, index) => {
      const attemptId = event.kind === 'attempt.outcome' ? event.outcome.attemptId :
        'attemptId' in event ? event.attemptId : undefined;
      return {
        sequence: start + index + 1, eventId: event.eventId, receivedAt: event.receivedAt,
        eventName: event.kind, reasonCode: journalReasonCode(event), attemptId,
        actionId: 'actionId' in event ? event.actionId : attemptId ? actionByAttempt.get(attemptId) : undefined,
        decisionId: event.kind === 'controller.responded' ? event.decision.decisionId :
          event.kind === 'controller.invalid_proposal' ? event.decisionId : undefined,
        ...(event.kind === 'controller.invalid_proposal' && {category:'contract', field: event.reason.path, expected: event.reason.expected}),
        ...((event.kind === 'action.rejected' || event.kind === 'action.deferred') &&
          {category: event.category, resource: event.resource}),
        source: event.kind === 'operation.cancelled' || event.kind === 'action.cancelled' ||
          event.kind === 'attempt.cancel_requested' ? event.source : undefined,
      };
    }),
  };
  // Every exported string (including model-chosen identifiers) passes through
  // the same known-secret projection as live events. Bodies stay excluded.
  const redacted = /** @type {typeof projection} */ (redactDiagnostic(projection, { secrets: redaction.secrets }));
  // Fixed coverage metadata is not user/model content, and must survive redaction.
  const knownValueMasking = redaction.knownValueMasking ?? (redaction.secrets?.some(value => value.length >= 4)
    ? 'available_current_values' : 'unavailable');
  return { ...redacted, manifest: { ...redacted.manifest, knownValueMasking } };
}

/** @param {Operation} operation */
export function operationView(operation) {
  return {
    operationId: operation.operationId, status: operation.status, revision: operation.revision,
    pendingControllerReasoning: pendingControllerReasoning(operation) ?? null,
    waiting: operation.waiting, cancellation: operation.cancellation, assessment: operation.assessment,
    resources: resourceSnapshot(operation), attempts: operation.attempts.map(attempt => ({
      attemptId: attempt.attemptId, actionId: attempt.actionId, status: attempt.status, route: attempt.route,
      dispatchCertainty: attempt.dispatchCertainty, terminal: attempt.outcome?.terminal,
      effect: attempt.outcome?.effect ?? (attempt.status === 'dispatched' ? 'unknown' : undefined),
      diagnostics: attempt.outcome?.diagnostics, cancellation: attempt.cancellation,
    })),
    pendingDependencies: operation.events.flatMap(event => event.kind === 'controller.responded'
      ? (event.admissions ?? []).flatMap(item => item.kind === 'accepted' && item.action.dependsOn.length &&
        !operation.attempts.some(attempt => attempt.actionId === item.action.actionId)
        ? [{ actionId: item.action.actionId, dependsOn: item.action.dependsOn }] : []) : []),
  };
}

/** @param {unknown} error */
export function hostError(error) {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    return { code: error.code, message: error.message,
      path: 'path' in error && typeof error.path === 'string' ? error.path : undefined };
  }
  return { code: 'HOST_FAILURE', message: 'Host operation failed' };
}

export const newRequestId = randomUUID;
