import { addAbortListener } from 'node:events';

/** @import {ClientContext, ContentBlock, InitializeResponse, NewSessionResponse, SessionConfigOption} from '@agentclientprotocol/sdk' */
/** @import {Invocation} from '../../core/ports.js' */

/** @typedef {NonNullable<Invocation['attachments']>[number]} Attachment */
/** @typedef {(attachment: Attachment, signal: AbortSignal) => Promise<ContentBlock | undefined>} ResolveAttachment */

/** @param {SessionConfigOption[] | null | undefined} options */
function modelOption(options) {
  const models = options?.filter(item => item.category === 'model') ?? [];
  return models.length === 1 && models[0].type === 'select' ? models[0] : undefined;
}

/**
 * @param {ClientContext} agent @param {typeof import('@agentclientprotocol/sdk').methods.agent.session} methods
 * @param {NewSessionResponse} session @param {string} model @param {string | undefined} mode @param {AbortSignal} signal
 */
export async function configureSession(agent, methods, session, model, mode, signal) {
  const { sessionId } = session;
  if (mode !== undefined && mode !== session.modes?.currentModeId) {
    if (!session.modes?.availableModes.some(item => item.id === mode)) return false;
    await agent.request(methods.setMode, { sessionId, modeId: mode }, { cancellationSignal: signal, stopWaitingOnCancel: true });
  }
  const option = modelOption(session.configOptions);
  if (!option) return false;
  if (option.currentValue === model) return true;
  const choices = option.options.flatMap(item => 'options' in item ? item.options : [item]);
  if (!choices.some(item => item.value === model)) return false;
  const response = await agent.request(methods.setConfigOption, { sessionId, configId: option.id, value: model }, { cancellationSignal: signal, stopWaitingOnCancel: true });
  return modelOption(response.configOptions)?.currentValue === model;
}

/**
 * @param {Invocation} invocation @param {InitializeResponse['agentCapabilities']} capabilities
 * @param {ResolveAttachment | undefined} resolve @param {AbortSignal} signal
 */
export async function attachmentBlocks(invocation, capabilities, resolve, signal) {
  /** @type {ContentBlock[]} */
  const blocks = [];
  for (const attachment of invocation.attachments ?? []) {
    signal.throwIfAborted();
    if (!resolve) return undefined;
    const image = attachment.mediaType.toLowerCase().startsWith('image/');
    if (image && !capabilities?.promptCapabilities?.image) return undefined;
    /** @type {PromiseWithResolvers<never>} */
    const stopped = Promise.withResolvers();
    const listener = addAbortListener(signal, () => stopped.reject(signal.reason));
    const block = await Promise.race([stopped.promise, Promise.resolve().then(() => resolve(attachment, signal))])
      .finally(() => listener[Symbol.dispose]());
    if (!block || (image ? block.type !== 'image' || block.mimeType !== attachment.mediaType :
      block.type !== 'resource_link' && (block.type !== 'resource' || !capabilities?.promptCapabilities?.embeddedContext))) {
      return undefined;
    }
    blocks.push(block);
  }
  return blocks;
}
