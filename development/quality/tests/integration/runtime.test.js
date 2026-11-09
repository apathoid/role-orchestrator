import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { openRuntime } from '../../../../src/main/runtime.js';
import { withOwnedRun } from '../../scripts/owned-run.mjs';

test('startup failure unwinds acquired plugin and store; startup never opens a model session', () =>
  withOwnedRun('C10-runtime', async directory => {
    const marker = join(directory, 'lifecycle');
    const module = join(directory, 'fixture.mjs');
    await writeFile(module, `
      import { appendFile } from 'node:fs/promises';
      const mark = text => appendFile(${JSON.stringify(marker)}, text);
      export const manifest = { id: 'test', version: '1', apiVersion: 1, exports: ['createProvider'] };
      export async function createProvider({providerId, onClose}) {
        await mark('create\\n');
        onClose(() => mark('close\\n'));
        return {
          describe: async () => ({ providerId, maxConcurrency: null, capabilities: {} }),
          open: () => mark('open\\n'), invoke() {}, cancel() {}, close() {},
        };
      }
    `);
    const configuration = JSON.stringify({
      schemaVersion: 1, controllerProfile: 'primary', profiles: { primary: { provider: 'test', model: 'fixture' } },
      providers: { test: { adapter: 'test' } }, plugins: [{ id: 'test', module }],
      storage: { directory: join(directory, 'state') },
    });
    await assert.rejects(openRuntime({ configuration, launch: { controllerProfile: 'missing' } }),
      { code: 'INVALID_CONFIGURATION', path: '$.controllerProfile' });
    assert.equal(await readFile(marker, 'utf8'), 'create\nclose\n');
    const runtime = await openRuntime({ configuration });
    assert.equal(await readFile(marker, 'utf8'), 'create\nclose\ncreate\n');
    await runtime.close();
    await runtime.close();
    assert.equal(await readFile(marker, 'utf8'), 'create\nclose\ncreate\nclose\n');
  }));
