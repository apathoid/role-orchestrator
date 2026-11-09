import assert from 'node:assert/strict';
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createCodexProvider, loadExtensions } from '../../../../src/main/index.js';
import { providerContract } from '../../fixtures/provider-contract.js';
import { withOwnedRun } from '../../scripts/owned-run.mjs';

providerContract('configured echo plugin ProviderPort', async run => {
  const configuration = {
    schemaVersion: 1,
    providers: { echo: { adapter: 'fixture-echo' } },
    profiles: { contract: { provider: 'echo', model: 'fixture' } },
    controllerProfile: 'contract',
    plugins: [{ id: 'fixture-echo', module: fileURLToPath(new URL('../../fixtures/echo-plugin.js', import.meta.url)) }],
  };
  const extensions = await loadExtensions(configuration, { clock: { now: Date.now }, ids: { newId: randomUUID } });
  try {
    const { value: profile } = await extensions.catalog.resolve('profile', 'contract');
    assert.equal(profile.capabilities['fixture.echo'].support, 'supported');
    const provider = extensions.providerFor(profile);
    await run({ provider, profile, ready: provider.ready, release: provider.release });
  } finally {
    await extensions.close();
  }
});

providerContract('Codex CLI ProviderPort', run => withOwnedRun('C07-provider-contract', async cwd => {
  const profile = { profileId: 'contract', providerId: 'codex', model: 'fixture' };
  const child = fileURLToPath(new URL('../../fixtures/codex-contract-child.js', import.meta.url));
  const provider = createCodexProvider({
    providerId: profile.providerId,
    configuration: { adapter: 'codex-cli', launch: { command: process.execPath, args: [child] } },
  });
  await run({
    provider, profile, workspaceContext: { cwd },
    async ready(id) {
      const path = join(cwd, id + '.ready');
      const deadline = performance.now() + 5_000;
      while (performance.now() < deadline) {
        try {
          await access(path);
          return;
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          await sleep(10);
        }
      }
      assert.fail('child did not signal readiness for ' + id);
    },
    release(id) { return writeFile(join(cwd, id + '.release'), ''); },
  });
}), { skip: process.platform !== 'linux' });
