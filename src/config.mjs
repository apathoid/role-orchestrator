import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readScopedText } from './instruction-files.mjs';
import { mergeSecurityConfig, validateSecurityConfig } from './security.mjs';
import { ROLE_NAMES, validateRolePresets } from './role-presets.mjs';
import { validateProfileDefinition } from './profile-validation.mjs';

const DEFAULT_CONFIG_PATH = new URL('../config/chatgpt-plus.json', import.meta.url);
const SUPPORTED_PROVIDER_TYPES = new Set(['acp-agent', 'codex-acp', 'codex-cli']);



function isObject(v) { return v && typeof v === 'object' && !Array.isArray(v); }
// Named presets form an ordered catalog: same ID replaces its definition in
// place, new IDs append. Other arrays intentionally retain replacement semantics.
function merge(base, override, key = '') {
  if (key === 'rolePresets' && Array.isArray(base) && Array.isArray(override)) {
    const ids = override.map((preset) => preset?.id);
    if (new Set(ids).size !== ids.length) throw new Error('Duplicate rolePresets IDs in configuration layer.');
    const entries = [...base];
    for (const preset of override) {
      const index = entries.findIndex((candidate) => candidate?.id === preset?.id);
      if (index < 0) entries.push(preset);
      else entries[index] = preset;
    }
    return entries;
  }
  if (!isObject(base) || !isObject(override)) return override;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) out[k] = k in base ? merge(base[k], v, k) : v;
  return out;
}
function needString(v, name) { if (typeof v !== 'string' || !v) throw new Error(`${name} must be a non-empty string.`); }
function optionalPositiveMs(v, name) {
  if (v !== undefined && (!Number.isInteger(v) || v <= 0)) throw new Error(`${name} must be a positive integer.`);
}

function validate(config) {
  if (!isObject(config.providers) || !isObject(config.profiles) || !isObject(config.roles)) {
    throw new Error('Config requires providers, profiles and roles objects.');
  }
  for (const [name, provider] of Object.entries(config.providers)) {
    const adapter = provider.adapter ?? provider.type;
    needString(adapter, `providers.${name}.adapter`);
    if (!SUPPORTED_PROVIDER_TYPES.has(adapter)) {
      const field = provider.adapter !== undefined ? 'adapter' : 'type';
      throw new Error(`providers.${name}.${field} must be one of: ${[...SUPPORTED_PROVIDER_TYPES].join(', ')}.`);
    }
    // Backward compatibility: legacy configs used `type`. Keep accepting it
    // while the canonical schema uses `adapter`.
    if (provider.adapter === undefined && provider.type !== undefined) provider.adapter = provider.type;
    if (adapter === 'acp-agent') {
      needString(provider.command ?? provider.binary, `providers.${name}.command`);
      if (!isObject(provider.workspaceModes)) throw new Error(`providers.${name}.workspaceModes is required for acp-agent.`);
      needString(provider.workspaceModes.readOnly, `providers.${name}.workspaceModes.readOnly`);
      needString(provider.workspaceModes.write, `providers.${name}.workspaceModes.write`);
    }
    optionalPositiveMs(provider.idleTimeoutMs, `providers.${name}.idleTimeoutMs`);
    optionalPositiveMs(provider.turnDeadlineMs, `providers.${name}.turnDeadlineMs`);
    optionalPositiveMs(provider.invocationDeadlineMs, `providers.${name}.invocationDeadlineMs`);
    optionalPositiveMs(provider.preflightTimeoutMs, `providers.${name}.preflightTimeoutMs`);
    optionalPositiveMs(provider.cleanupTimeoutMs, `providers.${name}.cleanupTimeoutMs`);
    optionalPositiveMs(provider.timeoutMs, `providers.${name}.timeoutMs`); // legacy alias
    if (provider.supportsFastMode !== undefined && typeof provider.supportsFastMode !== 'boolean') {
      throw new Error(`providers.${name}.supportsFastMode must be boolean.`);
    }
    if (provider.fastModeConfigId !== undefined) needString(provider.fastModeConfigId, `providers.${name}.fastModeConfigId`);
    if (adapter === 'acp-agent' && provider.supportsFastMode === true && !provider.fastModeConfigId) {
      throw new Error(`providers.${name}.fastModeConfigId is required for a generic ACP provider with supportsFastMode=true.`);
    }
    if (provider.reasoningEfforts !== undefined && (!Array.isArray(provider.reasoningEfforts) || provider.reasoningEfforts.some((v) => typeof v !== 'string' || !v))) {
      throw new Error(`providers.${name}.reasoningEfforts must be an array of strings.`);
    }
    if (provider.models !== undefined) {
      if (!Array.isArray(provider.models)) throw new Error(`providers.${name}.models must be an array.`);
      const modelIds = new Set();
      for (const [i, model] of provider.models.entries()) {
        const id = typeof model === 'string' ? model : model?.id;
        if (typeof model === 'string') needString(model, `providers.${name}.models[${i}]`);
        else {
          if (!isObject(model)) throw new Error(`providers.${name}.models[${i}] must be a string or object.`);
          needString(model.id, `providers.${name}.models[${i}].id`);
        }
        if (modelIds.has(id)) throw new Error(`providers.${name}.models contains duplicate model id ${id}.`);
        modelIds.add(id);
        if (typeof model === 'string') continue;
        if (model.contextWindow !== undefined && (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0)) {
          throw new Error(`providers.${name}.models[${i}].contextWindow must be a positive integer.`);
        }
        if (model.reasoningEfforts !== undefined && (!Array.isArray(model.reasoningEfforts) || model.reasoningEfforts.some((v) => typeof v !== 'string' || !v))) {
          throw new Error(`providers.${name}.models[${i}].reasoningEfforts must be an array of strings.`);
        }
        if (model.supportsFastMode !== undefined && typeof model.supportsFastMode !== 'boolean') {
          throw new Error(`providers.${name}.models[${i}].supportsFastMode must be boolean.`);
        }
      }
    }
  }
  for (const [name, profile] of Object.entries(config.profiles)) {
    validateProfileDefinition(profile, config.providers, `profiles.${name}`);
  }
  for (const role of ROLE_NAMES) {
    needString(config.roles[role], `roles.${role}`);
    if (!config.profiles[config.roles[role]]) throw new Error(`roles.${role} references unknown profile ${config.roles[role]}.`);
  }
  validateRolePresets(config);
  config.security = validateSecurityConfig(config.security ?? {});

  const rounds = Number(config.policy?.maxFixRounds ?? 2);
  if (!Number.isInteger(rounds) || rounds < 0 || rounds > 20) throw new Error('policy.maxFixRounds must be 0..20.');
  const reviewVerification = config.policy?.reviewVerification ?? false;
  if (typeof reviewVerification !== 'boolean') throw new Error('policy.reviewVerification must be boolean.');
  const work = config.policy?.reviewWork ?? {};
  if (!isObject(work)) throw new Error('policy.reviewWork must be an object.');
  for (const [key, limit] of Object.entries({ maxFilesPerUnit: 16, maxUnitsPerBatch: 8, maxBatchesPerRun: 16 })) {
    const value = work[key];
    if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > limit)) {
      throw new Error(`policy.reviewWork.${key} must be 1..${limit}.`);
    }
  }

  const routerContext = config.policy?.routerContext;
  if (routerContext !== undefined && (!isObject(routerContext) ||
      Object.keys(routerContext).some(key => key !== 'mode') ||
      (routerContext.mode !== undefined && !['legacy','observe','optimized'].includes(routerContext.mode))))
    throw new Error('policy.routerContext.mode must be legacy, observe or optimized.');
  const reviewEfficiency = config.policy?.reviewEfficiency ?? {};
  if (!isObject(reviewEfficiency)) throw new Error('policy.reviewEfficiency must be an object.');
  if (reviewEfficiency.enabled !== undefined && typeof reviewEfficiency.enabled !== 'boolean')
    throw new Error('policy.reviewEfficiency.enabled must be boolean.');
  if (reviewEfficiency.forceDeep !== undefined && typeof reviewEfficiency.forceDeep !== 'boolean')
    throw new Error('policy.reviewEfficiency.forceDeep must be boolean.');
  for (const [key, max] of Object.entries({ maxUnitsPerBatch: 8, maxFilesPerUnit: 16 })) {
    if (reviewEfficiency[key] !== undefined && (!Number.isInteger(reviewEfficiency[key]) || reviewEfficiency[key] < 1 || reviewEfficiency[key] > max))
      throw new Error(`policy.reviewEfficiency.${key} must be 1..${max}.`);
  }
  const projectContext = reviewEfficiency.projectContext;
  if (projectContext !== undefined && (!isObject(projectContext) ||
      (projectContext.mode !== undefined && !['legacy','observe','optimized'].includes(projectContext.mode))))
    throw new Error('policy.reviewEfficiency.projectContext.mode must be legacy, observe or optimized.');
  if (reviewEfficiency.contextMode !== undefined && !['legacy','bounded_history'].includes(reviewEfficiency.contextMode))
    throw new Error('policy.reviewEfficiency.contextMode must be legacy or bounded_history.');
  if (reviewEfficiency.maxHistoryCharacters !== undefined && (!Number.isSafeInteger(reviewEfficiency.maxHistoryCharacters) ||
      reviewEfficiency.maxHistoryCharacters < 3000 || reviewEfficiency.maxHistoryCharacters > 100000))
    throw new Error('policy.reviewEfficiency.maxHistoryCharacters must be 3000..100000.');
  const qualityDepth = reviewEfficiency.qualityDepth;
  if (qualityDepth !== undefined) {
    if (!isObject(qualityDepth) || Object.keys(qualityDepth).some(k =>
      !['mode','followUpPolicy','maxAdditionalInvocations'].includes(k)) ||
        (qualityDepth.mode !== undefined && !['off','observe','enforce'].includes(qualityDepth.mode)) ||
        (qualityDepth.followUpPolicy !== undefined && qualityDepth.followUpPolicy !== 'material_only') ||
        (qualityDepth.maxAdditionalInvocations !== undefined &&
        (!Number.isSafeInteger(qualityDepth.maxAdditionalInvocations) ||
          qualityDepth.maxAdditionalInvocations < 0 || qualityDepth.maxAdditionalInvocations > 4)))
      throw new Error('policy.reviewEfficiency.qualityDepth is invalid.');
  }
  const executionBudget = reviewEfficiency.executionBudget;
  if (executionBudget !== undefined) {
    if (!isObject(executionBudget)) throw new Error('policy.reviewEfficiency.executionBudget must be an object.');
    const keys = ['maxInvocations','maxElapsedMs','maxInputTokens','maxOutputTokens',
      'maxOperationInvocations','maxOperationElapsedMs','maxOperationInputTokens','maxOperationOutputTokens'];
    for (const key of Object.keys(executionBudget)) {
      if (!keys.includes(key) || !Number.isSafeInteger(executionBudget[key]) || executionBudget[key] < 1)
        throw new Error(`Invalid policy.reviewEfficiency.executionBudget.${key}.`);
    }
  }
  const evidencePolicy = config.policy?.evidence ?? {};
  if (!isObject(evidencePolicy)) throw new Error('policy.evidence must be an object.');
  for (const key of Object.keys(evidencePolicy)) {
    if (key !== 'persistentStore' || typeof evidencePolicy[key] !== 'boolean')
      throw new Error(`Invalid policy.evidence.${key}.`);
  }
  const verificationEfficiency = config.policy?.verificationEfficiency ?? {};
  if (!isObject(verificationEfficiency)) throw new Error('policy.verificationEfficiency must be an object.');
  if (verificationEfficiency.autoExecute !== undefined && typeof verificationEfficiency.autoExecute !== 'boolean')
    throw new Error('policy.verificationEfficiency.autoExecute must be boolean.');
  const safeCommands = verificationEfficiency.safeCommands ?? [];
  if (!Array.isArray(safeCommands) || safeCommands.length > 16 ||
      safeCommands.some(command => typeof command !== 'string' || !command || command.length > 400))
    throw new Error('policy.verificationEfficiency.safeCommands must be an array of bounded command names.');
  for (const key of Object.keys(verificationEfficiency)) {
    if (!['autoExecute','safeCommands'].includes(key)) throw new Error(`Invalid policy.verificationEfficiency.${key}.`);
  }
  const workflowEfficiency = config.policy?.workflowEfficiency ?? {};
  if (!isObject(workflowEfficiency)) throw new Error('policy.workflowEfficiency must be an object.');
  for (const key of ['investigationDirect', 'compactImplementationContext']) {
    if (workflowEfficiency[key] !== undefined && typeof workflowEfficiency[key] !== 'boolean')
      throw new Error(`policy.workflowEfficiency.${key} must be boolean.`);
  }
  const taskBudget = workflowEfficiency.executionBudget;
  if (taskBudget !== undefined) {
    if (!isObject(taskBudget)) throw new Error('policy.workflowEfficiency.executionBudget must be an object.');
    for (const [key,value] of Object.entries(taskBudget)) {
      if (!['maxInvocations','maxElapsedMs','maxInputTokens','maxOutputTokens'].includes(key) ||
          !Number.isSafeInteger(value) || value < 1)
        throw new Error(`Invalid policy.workflowEfficiency.executionBudget.${key}.`);
    }
  }
  const finalValidationForHighRisk = config.policy?.finalValidationForHighRisk ?? true;
  if (typeof finalValidationForHighRisk !== 'boolean') throw new Error('policy.finalValidationForHighRisk must be boolean.');
  if (config.ui?.defaultProfile !== undefined && (!config.profiles[config.ui.defaultProfile] || typeof config.ui.defaultProfile !== 'string')) {
    throw new Error(`ui.defaultProfile references unknown profile ${String(config.ui.defaultProfile)}.`);
  }
  config.policy = { ...config.policy, maxFixRounds: rounds, reviewVerification, finalValidationForHighRisk };
  return config;
}

// Used by both direct runWorkflow callers and execution-service. Explicit
// merged layers win; default JSON deliberately has NO routerContext.mode.
// A diagnostic override is confined to explicit evaluator call sites.
export function resolveRouterContextMode(config, { env = process.env, diagnosticOverride = null } = {}) {
  const explicit = config?.policy?.routerContext?.mode;
  const mode = diagnosticOverride ?? explicit ?? env?.AGENT_ROUTER_CONTEXT_MODE ?? 'legacy';
  if (!['legacy','observe','optimized'].includes(mode))
    throw new Error('policy.routerContext.mode must be legacy, observe or optimized.');
  return mode;
}

export async function loadConfig({ repoRoot = null, home = homedir(), env = process.env } = {}) {
  let result = JSON.parse(await readFile(DEFAULT_CONFIG_PATH, 'utf8'));
  const candidates = [
    { file: join(home, '.agents', 'role-orchestrator', 'config.json'), root: join(home, '.agents') },
    ...(repoRoot ? [{ file: join(repoRoot, '.agents', 'role-orchestrator', 'config.json'), root: resolve(repoRoot) }] : []),
  ];
  // Legacy AGENT_CONFIG remains an explicit, highest-precedence override.
  // New installations need no environment variable.
  if (env.AGENT_CONFIG) {
    const file = resolve(env.AGENT_CONFIG);
    candidates.push({ file, root: null });
  }
  for (const { file, root } of candidates) {
    let raw;
    try {
      raw = root ? await readScopedText(file, root, { maxChars: 2_000_000 }) : await readFile(file, 'utf8');
    } catch (error) {
      throw new Error(`Cannot read orchestrator configuration ${file}: ${error.message}`, { cause: error });
    }
    if (raw === null) continue;
    let override;
    try { override = JSON.parse(raw); }
    catch (error) { throw new Error(`Invalid JSON in orchestrator configuration ${file}: ${error.message}`, { cause: error }); }
    if (!isObject(override)) throw new Error(`Orchestrator configuration ${file} must contain a JSON object.`);
    const combined = merge(result, override);
    // Explicit legacy override files retain historical array replacement.
    // The canonical global/project layers instead merge preset IDs in stable order.
    if (root === null && Object.hasOwn(override, 'rolePresets')) combined.rolePresets = override.rolePresets;
    combined.security = mergeSecurityConfig(result.security ?? {}, override.security ?? {},
      { lockBaseDenials: root !== null && repoRoot !== null && root === resolve(repoRoot),
        trustedOverride: root === null });
    result = combined;
  }
  return validate(result);
}
