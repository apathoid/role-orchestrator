import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCatalog } from '../../../../src/application/configuration/catalog.js';
import { decodeConfiguration } from '../../../../src/application/configuration/decode-config.js';
import { resolveConfiguration } from '../../../../src/application/configuration/resolve-config.js';

const base = {schemaVersion: 1, providers: {p: {adapter: 'cli'}}, controllerProfile: 'single',
  profiles: {single: {provider: 'p', model: 'model'}}};
const decode = profiles => decodeConfiguration(JSON.stringify({...base,profiles}));

test('C11R.2 legacy omissions and explicit native have identical effective choice', async () => {
  const legacy = (await decode(base.profiles)).value;
  const native = (await decode({single: {...base.profiles.single, reasoningEffort: 'native'}})).value;
  assert.deepEqual(createCatalog(legacy).selectReasoning('single'), createCatalog(native).selectReasoning('single'));
  assert.deepEqual((await createCatalog(legacy).resolve('profile', 'single')).value.reasoning, {mode:'native'});
  assert.equal(createCatalog(native).selectReasoning('single', 'high').kind, 'rejected');
});

test('C11R.2 trusted mapping is opaque, per-model and not exposed by catalog', async () => {
  const profiles = {
    single: {provider:'p', model:'a', reasoningEffort: [
      {level:'xhigh',effort:'ultra'}, {level:'medium',effort:'med'},
    ], defaultReasoningLevel:'medium'},
    other: {provider:'p',model:'b',reasoningEffort:[{level:'xhigh',effort:'high'}]},
  };
  const config = (await decode(profiles)).value;
  const catalog = createCatalog(config);
  const original = catalog.selectReasoning('single','xhigh');
  profiles.single.reasoningEffort[0].effort = 'mutated';
  assert.equal(original.selection.nativeValue,'ultra');
  assert.equal(catalog.selectReasoning('single','xhigh').selection.nativeValue,'ultra');
  assert.equal(catalog.selectReasoning('other','xhigh').selection.nativeValue,'high');
  assert.deepEqual(catalog.selectReasoning('single').selection, {
    mode:'selectable',level:'medium',nativeValue:'med',selectionSource:'default'});
  assert.deepEqual((await catalog.resolve('profile','single')).value.reasoning, {
    mode:'selectable', levels:['medium','xhigh'],defaultLevel:'medium',
    capability: {support:'unknown',source:'configured'}});
  assert.ok(!JSON.stringify(await catalog.list()).includes('ultra'));
  assert.deepEqual(catalog.selectReasoning('single','unknown').availableLevels,['medium','xhigh']);
  assert.equal(resolveConfiguration(config, JSON.stringify({schemaVersion:1,profiles})).kind,'rejected');
});

test('C11R.2 schema and reference validation return paths without leaking effort values', async () => {
  const good = {provider:'p',model:'a'};
  const issues = [
    [{...good,reasoningEffort:null}, '/profiles/single/reasoningEffort'],
    [{...good,reasoningEffort:[]}, '/profiles/single/reasoningEffort'],
    [{...good,reasoningEffort:'high'}, '/profiles/single/reasoningEffort'],
    [{...good,reasoningEffort:'native',defaultReasoningLevel:'high'}, '/profiles/single/defaultReasoningLevel'],
    [{...good,reasoningEffort:[{level:'high',effort:'hi'},{level:'high',effort:'h2'}],defaultReasoningLevel:'high'},
      '/profiles/single/reasoningEffort/1/level'],
    [{...good,reasoningEffort:[{level:'high',effort:'hi'},{level:'low',effort:'lo'}]},
      '/profiles/single/defaultReasoningLevel'],
    [{...good,reasoningEffort:[{level:'high',effort:'hi'}],defaultReasoningLevel:'low'},
      '/profiles/single/defaultReasoningLevel'],
    [{...good,reasoningEffort:[{level:'',effort:'hi'}]},'/profiles/single/reasoningEffort/0/level'],
    [{...good,reasoningEffort:[{level:'high',effort:''}]},'/profiles/single/reasoningEffort/0/effort'],
  ];
  for (const [profile,path] of issues) {
    const result = await decode({single:profile});
    assert.equal(result.kind,'rejected',JSON.stringify(result));
    assert.equal(result.reason.path,path,JSON.stringify(result));
  }
});
