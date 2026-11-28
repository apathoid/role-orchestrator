/** @import {ErrorObject, ValidateFunction} from 'ajv' */

/**
 * @typedef {'reasoningEffort'|'collaborationMode'|'approvalMode'} FeatureKind
 * @typedef {{id:string,nativeValue?:string|boolean,name?:string,description?:string}} FeatureOption
 * @typedef {{default:string,options:FeatureOption[]}} FeatureTemplate
 * @typedef {{kind:string,id?:string,optionType?:'select'|'boolean'} & Record<string,unknown>} FeatureBinding
 * @typedef {{adapter: string, featureBindings?: Partial<Record<FeatureKind,FeatureBinding>>, launch?: {command: string, args?: string[], env?: Record<string, {fromEnv: string}>},
 *   nativeSettings?: Record<string, unknown>, mcpBridge?: boolean, controllerIntent?: 'text' | 'prefer_mcp'}} ProviderConfig
 * @typedef {{maxConcurrentInvocations?: number, maxInvocationsPerOperation?: number | null, invocationTimeoutMs?: number | null}} ResourceConfig
 * @typedef {{
 *   schemaVersion: 1,
 *   providers: Record<string, ProviderConfig>,
 *   features?: Partial<Record<FeatureKind,Record<string,FeatureTemplate>>>,
 *   profiles: Record<string, {provider: string, model: string, features?: Partial<Record<FeatureKind,string>>}>,
 *   controllerProfile: string,
 *   roles?: Record<string, {purpose?: string, instructions: string, preferredProfiles?: string[]}>,
 *   resources?: ResourceConfig,
 *   input?: {maxBytes?:number},
 *   context?: {maxBytes?: number, controllerMaxBytes?: number, handoffMaxBytes?: number, fetchMaxBytes?: number,
 *     captureMaxBytes?: number, skillInstructionsMaxBytes?: number, toolOutputMaxBytes?: number},
 *   storage?: {directory: string, artifactRetention?: import('../../core/ports.js').ArtifactRetention},
 *   diagnostics?: {level?: 'debug' | 'info' | 'warn' | 'error', maxFileBytes?: number, retainedFiles?: number, captureBodies?: boolean, promptCaptureMaxBytes?: number},
 *   permissions?: {standing?: import('./permissions.js').StandingDecision[]},
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
    // For union fields, prefer the specific array element failure to the
    // generic "not native" branch. Keep values (including secrets) out of errors.
    const failures = validate.errors ?? [];
    const specific = failures.filter(error => error.instancePath.includes('/features/') && !['anyOf','if','not','allOf','type'].includes(error.keyword))
      .sort((left, right) => right.instancePath.length - left.instancePath.length)[0];
    return specific ? report(specific) : failures[0] ? report(failures[0]) : reject('', 'schema');
  }

  if (config.context?.maxBytes !== undefined && config.context.controllerMaxBytes !== undefined) {
    return reject('/context/controllerMaxBytes', 'exclusive-with-maxBytes');
  }
  if (!Object.hasOwn(config.profiles, config.controllerProfile)) {
    return reject('/controllerProfile', 'known-profile');
  }
  /** @type {readonly FeatureKind[]} */
  const featureKinds = ['reasoningEffort','collaborationMode','approvalMode'];
  for (const kind of featureKinds) {
    for (const [name, template] of Object.entries(config.features?.[kind] ?? {})) {
      const path = '/features/' + kind + '/' + escapePointer(name);
      if (!name.trim()) return reject(path, 'nonempty-template-name');
      const ids = new Set();
      for (const [index, option] of template.options.entries()) {
        const at = path + '/options/' + index;
        if (ids.has(option.id)) return reject(at + '/id', 'unique-option-id');
        ids.add(option.id);
        if (option.id === 'native' && option.nativeValue !== undefined) return reject(at + '/nativeValue', 'native-has-no-override');
        if (option.id !== 'native' && option.nativeValue === undefined) return reject(at + '/nativeValue', 'required');
        if (kind === 'reasoningEffort' && option.nativeValue !== undefined && typeof option.nativeValue !== 'string') {
          return reject(at + '/nativeValue', 'reasoning-string-value');
        }
      }
      if (!ids.has(template.default)) return reject(path + '/default', 'known-option');
    }
  }
  for (const [id, provider] of Object.entries(config.providers)) {
    for (const kind of featureKinds) {
      const binding = provider.featureBindings?.[kind];
      if (!binding) continue;
      const path = '/providers/' + escapePointer(id) + '/featureBindings/' + kind;
      if (binding.kind === 'configOption' || binding.kind === 'sessionMode') {
        const allowed = binding.kind === 'configOption' ? ['kind','id','optionType'] : ['kind'];
        const extra = Object.keys(binding).find(key => !allowed.includes(key));
        if (extra !== undefined) return reject(path + '/' + escapePointer(extra), 'unknown-binding-field');
        if (binding.kind === 'configOption' && binding.id === undefined) return reject(path + '/id', 'required');
      }
    }
  }
  for (const [id, profile] of Object.entries(config.profiles)) {
    if (!Object.hasOwn(config.providers, profile.provider)) {
      return reject('/profiles/' + escapePointer(id) + '/provider', 'known-provider');
    }
    for (const kind of featureKinds) {
      const name = profile.features?.[kind];
      if (name !== undefined && !Object.hasOwn(config.features?.[kind] ?? {}, name)) {
        return reject('/profiles/' + escapePointer(id) + '/features/' + kind, 'known-template');
      }
    }
  }
  for (const [id, role] of Object.entries(config.roles ?? {})) {
    const missing = role.preferredProfiles?.findIndex(profile => !Object.hasOwn(config.profiles, profile));
    if (missing !== undefined && missing >= 0) {
      return reject('/roles/' + escapePointer(id) + '/preferredProfiles/' + missing, 'known-profile');
    }
  }
  const standing = new Set();
  for (const [index, rule] of (config.permissions?.standing ?? []).entries()) {
    const path = '/permissions/standing/' + index;
    if (!Object.hasOwn(config.profiles, rule.profileId)) return reject(path + '/profileId', 'known-profile');
    const key = JSON.stringify([rule.profileId, rule.resource]);
    if (standing.has(key)) return reject(path, 'unique-profile-resource');
    standing.add(key);
  }
  return { kind: 'accepted', value: config };
}
