// Shared validation for named profiles and materialized inline role profiles.
// Provider/model capabilities are declarative, not a closed model allow-list:
// providers may accept model IDs not included in their optional metadata catalog.
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const needString = (value, where) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${where} must be a non-empty string.`);
};
const optionalPositiveMs = (value, where) => {
  if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
    throw new Error(`${where} must be a positive integer.`);
  }
};

export function validateProfileDefinition(profile, providers, where) {
  if (!record(profile)) throw new Error(`${where} must be an object.`);
  needString(profile.provider, `${where}.provider`);
  needString(profile.model, `${where}.model`);
  if (!Object.hasOwn(providers ?? {}, profile.provider)) {
    throw new Error(`${where} references unknown provider ${JSON.stringify(profile.provider)}.`);
  }
  if (profile.reasoningEffort !== undefined) needString(profile.reasoningEffort, `${where}.reasoningEffort`);
  optionalPositiveMs(profile.idleTimeoutMs, `${where}.idleTimeoutMs`);
  optionalPositiveMs(profile.turnDeadlineMs, `${where}.turnDeadlineMs`);
  optionalPositiveMs(profile.invocationDeadlineMs, `${where}.invocationDeadlineMs`);
  optionalPositiveMs(profile.preflightTimeoutMs, `${where}.preflightTimeoutMs`);
  optionalPositiveMs(profile.cleanupTimeoutMs, `${where}.cleanupTimeoutMs`);
  optionalPositiveMs(profile.timeoutMs, `${where}.timeoutMs`); // legacy alias
  if (profile.contextWindow !== undefined && (!Number.isInteger(profile.contextWindow) || profile.contextWindow <= 0)) {
    throw new Error(`${where}.contextWindow must be a positive integer.`);
  }
  if (profile.fastMode !== undefined && typeof profile.fastMode !== 'boolean') {
    throw new Error(`${where}.fastMode must be boolean.`);
  }
  if (profile.providerOptions !== undefined && !record(profile.providerOptions)) {
    throw new Error(`${where}.providerOptions must be an object.`);
  }
  return profile;
}
