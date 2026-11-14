import { decodeOutcome } from '../core/contracts.js';

/** @import {Attempt, Operation} from '../core/operation.js' */
/** @import {AuthorityPort, Catalog, Profile, ProviderPort, ProviderResult} from '../core/ports.js' */
/** @typedef {'unavailable' | 'unsupported' | 'unresolved' | 'reported'} LookupStatus */
/** @typedef {{status: LookupStatus, result?: Pick<ProviderResult, 'outcome' | 'dispatchCertainty'>}} Lookup */

/**
 * A status lookup is read-only and uses the original endpoint only when its
 * trusted configuration and route still match and the current grant allows it.
 * @param {Operation} state @param {Attempt} attempt
 * @param {{configurationRef: string, authority: AuthorityPort, catalog: Catalog,
 *   providerFor: (profile: Profile) => ProviderPort | undefined}} current
 * @param {AbortSignal} signal @returns {Promise<Lookup>}
 */
export async function lookupAttempt(state, attempt, current, signal) {
  const route = attempt.route;
  if (!route || route.configurationRef !== current.configurationRef) return { status: 'unavailable' };
  const entry = (await current.catalog.list()).find(item => item.kind === 'profile' &&
    item.value.profileId === route.profileId && item.value.providerId === route.providerId && item.value.model === route.model);
  if (entry?.kind !== 'profile') return { status: 'unavailable' };
  signal.throwIfAborted();
  const provider = current.providerFor(entry.value);
  if (!provider || current.authority.authorize(state.authorityRef, route.profileId) !== 'ALLOWED') return { status: 'unavailable' };
  if (!provider.lookupStatus) return { status: 'unsupported' };
  const description = await provider.describe();
  const capability = description.capabilities['attempt.status'];
  if (description.providerId !== route.providerId || capability?.source !== 'negotiated' ||
      capability.support !== 'supported') return { status: 'unsupported' };
  signal.throwIfAborted();
  if (current.authority.authorize(state.authorityRef, route.profileId) !== 'ALLOWED') return { status: 'unavailable' };

  const reply = await provider.lookupStatus({
    operationId: state.operationId, attemptId: attempt.attemptId, profile: entry.value, signal,
  });
  signal.throwIfAborted();
  if (!reply) return { status: 'unresolved' };
  const parsed = decodeOutcome(reply.outcome);
  if (parsed.kind !== 'accepted' || parsed.value.attemptId !== attempt.attemptId ||
      !['not_sent', 'sent', 'unknown'].includes(reply.dispatchCertainty) ||
      (attempt.dispatchCertainty !== 'unknown' && attempt.dispatchCertainty !== reply.dispatchCertainty) ||
      (reply.dispatchCertainty === 'not_sent' && parsed.value.effect !== 'none')) return { status: 'unavailable' };
  if (parsed.value.terminal === 'unknown') return { status: 'unresolved' };
  return { status: 'reported', result: { outcome: parsed.value, dispatchCertainty: reply.dispatchCertainty } };
}
