/**
 * Current trusted environment values only. Missing references are not a
 * reason to block diagnostic projection; historical values are not retained.
 * @param {import('../application/configuration/decode-config.js').Configuration['providers']} providers
 */
export function knownConfigurationSecrets(providers) {
  const references = Object.values(providers).flatMap(provider => Object.values(provider.launch?.env ?? {}));
  const secrets = references.flatMap(ref => {
    const value = process.env[ref.fromEnv];
    return value && value.length >= 4 ? [value] : [];
  });
  /** @type {'available_current_values' | 'partial_current_values' | 'unavailable'} */
  const knownValueMasking = !secrets.length ? 'unavailable'
    : secrets.length < references.length ? 'partial_current_values' : 'available_current_values';
  return { secrets, knownValueMasking };
}
