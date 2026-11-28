import { addAbortListener } from 'node:events';

/** @import {ClientContext, ContentBlock, InitializeResponse, NewSessionResponse, SessionConfigOption} from '@agentclientprotocol/sdk' */
/** @import {Invocation} from '../../core/ports.js' */

/** @typedef {NonNullable<Invocation['attachments']>[number]} Attachment */
/** @typedef {(attachment: Attachment, signal: AbortSignal) => Promise<ContentBlock | undefined>} ResolveAttachment */

/** @param {SessionConfigOption[] | null | undefined} options */
export function modelOption(options) {
  const models = options?.filter(item => item.category === 'model') ?? [];
  return models.length === 1 && models[0].type === 'select' ? models[0] : undefined;
}

/**
 * @param {ClientContext} agent @param {typeof import('@agentclientprotocol/sdk').methods.agent.session} methods
 * @param {NewSessionResponse} session @param {string} model @param {string | undefined} mode @param {AbortSignal} signal @param {(error:unknown)=>boolean} [modeRejected]
 */
export async function configureSession(agent, methods, session, model, mode, signal,modeRejected) {
  const { sessionId } = session;
  const modeChanged = mode !== undefined && mode !== session.modes?.currentModeId;
  if (modeChanged) {
    if (!session.modes?.availableModes.some(item => item.id === mode)) return false;
    try{await agent.request(methods.setMode, { sessionId, modeId: mode }, { cancellationSignal: signal, stopWaitingOnCancel: true });}
    catch(error){if(modeRejected?.(error))return false;throw error;}
  }
  const option = modelOption(session.configOptions);
  if (!option) return false;
  // A legacy set_mode response contains no model state. Confirm the exact
  // model with set_config_option even if the last advertised value matches.
  if (option.currentValue === model && !modeChanged) return true;
  const choices = option.options.flatMap(item => 'options' in item ? item.options : [item]);
  if (!choices.some(item => item.value === model)) return false;
  const response = await agent.request(methods.setConfigOption, { sessionId, configId: option.id, value: model }, { cancellationSignal: signal, stopWaitingOnCancel: true });
  session.configOptions = response.configOptions;
  return true;
}

/** A thought-level selector is useful only if unambiguously advertised. Native
 * mode does not force any provider-level setting.
 * @param {NewSessionResponse['configOptions']} options
 */
export function thoughtOption(options) {
  const levels = options?.filter(item => item.category === 'thought_level') ?? [];
  return levels.length === 1 && levels[0].type === 'select' ? levels[0] : undefined;
}

/**
 * Configure the exact per-session mapped native value and confirm the update
 * before a prompt is allowed to run. No guesses about option ids or values.
 * @param {ClientContext} agent
 * @param {typeof import('@agentclientprotocol/sdk').methods.agent.session} methods
 * @param {NewSessionResponse} session
 * @param {Invocation['reasoning']} reasoning
 * @param {AbortSignal} signal
 * @param {import('../../application/configuration/decode-config.js').FeatureBinding} [binding]
 */
export async function configureReasoning(agent, methods, session, reasoning, signal, binding) {
  if (!reasoning || reasoning.mode === 'native') return true;
  if (binding) return configureBoundOption(agent, methods, session, binding, reasoning.nativeValue, signal);
  const option = thoughtOption(session.configOptions);
  if (!option) return false;
  const candidates = option.options.flatMap(item => 'options' in item ? item.options : [item]);
  if (!candidates.some(item => item.value === reasoning.nativeValue)) return false;
  if (option.currentValue !== reasoning.nativeValue) {
    const changed = await agent.request(methods.setConfigOption, {
      sessionId: session.sessionId, configId: option.id, value: reasoning.nativeValue,
    }, { cancellationSignal: signal, stopWaitingOnCancel: true });
    session.configOptions = changed.configOptions;
  }
  return thoughtOption(session.configOptions)?.currentValue === reasoning.nativeValue;
}

/**
 * @param {Invocation} invocation @param {InitializeResponse['agentCapabilities']} capabilities
 * @param {ResolveAttachment | undefined} resolve @param {AbortSignal} signal @param {(requestId:string,ref:string,reason?:NonNullable<import('../../core/ports.js').ProviderResult['contentUnavailable']>['cause'])=>void} [onOmitted]
 * @param {(turn:import('../../core/ports.js').OrderedTurn,start:number,count:number,refs:{ref:string,block:number}[])=>void} [onDelivered]
 * @param {(issue:NonNullable<import('../../core/ports.js').ProviderResult['contentUnavailable']>)=>void} [onFailure]
 * @param {(ref:string,block:number)=>void} [onAttachmentDelivered] actual index in the prompt including its leading orchestration block
 */
export async function attachmentBlocks(invocation, capabilities, resolve, signal,onOmitted,onDelivered,onFailure,onAttachmentDelivered) {
  /** @type {ContentBlock[]} */
  const blocks = [];
  const orderedRefs=new Set((invocation.orderedTurns??[]).flatMap(turn=>turn.content.flatMap(item=>item.kind==='text'?[]:[item.ref])));
  for(const turn of invocation.orderedTurns??[]){
    /** @type {{ref:string,block:number}[]} */ const refs=[];
    /** @type {import('../../core/ports.js').ProviderResult['contentUnavailable']} */ let failure;
    const ordered=await renderOrderedTurn(turn,invocation.readUserPayload,capabilities,signal,
      turn.required===false?ref=>onOmitted?.(turn.requestId,ref,failure?.ref===ref?failure.cause:undefined):undefined,
      (ref,index)=>refs.push({ref,block:blocks.length+1+index}),issue=>{
        if(turn.required===false)failure=issue;
        else onFailure?.(issue);
      });
    if(!ordered)return undefined;
    onDelivered?.(turn,blocks.length+1,ordered.length,refs);
    blocks.push(...ordered);
  }
  for (const attachment of invocation.attachments ?? []) {
    if(orderedRefs.has(attachment.ref))continue;
    if('kind' in attachment){
      const block=await renderContentAttachment(attachment,invocation.readUserPayload,capabilities,signal,onFailure);
      if(!block)return undefined;
      onAttachmentDelivered?.(attachment.ref,blocks.length+1);
      blocks.push(block);continue;
    }
    signal.throwIfAborted();
    if (!resolve){onFailure?.({ref:attachment.ref,cause:'payload_unavailable'});return undefined;}
    const image = attachment.mediaType.toLowerCase().startsWith('image/');
    if (image && !capabilities?.promptCapabilities?.image){onFailure?.({ref:attachment.ref,cause:'native_modality_unavailable'});return undefined;}
    /** @type {PromiseWithResolvers<never>} */
    const stopped = Promise.withResolvers();
    const listener = addAbortListener(signal, () => stopped.reject(signal.reason));
    const block = await Promise.race([stopped.promise, Promise.resolve().then(() => resolve(attachment, signal))])
      .finally(() => listener[Symbol.dispose]());
    if (!block || (image ? block.type !== 'image' || block.mimeType !== attachment.mediaType :
      block.type !== 'resource_link' && (block.type !== 'resource' || !capabilities?.promptCapabilities?.embeddedContext))) {
      onFailure?.({ref:attachment.ref,cause:!block?'payload_unavailable':!image&&block.type==='resource'&&!capabilities?.promptCapabilities?.embeddedContext?'resource_transport_unavailable':'user_content_not_deliverable'});
      return undefined;
    }
    onAttachmentDelivered?.(attachment.ref,blocks.length+1);
    blocks.push(block);
  }
  return blocks;
}

/** @param {import('../../application/configuration/decode-config.js').FeatureBinding|undefined} binding */
export function supportsBinding(binding) {
  return binding?.kind === 'sessionMode' || (binding?.kind === 'configOption' && typeof binding.id === 'string');
}

/** @param {NewSessionResponse} session @param {import('../../application/configuration/decode-config.js').FeatureBinding} binding */
export function boundOption(session,binding) {
  const options=session.configOptions?.filter(item=>item.id===binding.id&&item.type===(binding.optionType??'select'))??[];
  return options.length===1?options[0]:undefined;
}

/** @param {ClientContext} agent @param {typeof import('@agentclientprotocol/sdk').methods.agent.session} methods
 * @param {NewSessionResponse} session @param {import('../../application/configuration/decode-config.js').FeatureBinding} binding
 * @param {string|boolean} value @param {AbortSignal} signal
 */
export async function configureBoundOption(agent,methods,session,binding,value,signal) {
  if(binding.kind!=='configOption')return false;
  const option=boundOption(session,binding);
  if(!option||option.id===modelOption(session.configOptions)?.id)return false;
  if(option.type==='select') {
    if(typeof value!=='string'||!option.options.flatMap(item=>'options' in item?item.options:[item]).some(item=>item.value===value))return false;
  } else if(typeof value!=='boolean')return false;
  if(option.currentValue!==value) {
    const changed=typeof value==='boolean'
      ? await agent.request(methods.setConfigOption,{sessionId:session.sessionId,configId:option.id,type:'boolean',value},{cancellationSignal:signal,stopWaitingOnCancel:true})
      : await agent.request(methods.setConfigOption,{sessionId:session.sessionId,configId:option.id,value},{cancellationSignal:signal,stopWaitingOnCancel:true});
    session.configOptions=/** @type {{configOptions:NewSessionResponse['configOptions']}} */ (changed).configOptions;
  }
  return boundOption(session,binding)?.currentValue===value;
}

/** ACP metadata is untrusted user-supplied protocol data. Never allow it to
 * replace the block's typed identity or embedded bytes.
 * @param {unknown} metadata
 */
function metadataObject(metadata){
  return metadata&&typeof metadata==='object'&&!Array.isArray(metadata)?/** @type {Record<string,unknown>} */(metadata):{};
}
/** @param {import('../../core/contracts.js').ContentAttachment} item
 * @param {Invocation['readUserPayload']} read @param {InitializeResponse['agentCapabilities']|undefined} capabilities
 * @param {AbortSignal} signal @param {(issue:NonNullable<import('../../core/ports.js').ProviderResult['contentUnavailable']>)=>void} [onFailure] @returns {Promise<ContentBlock|undefined>}
 */
export async function renderContentAttachment(item,read,capabilities,signal,onFailure){
  signal.throwIfAborted();
  const caps=capabilities?.promptCapabilities;
  if(capabilities&&(item.kind==='image'&&!caps?.image||item.kind==='audio'&&!caps?.audio||item.kind==='resource'&&!caps?.embeddedContext)){onFailure?.({ref:item.ref,cause:item.kind==='resource'?'resource_transport_unavailable':'native_modality_unavailable'});return;}
  const meta=metadataObject(item.metadata);
  if(item.kind==='link'){
    const {mimeType:_mime,...opaque}=meta;
    return /** @type {ContentBlock} */ ({...opaque,type:'resource_link',uri:item.uri,...(!item.mimeTypeOmitted&&{mimeType:item.mediaType}),name:typeof meta.name==='string'?meta.name:item.uri});
  }
  const bytes=await read?.(item.ref);
  signal.throwIfAborted();
  if(!bytes){onFailure?.({ref:item.ref,cause:'payload_unavailable'});return;}
  if(item.kind==='image'||item.kind==='audio'){
    const {uri:historicalUri,...opaque}=meta;
    // C24 ingress stored URI inside metadata. A typed URI always wins.
    const uri=item.uri??(typeof historicalUri==='string'&&historicalUri?historicalUri:undefined);
    return /** @type {ContentBlock} */ ({...opaque,type:item.kind,mimeType:item.mediaType,data:Buffer.from(bytes).toString('base64'),...(uri&&{uri})});
  }
  const outer=metadataObject(meta.outer);
  const {text:_text,blob:_blob,mimeType:_mime,...resource}=metadataObject(meta.resource);
  return /** @type {ContentBlock} */ ({...outer,type:'resource',resource:{...resource,uri:item.uri,...(!item.mimeTypeOmitted&&{mimeType:item.mediaType}),
    ...(item.encoding==='utf8'?{text:Buffer.from(bytes).toString('utf8')}:{blob:Buffer.from(bytes).toString('base64')})}});
}
/** @param {import('../../core/ports.js').OrderedTurn} turn @param {Invocation['readUserPayload']} read
 * @param {InitializeResponse['agentCapabilities']|undefined} capabilities @param {AbortSignal} signal
 * @param {(ref:string)=>void} [onOmitted]
 * @param {(ref:string,index:number)=>void} [onDelivered]
 * @param {(issue:NonNullable<import('../../core/ports.js').ProviderResult['contentUnavailable']>)=>void} [onFailure]
 * @returns {Promise<ContentBlock[]|undefined>}
 */
export async function renderOrderedTurn(turn,read,capabilities,signal,onOmitted,onDelivered,onFailure){
  /** @type {ContentBlock[]} */ const blocks=[];
  for(const item of turn.content){
    signal.throwIfAborted();
    if(item.kind==='text')blocks.push(/** @type {ContentBlock} */ ({...metadataObject(item.metadata),type:'text',text:turn.text.slice(item.start,item.end)}));
    else{
      const block=await renderContentAttachment(item,read,capabilities,signal,onFailure);
      if(!block){if(!onOmitted)return;onOmitted(item.ref);continue;}
      onDelivered?.(item.ref,blocks.length);
      blocks.push(block);
    }
  }
  return blocks;
}
