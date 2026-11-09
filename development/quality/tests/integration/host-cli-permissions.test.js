import assert from 'node:assert/strict';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { cliPermissions } from '../../../../src/hosts/cli-permissions.js';
import { createAuthorityGrant, createPermissionBroker } from '../../../../src/main/index.js';

const input = {
  providerRequestId: 'tool-request', resource: 'fs:/example',
  action: { source: 'provider_reported', title: 'Read', locations: [{ path: '/example' }] },
  options: [{ id: 'read', kind: 'allow' }, { id: 'reject', kind: 'deny' }],
};

for (const answer of ['deny', 'eof', 'interrupt', 'cancel', 'noninteractive', 'standing']) {
  test('CLI permission ' + answer, async () => {
    const stdin = new PassThrough();
    const stderr = new PassThrough();
    const seen = [];
    stderr.on('data', chunk => seen.push(chunk.toString()));
    const stop = new AbortController();
    const authority = createAuthorityGrant({ reference: 'test', origin: 'user', profileIds: ['primary'] });
    const broker = createPermissionBroker({
      authority, ids: { newId: () => 'prompt' },
      handleRequest: cliPermissions(stdin, stderr, answer !== 'noninteractive', () => stop.abort()),
      ...(answer === 'standing' && { standing: [{ profileId: 'primary', resource: input.resource, optionId: 'read', kind: 'allow' }] }),
    });
    const bound = broker.bind({ attemptId: 'test', authorityRef: 'test', profileId: 'primary', signal: stop.signal });
    const prompted = once(stderr, 'data');
    const result = bound.request(input);
    const duplicate = bound.request(input);
    if (answer !== 'standing') await prompted;
    if (answer === 'deny') stdin.write('reject\nread\n');
    if (answer === 'eof') stdin.end();
    if (answer === 'interrupt') stdin.write('\x03');
    if (answer === 'cancel') stop.abort();
    const expected = {
      deny: { kind: 'selected', option: 'reject' }, eof: { kind: 'unavailable' },
      interrupt: { kind: 'cancelled' }, cancel: { kind: 'cancelled' },
      noninteractive: { kind: 'unavailable' }, standing: { kind: 'selected', option: 'read' },
    }[answer];
    assert.deepEqual(await result, expected);
    assert.deepEqual(await duplicate, expected);
    assert.equal(seen.join('').split('Permission requested').length - 1,
      answer === 'noninteractive' || answer === 'standing' ? 0 : 1);
    bound.close();
  });
}
