import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCatalog } from '../../src/application/configuration/catalog.js';
import { decodeConfiguration } from '../../src/application/configuration/decode-config.js';
import { resolveConfiguration } from '../../src/application/configuration/resolve-config.js';

const base = {schemaVersion: 1, providers: {p: {adapter: 'cli'}}, controllerProfile: 'single',
  profiles: {single: {provider: 'p', model: 'model'}}};
const decode = config => decodeConfiguration(JSON.stringify(config));
const withTemplate = (options, defaultLevel) => ({...base, features:{reasoningEffort:{shared:{default:defaultLevel,options}}},
  profiles:{single:{...base.profiles.single,features:{reasoningEffort:'shared'}}}});

test('C11R.2 omission and explicitly declared native both avoid native override', async () => {
  const legacy = (await decode(base)).value;
  const native = (await decode(withTemplate([{id:'native'}], 'native'))).value;
  assert.deepEqual(createCatalog(legacy).selectReasoning('single').selection, {mode:'native'});
  assert.deepEqual(createCatalog(native).selectReasoning('single').selection, {mode:'native',level:'native',selectionSource:'default'});
  assert.deepEqual((await createCatalog(legacy).resolve('profile', 'single')).value.reasoning, {mode:'native'});
  assert.equal(createCatalog(native).selectReasoning('single', 'high').kind, 'rejected');
});

test('C11R.2 trusted mapping is opaque, per-model and not exposed by catalog', async () => {
  const input = {...base, features:{reasoningEffort:{
    one:{default:'medium',options:[{id:'xhigh',nativeValue:'ultra'},{id:'medium',nativeValue:'med'}]},
    two:{default:'xhigh',options:[{id:'xhigh',nativeValue:'high'}]},
  }}, profiles:{
    single:{provider:'p',model:'a',features:{reasoningEffort:'one'}},
    other:{provider:'p',model:'b',features:{reasoningEffort:'two'}},
  }};
  const config = (await decode(input)).value;
  const catalog = createCatalog(config);
  const original = catalog.selectReasoning('single','xhigh');
  config.features.reasoningEffort.one.options[0].nativeValue = 'mutated';
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
  assert.equal(resolveConfiguration(config, JSON.stringify({schemaVersion:1,profiles:input.profiles})).kind,'rejected');
  assert.equal(resolveConfiguration(config, JSON.stringify({schemaVersion:1,features:input.features})).kind,'rejected');
});

test('C11R.2 schema and reference validation return paths without leaking effort values', async () => {
  const prefix = '/features/reasoningEffort/shared';
  const issues = [
    [withTemplate(null,'high'),prefix+'/options'],
    [withTemplate([],'high'),prefix+'/options'],
    [withTemplate([{id:'native',nativeValue:'high'}],'native'),prefix+'/options/0/nativeValue'],
    [withTemplate([{id:'high',nativeValue:'hi'},{id:'high',nativeValue:'h2'}],'high'),prefix+'/options/1/id'],
    [withTemplate([{id:'high',nativeValue:'hi'},{id:'low',nativeValue:'lo'}],undefined),prefix+'/default'],
    [withTemplate([{id:'high',nativeValue:'hi'}],'low'),prefix+'/default'],
    [withTemplate([{id:'',nativeValue:'hi'}],'high'),prefix+'/options/0/id'],
    [withTemplate([{id:'high',nativeValue:''}],'high'),prefix+'/options/0/nativeValue'],
    [withTemplate([{id:'high',nativeValue:true}],'high'),prefix+'/options/0/nativeValue'],
  ];
  for (const [input,path] of issues) {
    const result = await decode(input);
    assert.equal(result.kind,'rejected',JSON.stringify(result));
    assert.equal(result.reason.path,path,JSON.stringify(result));
  }
});
