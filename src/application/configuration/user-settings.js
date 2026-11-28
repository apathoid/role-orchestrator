/** @import {Configuration,FeatureKind} from './decode-config.js' */
/** @import {UserSettings} from '../../core/contracts.js' */
/** @import {NativeSetting, Catalog, Profile, ProviderPort, AuthorityPort} from '../../core/ports.js' */

/** @type {readonly FeatureKind[]} */
export const featureKinds = Object.freeze(['reasoningEffort','collaborationMode','approvalMode']);
/** @typedef {{id:string,name:string,description?:string}} SettingOption */
/** @typedef {{current?:string,options:SettingOption[],unavailable?:string}} SettingDescriptor */
/** @typedef {{controllerProfile:SettingDescriptor,reasoningEffort?:SettingDescriptor,collaborationMode?:SettingDescriptor,approvalMode?:SettingDescriptor,overrides:UserSettings}} UserSettingsView */

/** @param {Configuration} config @param {string} profileId @param {FeatureKind} kind */
export function featureTemplate(config, profileId, kind) {
  if (!Object.hasOwn(config.profiles,profileId)) return undefined;
  const name=config.profiles[profileId].features?.[kind];
  const templates=config.features?.[kind];
  return name!==undefined && templates && Object.hasOwn(templates,name) ? templates[name] : undefined;
}

/** @param {Configuration} config @param {string} profileId @param {FeatureKind} kind
 * @param {string} logicalId @param {NativeSetting['source']} source @returns {NativeSetting|undefined}
 */
export function featureSelection(config,profileId,kind,logicalId,source) {
  const option=featureTemplate(config,profileId,kind)?.options.find(item=>item.id===logicalId);
  if (!option) return undefined;
  const provider=config.providers[config.profiles[profileId].provider];
  const binding=option.nativeValue===undefined?undefined:provider.featureBindings?.[kind];
  return {id:option.id,source,...(option.nativeValue!==undefined&&{nativeValue:option.nativeValue}),
    ...(binding&&{binding:structuredClone(binding)})};
}

/** Resolve the three explicitly known logical preferences. Only inherited
 * choices may reset when a new profile does not declare the same logical ID.
 * @param {Configuration} config @param {string} profileId @param {UserSettings} [explicit] @param {UserSettings} [inherited]
 */
export function resolveFeatureChoices(config,profileId,explicit={},inherited={}) {
  /** @type {UserSettings} */
  const overrides={};
  /** @type {Partial<Record<FeatureKind,NativeSetting>>} */
  const choices={};
  for(const kind of featureKinds) {
    const template=featureTemplate(config,profileId,kind);
    const requested=explicit[kind];
    const retained=inherited[kind];
    const validRetained=retained!==undefined&&template?.options.some(item=>item.id===retained)?retained:undefined;
    const override=requested??validRetained;
    if(requested!==undefined&&!template?.options.some(item=>item.id===requested)) {
      return {kind:/** @type {const} */('rejected'),path:'/userSettings/'+kind};
    }
    const selected=override??template?.default;
    if(selected===undefined)continue;
    if(override!==undefined)overrides[kind]=override;
    const value=featureSelection(config,profileId,kind,selected,override===undefined?'default':'user');
    if(value)choices[kind]=value;
  }
  return {kind:/** @type {const} */('selected'),overrides,choices};
}

/** @param {ProviderPort|undefined} provider @param {FeatureKind} kind */
function supports(provider,kind) {
  return kind==='reasoningEffort'?provider?.supportsReasoningSelection===true:
    kind==='collaborationMode'?provider?.supportsCollaborationMode===true:provider?.supportsApprovalMode===true;
}

/** Same logical descriptors for any client, without opening native sessions.
 * @param {Configuration} config @param {Catalog} catalog @param {AuthorityPort} authority
 * @param {(profile:Profile)=>ProviderPort|undefined} providerFor @param {string} [selectedProfile] @param {UserSettings} [overrides]
 * @returns {Promise<UserSettingsView>}
 */
export async function describeUserSettings(config,catalog,authority,providerFor,selectedProfile,overrides={}) {
  const entries=await catalog.list();
  const profiles=entries.flatMap(entry=>entry.kind==='profile'&&!entry.value.unavailable&&providerFor(entry.value)&&
    authority.authorize(authority.reference,entry.value.profileId)==='ALLOWED'?[entry.value]:[]);
  const requested=selectedProfile??config.controllerProfile;
  const profile=profiles.find(item=>item.profileId===requested);
  /** @type {UserSettingsView} */
  const view={controllerProfile:{current:profile?.profileId,options:profiles.map(item=>({id:item.profileId,name:item.profileId})),
    ...(!profile&&{unavailable:requested})},overrides:{}};
  if(!profile)return view;
  const resolved=resolveFeatureChoices(config,profile.profileId,{},overrides);
  if(resolved.kind!=='selected')return view;
  view.overrides=resolved.overrides;
  const provider=providerFor(profile);
  for(const kind of featureKinds) {
    const template=featureTemplate(config,profile.profileId,kind);
    const current=resolved.choices[kind]?.id;
    if(!template||current===undefined)continue;
    const supported=supports(provider,kind);
    const available=template.options.filter(item=>supported||item.nativeValue===undefined);
    view[kind]={current,...(!supported&&resolved.choices[kind]?.nativeValue!==undefined&&{unavailable:current}),options:available.map(item=>({id:item.id,name:item.name??item.id,
      ...(item.description!==undefined&&{description:item.description})}))};
  }
  return view;
}

/** Only the declared Controller logical approval choice is propagated. An
 * absent Worker mapping is not a Worker default or a selection gate.
 * @param {Configuration} config @param {string} profileId @param {NativeSetting|undefined} approval
 */
export function workerApproval(config,profileId,approval) {
  return approval?featureSelection(config,profileId,'approvalMode',approval.id,approval.source):undefined;
}
