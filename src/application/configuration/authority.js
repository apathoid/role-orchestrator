/** @import {AuthorityPort} from '../../core/ports.js' */

/**
 * Construct a grant from trusted host inputs. Profile scopes apply to calls the
 * Host dispatches, and the adapter owns its native tool permissions.
 * @param {{reference: string, origin: 'user' | 'provider', profileIds: readonly string[]}} grant
 * @returns {AuthorityPort & {origin: 'user' | 'provider', revoke: () => void}}
 */
export function createAuthorityGrant(grant) {
  const { reference, origin } = grant;
  if (!reference.trim()) throw new TypeError('Authority reference is required');
  const permitted = new Set(grant.profileIds);
  let revoked = false;
  return Object.freeze({
    reference,
    origin,
    authorize(referenceToCheck, profileId) {
      if (referenceToCheck !== reference) return 'PERMISSION_DENIED';
      if (revoked) return 'REVOKED';
      return permitted.has(profileId) ? 'ALLOWED' : 'PERMISSION_DENIED';
    },
    revoke() { revoked = true; },
  });
}
