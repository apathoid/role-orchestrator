import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeConfiguration } from '../../src/application/configuration/decode-config.js';
import { createCatalog } from '../../src/application/configuration/catalog.js';

const config = () => ({
  schemaVersion: 1, controllerProfile: 'primary',
  providers: {
    p: { adapter: 'acp', featureBindings: {
      reasoningEffort: { kind: 'configOption', id: 'arbitrary-thought-id' },
      approvalMode: { kind: 'sessionMode' },
    } },
    q: { adapter: 'fixture', featureBindings: { approvalMode: { kind: 'configOption', id: 'different-id' } } },
  },
  features: {
    reasoningEffort: { common: { default: 'medium', options: [
      { id: 'native' }, { id: 'medium', nativeValue: 'normal' },
      { id: 'high', nativeValue: 'deep' }, { id: 'alias', nativeValue: 'deep' },
    ] } },
    approvalMode: {
      first: { default: 'review', options: [{ id: 'native' }, { id: 'review', nativeValue: 'ask' }] },
      second: { default: 'review', options: [{ id: 'review', nativeValue: 'confirm' }] },
    },
  },
  profiles: {
    primary: { provider: 'p', model: 'one', features: { reasoningEffort: 'common', approvalMode: 'first' } },
    worker: { provider: 'q', model: 'two', features: { reasoningEffort: 'common', approvalMode: 'second' } },
    plain: { provider: 'q', model: 'three' },
  },
});
const decode = value => decodeConfiguration(JSON.stringify(value));

test('C24 trusted reusable feature templates expose logical reasoning and keep native mappings private', async () => {
  const parsed = await decode(config());
  assert.equal(parsed.kind, 'accepted', JSON.stringify(parsed));
  const catalog = createCatalog(parsed.value);
  for (const profileId of ['primary', 'worker']) {
    assert.equal(catalog.selectReasoning(profileId).selection.nativeValue, 'normal');
    assert.equal(catalog.selectReasoning(profileId, 'alias').selection.nativeValue, 'deep');
    const native = catalog.selectReasoning(profileId, 'native');
    assert.equal(native.kind, 'selected');
    assert.equal(native.selection.mode, 'native');
    assert.equal(native.selection.level, 'native');
    assert.equal(native.selection.selectionSource, 'model');
    assert.deepEqual((await catalog.resolve('profile', profileId)).value.reasoning.levels,
      ['alias', 'high', 'medium', 'native']);
  }
  assert.equal(catalog.selectReasoning('plain', 'native').kind, 'rejected');
  assert.deepEqual(catalog.selectReasoning('plain').selection, { mode: 'native' });
  const visible = JSON.stringify(await catalog.list());
  assert.ok(!visible.includes('arbitrary-thought-id') && !visible.includes('deep') && !visible.includes('confirm'));
});

test('C24 invalid feature declarations and references have local exact paths; old schema is rejected', async () => {
  const cases = [
    [v => v.features.extra = {}, '/features/extra'],
    [v => v.profiles.primary.features.reasoningEffort = 'missing', '/profiles/primary/features/reasoningEffort'],
    [v => v.features.reasoningEffort.common.default = 'absent', '/features/reasoningEffort/common/default'],
    [v => v.features.reasoningEffort.common.options.push({ id: 'medium', nativeValue: 'other' }), '/features/reasoningEffort/common/options/4/id'],
    [v => v.features.reasoningEffort.common.options[0].nativeValue = 'native', '/features/reasoningEffort/common/options/0/nativeValue'],
    [v => delete v.features.reasoningEffort.common.options[1].nativeValue, '/features/reasoningEffort/common/options/1/nativeValue'],
    [v => v.providers.p.featureBindings.reasoningEffort.id = '', '/providers/p/featureBindings/reasoningEffort/id'],
    [v => v.providers.p.featureBindings.approvalMode={kind:'configOption',id:'arbitrary-thought-id'}, '/providers/p/featureBindings/approvalMode'],
    [v => v.providers.p.featureBindings.approvalMode={kind:'configOption',id:'approval',optionType:'boolean'}, '/features/approvalMode/first/options/1/nativeValue'],
    [v => v.profiles.primary.reasoningEffort = 'native', '/profiles/primary/reasoningEffort'],
  ];
  for (const [change, path] of cases) {
    const value = config(); change(value);
    const result = await decode(value);
    assert.equal(result.kind, 'rejected', path);
    assert.equal(result.reason.path, path, JSON.stringify(result));
  }
});
