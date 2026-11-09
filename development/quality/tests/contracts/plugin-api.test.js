import assert from 'node:assert/strict';
import { test } from 'node:test';
import { duplicateExtensionIds, validatePlugin, validateProvider } from '../../../../src/main/plugin-api.js';

const manifest = { id: 'example', version: '1.0.0', apiVersion: 1, exports: ['createProvider'] };

test('plugin API rejects unknown major and missing declared exports', () => {
  assert.throws(() => validatePlugin({ manifest: { ...manifest, apiVersion: 2 } }, 'example'),
    { code: 'UNSUPPORTED_PLUGIN_API', path: 'manifest.apiVersion' });
  assert.throws(() => validatePlugin({ manifest }, 'example'),
    { code: 'INVALID_PLUGIN', path: 'createProvider' });
  assert.equal(validatePlugin({ manifest, createProvider() {} }, 'example').manifest.version, '1.0.0');
});

test('duplicate extension ids are identified regardless of position', () => {
  assert.deepEqual([...duplicateExtensionIds([{ id: 'one' }, { id: 'two' }, { id: 'one' }])], ['one']);
});

test('factory return must implement ProviderPort and describe the configured provider', async () => {
  await assert.rejects(validateProvider({}, 'example'), { code: 'INVALID_PROVIDER', path: 'createProvider.describe' });
  const provider = {
    async describe() { return { providerId: 'different', maxConcurrency: null, capabilities: {} }; },
    async open() {}, async invoke() {}, async cancel() {}, async close() {},
  };
  await assert.rejects(validateProvider(provider, 'example'), { code: 'INVALID_PROVIDER', path: 'describe' });
  assert.equal((await validateProvider(provider, 'different')).provider, provider);
});
