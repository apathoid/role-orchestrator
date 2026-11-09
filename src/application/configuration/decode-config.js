/** @import {ErrorObject, ValidateFunction} from 'ajv' */

/**
 * @typedef {{adapter: string, launch?: {command: string, args?: string[], env?: Record<string, {fromEnv: string}>},
 *   nativeSettings?: Record<string, unknown>, mcpBridge?: boolean}} ProviderConfig
 * @typedef {{maxConcurrentInvocations?: number, maxInvocationsPerOperation?: number, invocationTimeoutMs?: number}} ResourceConfig
 * @typedef {{
 *   schemaVersion: 1,
 *   providers: Record<string, ProviderConfig>,
 *   profiles: Record<string, {provider: string, model: string}>,
 *   controllerProfile: string,
 *   roles?: Record<string, {purpose?: string, instructions: string, preferredProfiles?: string[]}>,
 *   resources?: ResourceConfig,
 *   context?: {maxBytes?: number},
 *   storage?: {directory: string, artifactRetention?: import('../../core/ports.js').ArtifactRetention},
 *   diagnostics?: {level?: 'debug' | 'info' | 'warn' | 'error', maxFileBytes?: number, retainedFiles?: number, captureBodies?: boolean},
 *   plugins?: {id: string, module: string, enabled?: boolean}[],
 *   skills?: {id: string, source: string}[],
 *   tools?: {id: string}[]
 * }} Configuration
 * @typedef {{kind: 'rejected', reason: {code: 'INVALID_CONFIGURATION', path: string, constraint: string}}} ConfigRejection
 */

/** @type {Promise<ValidateFunction<Configuration>> | undefined} */
let validator;

/** @param {string} path @param {string} constraint @returns {ConfigRejection} */
function reject(path, constraint) {
  return { kind: 'rejected', reason: { code: 'INVALID_CONFIGURATION', path, constraint } };
}

/** @param {string} key */
const escapePointer = key => key.replaceAll('~', '~0').replaceAll('/', '~1');

/** @param {ErrorObject} error */
function report(error) {
  const field = error.keyword === 'additionalProperties' ? error.params.additionalProperty
    : error.keyword === 'required' ? error.params.missingProperty : undefined;
  const path = typeof field === 'string' ? error.instancePath + '/' + escapePointer(field) : error.instancePath;
  return reject(path, error.keyword);
}

async function makeValidator() {
  const [{ Ajv }, { default: schema }] = await Promise.all([
    import('ajv'), import('./config-v1.schema.json', { with: { type: 'json' } }),
  ]);
  // The bundled schema is trusted. Validate incoming JSON without coercion,
  // default mutation, remote schemas or inclusion of input values in errors.
  const validate = new Ajv({ strict: true, ownProperties: true }).compile(schema);
  return /** @type {ValidateFunction<Configuration>} */ (validate);
}

/**
 * Parse trusted-source configuration text. The caller decides which source is
 * trusted. The return value and field errors do not assign permissions.
 * @param {string} input
 * @returns {Promise<{kind: 'accepted', value: Configuration} | ConfigRejection>}
 */
export async function decodeConfiguration(input) {
  /** @type {unknown} */
  let config;
  try { config = JSON.parse(input); }
  catch { return reject('', 'json'); }
  const validate = await (validator ??= makeValidator());
  if (!validate(config)) {
    return validate.errors?.[0] ? report(validate.errors[0]) : reject('', 'schema');
  }

  if (!Object.hasOwn(config.profiles, config.controllerProfile)) {
    return reject('/controllerProfile', 'known-profile');
  }
  for (const [id, profile] of Object.entries(config.profiles)) {
    if (!Object.hasOwn(config.providers, profile.provider)) {
      return reject('/profiles/' + escapePointer(id) + '/provider', 'known-provider');
    }
  }
  for (const [id, role] of Object.entries(config.roles ?? {})) {
    const missing = role.preferredProfiles?.findIndex(profile => !Object.hasOwn(config.profiles, profile));
    if (missing !== undefined && missing >= 0) {
      return reject('/roles/' + escapePointer(id) + '/preferredProfiles/' + missing, 'known-profile');
    }
  }
  return { kind: 'accepted', value: config };
}
