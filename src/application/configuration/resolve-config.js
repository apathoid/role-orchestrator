import { defaultContextBudgets } from '../context-bundle.js';
import { arrayOf, count, decode, id, invalid, oneOf, optional, record } from '../../core/decode.js';

/** @import {Configuration, ResourceConfig} from './decode-config.js' */

/** @type {Readonly<Required<ResourceConfig>>} */
const defaults = Object.freeze({
  maxConcurrentInvocations: 2,
  maxInvocationsPerOperation: 40,
  invocationTimeoutMs: 180_000,
});

/** @param {unknown} input @param {string} path */
function positive(input, path) {
  const value = count(input, path);
  return value > 0 ? value : invalid(path, 'a positive safe integer');
}

/** @param {unknown} input @param {string} path */
function timeout(input, path) {
  const value = positive(input, path);
  return value <= 2_147_483_647 ? value : invalid(path, 'a timeout at most 2147483647 ms');
}

const resources = record({
  maxConcurrentInvocations: optional(positive),
  maxInvocationsPerOperation: optional(positive),
  invocationTimeoutMs: optional(timeout),
});
const preferences = {
  controllerProfile: optional(id),
  preferredRole: optional(id),
  preferredSkills: optional(arrayOf(id)),
  resources: optional(resources),
};
const projectShape = record({ schemaVersion: oneOf(1), ...preferences });
const launchShape = record(preferences);

/** @typedef {{kind: 'rejected', source: 'project' | 'launch', path: string, constraint: string}} Rejected */
/** @typedef {Configuration & {resources: Required<ResourceConfig>, context: typeof defaultContextBudgets, preferredRole?: string, preferredSkills: string[]}} EffectiveConfiguration */

/** @param {Rejected['source']} source @param {string} path @param {string} constraint @returns {Rejected} */
function reject(source, path, constraint) {
  return { kind: 'rejected', source, path, constraint };
}

/**
 * Project and launch inputs only choose known entries and resource settings.
 * The caller supplies launch preferences from its trusted command boundary.
 * @param {Configuration} user
 * @param {string | undefined} projectText
 * @param {unknown} [launchOptions]
 * @param {{profiles: ReadonlySet<string>, skills: ReadonlySet<string>}} [installed]
 * @returns {{kind: 'accepted', value: EffectiveConfiguration} | Rejected}
 */
export function resolveConfiguration(user, projectText, launchOptions = {}, installed) {
  /** @type {unknown} */
  let rawProject = { schemaVersion: 1 };
  if (projectText !== undefined) {
    try { rawProject = JSON.parse(projectText); }
    catch { return reject('project', '$', 'json'); }
  }
  const project = decode(projectShape, rawProject);
  if (project.kind === 'rejected') return reject('project', project.reason.path, project.reason.expected);
  const launch = decode(launchShape, launchOptions);
  if (launch.kind === 'rejected') return reject('launch', launch.reason.path, launch.reason.expected);

  for (const [source, values] of /** @type {const} */ ([['project', project.value], ['launch', launch.value]])) {
    if (values.controllerProfile !== undefined && !Object.hasOwn(user.profiles, values.controllerProfile)) {
      return reject(source, '$.controllerProfile', 'known-profile');
    }
    if (source === 'project' && values.controllerProfile !== undefined && installed && !installed.profiles.has(values.controllerProfile)) {
      return reject(source, '$.controllerProfile', 'available-profile');
    }
    if (values.preferredRole !== undefined && !Object.hasOwn(user.roles ?? {}, values.preferredRole)) {
      return reject(source, '$.preferredRole', 'known-role');
    }
    const skills = new Set((user.skills ?? []).map(skill => skill.id));
    const missing = values.preferredSkills?.findIndex(skill => !skills.has(skill));
    if (missing !== undefined && missing >= 0) return reject(source, '$.preferredSkills[' + missing + ']', 'known-skill');
    const unavailable = installed && values.preferredSkills?.findIndex(skill => !installed.skills.has(skill));
    if (unavailable !== undefined && unavailable >= 0) {
      return reject(source, '$.preferredSkills[' + unavailable + ']', 'available-skill');
    }
  }

  const effective = { ...defaults, ...user.resources };
  for (const key of /** @type {(keyof ResourceConfig)[]} */ (Object.keys(defaults))) {
    const reduced = project.value.resources?.[key];
    if (reduced !== undefined && reduced > effective[key]) {
      return reject('project', '$.resources.' + key, 'no-increase');
    }
    effective[key] = launch.value.resources?.[key] ?? reduced ?? effective[key];
  }

  return { kind: 'accepted', value: {
    ...user, resources: effective, context: {
      ...defaultContextBudgets,
      ...(user.context?.handoffMaxBytes === undefined ? {} : { handoffMaxBytes: user.context.handoffMaxBytes }),
      ...(user.context?.fetchMaxBytes === undefined ? {} : { fetchMaxBytes: user.context.fetchMaxBytes }),
      ...(user.context?.captureMaxBytes === undefined ? {} : { captureMaxBytes: user.context.captureMaxBytes }),
      ...(user.context?.skillInstructionsMaxBytes === undefined ? {} : { skillInstructionsMaxBytes: user.context.skillInstructionsMaxBytes }),
      ...(user.context?.toolOutputMaxBytes === undefined ? {} : { toolOutputMaxBytes: user.context.toolOutputMaxBytes }),
      controllerMaxBytes: user.context?.controllerMaxBytes ?? user.context?.maxBytes ?? defaultContextBudgets.controllerMaxBytes,
    },
    controllerProfile: launch.value.controllerProfile ?? project.value.controllerProfile ?? user.controllerProfile,
    preferredRole: launch.value.preferredRole ?? project.value.preferredRole,
    preferredSkills: [...new Set(launch.value.preferredSkills ?? project.value.preferredSkills ?? [])],
  } };
}
