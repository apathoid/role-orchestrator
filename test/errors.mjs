import assert from 'node:assert/strict';
import { safeUpstreamErrorData, upstreamErrorDiagnostic } from '../src/errors.mjs';

assert.equal(
  upstreamErrorDiagnostic({ message: 'Internal error', data: { details: 'Available provider tokens are exhausted until reset.' } }),
  'Internal error: Available provider tokens are exhausted until reset.',
);

assert.match(
  upstreamErrorDiagnostic(
    { message: 'Internal error', data: { codexErrorInfo: 'usageLimitExceeded', additionalDetails: 'Try again at 18:45 UTC.' } },
    'You’ve hit your usage limit.',
  ),
  /You’ve hit your usage limit.*Try again at 18:45 UTC.*usageLimitExceeded|You’ve hit your usage limit.*usageLimitExceeded.*Try again at 18:45 UTC/,
);

assert.equal(
  upstreamErrorDiagnostic({ message: 'Authentication required' }),
  'Authentication required',
);

const cyclic = { details: 'Useful failure detail' };
cyclic.self = cyclic;
assert.match(upstreamErrorDiagnostic({ message: 'Internal error', data: cyclic }), /Useful failure detail/);


const redactedUnknown = new Error('Internal error');
redactedUnknown.data = {
  details: 'Available provider tokens are exhausted until the quota resets.',
  access_token: 'must-not-leak',
  arbitrarySecretPayload: 'also-must-not-leak',
};
const redactedDiagnostic = upstreamErrorDiagnostic(redactedUnknown);
assert.match(redactedDiagnostic, /Available provider tokens are exhausted/i);
assert.doesNotMatch(redactedDiagnostic, /must-not-leak/);
assert.deepEqual(safeUpstreamErrorData(redactedUnknown.data), {
  details: 'Available provider tokens are exhausted until the quota resets.',
});

console.log('errors: passed');
