import { createInterface, clearLine, cursorTo } from 'node:readline';
import { terminalText } from './presentation.js';

/** @import {PendingPermission, PermissionHandler} from '../application/configuration/permissions.js' */
/** @import {PendingInteraction, InteractionResult} from '../core/ports.js' */
/** @typedef {{kind:'permission', request: PendingPermission} | {kind:'input', request: PendingInteraction}} PendingInput */
/** @typedef {{kind:'answered', payload: unknown} | {kind:'cancelled' | 'unavailable'}} InputResult */

/** @param {unknown} value @returns {Record<string, unknown>} */
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : {};

/** CLI can display protocol form fields and accept explicit JSON; no URL/auth or nested forms.
 * @param {PendingInteraction} request */
export function supportedForm(request) {
  const payload = object(request.payload), schema = object(payload.requestedSchema);
  return payload.mode === 'form' && schema.type === 'object' && !!schema.properties &&
    Object.values(object(schema.properties)).every(value => {
      const field = object(value);
      return ['string','number','integer','boolean'].includes(String(field.type)) ||
        (field.type === 'array' && ['string','number','integer','boolean'].includes(String(object(field.items).type)));
    });
}

/** @param {PendingInput} entry @param {string} line @returns {InputResult | undefined} */
function parse(entry, line) {
  if (entry.kind === 'permission') {
    const option = entry.request.options.find(option => option.id === line);
    return option && { kind:'answered', payload: { optionId: option.id } };
  }
  if (line === 'decline' || line === 'cancel') return { kind:'answered', payload: { action: line } };
  try {
    const value = JSON.parse(line);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const schema = object(object(entry.request.payload).requestedSchema), properties = object(schema.properties);
    if (Array.isArray(schema.required) && schema.required.some(key => typeof key === 'string' && !Object.hasOwn(value, key))) return;
    for (const [key, item] of Object.entries(value)) {
      if (!Object.hasOwn(properties, key)) return;
      const field = object(properties[key]);
      /** @param {unknown} v @param {Record<string,unknown>} shape */
      const valid = (v, shape) => (shape.type === 'integer' ? Number.isInteger(v) : typeof v === shape.type) &&
        (!Array.isArray(shape.enum) || shape.enum.includes(v));
      if (field.type === 'array' ? !Array.isArray(item) || !item.every(v => valid(v, object(field.items))) : !valid(item, field)) return;
    }
    return { kind:'answered', payload: { action:'accept', content:value } };
  } catch { return; }
}

/** Single terminal input owner; labels select existing pending requests, not grants.
 * @param {NodeJS.ReadableStream} input @param {NodeJS.WritableStream} output
 * @param {boolean} interactive @param {() => void} interrupt */
export function createCliInput(input, output, interactive, interrupt) {
  /** @type {Map<string, {entry: PendingInput, finish: (result: InputResult) => void}>} */
  const pending = new Map();
  /** @type {import('node:readline').Interface | undefined} */
  let rl;
  let eof = false;
  let outputBroken = false;
  const broken = () => { outputBroken = true; };
  output.on('error',broken);
  /** @type {string|undefined} */
  let chunkSource;
  let openLine=false;
  /** @param {string} text */
  function write(text) {
    if (outputBroken || ('destroyed' in output && output.destroyed)) return Promise.resolve();
    if (rl && interactive && 'isTTY' in output && output.isTTY) { clearLine(output, 0); cursorTo(output, 0); }
    return new Promise(resolve => {
      try { output.write(terminalText(text), () => resolve(undefined)); }
      catch { resolve(undefined); }
      if (rl) rl.prompt(true);
    });
  }
  /** @param {string} text */
  function print(text) {
    const prefix=openLine?'\n':'';
    openLine=false;chunkSource=undefined;
    return write(prefix+text+'\n');
  }
  /** @param {{source:string,header:string,text:string}} fragment */
  function printChunk(fragment) {
    // Readline owns its current input line. Use a technical line boundary
    // while editing instead of overwriting or buffering a native chunk.
    if(rl)return print(fragment.header+fragment.text);
    const changed=chunkSource!==fragment.source;
    const text=(changed?(openLine?'\n':'')+fragment.header:'')+fragment.text;
    chunkSource=fragment.source;
    openLine=!text.endsWith('\n');
    return write(text);
  }
  function prompt() {
    if (pending.size) {
      rl?.setPrompt('Reply (' + [...pending.keys()].join(', ') + '): ');
      rl?.prompt();
    }
  }
  function stopReader() {
    if (pending.size || !rl) return;
    const reader = rl; rl = undefined; reader.close();
  }
  function open() {
    if (rl) return;
    const reader = createInterface({input, output, terminal: Boolean('isTTY' in output && output.isTTY)});
    rl = reader;
    reader.on('line', line => {
      const match = /^(\S+)\s+([\s\S]*)$/.exec(line.trim());
      const label = match && pending.has(match[1]) ? match[1] : pending.size === 1 ? [...pending.keys()][0] : undefined;
      const entry = label && pending.get(label);
      const value = entry && parse(entry.entry, match && match[1] === label ? match[2].trim() : line.trim());
      if (entry && value) entry.finish(value);
      else void print('Select a pending request label and enter an offered option or form response.');
      prompt();
    });
    reader.once('close', () => {
      if (rl !== reader) return;
      rl = undefined; eof = true;
      for (const entry of [...pending.values()]) entry.finish({kind:'unavailable'});
    });
    reader.on('SIGINT', () => {
      interrupt();
      for (const entry of [...pending.values()]) entry.finish({kind:'cancelled'});
    });
  }
  /** @param {PendingInput} entry @param {AbortSignal} signal @returns {Promise<InputResult>} */
  async function ask(entry, signal) {
    if (signal.aborted) return {kind:'cancelled'};
    if (!interactive || eof || outputBroken || (entry.kind === 'input' && !supportedForm(entry.request))) {
      void print(entry.kind === 'permission' ? 'Permission unavailable for ' + JSON.stringify(entry.request.resource) : 'Interaction unavailable: unsupported form or input');
      return {kind:'unavailable'};
    }
    const label = '#' + entry.request.requestId;
    if (pending.has(label)) return {kind:'unavailable'};
    if(openLine){void write('\n');openLine=false;chunkSource=undefined;}
    open();
    return new Promise(resolve => {
      /** @param {InputResult} result */
      const finish = result => {
        if (!pending.delete(label)) return;
        signal.removeEventListener('abort', abort);
        resolve(result); stopReader();
      };
      const abort = () => finish({kind:'cancelled'});
      pending.set(label,{entry,finish});
      signal.addEventListener('abort',abort,{once:true});
      if (signal.aborted) { abort(); return; }
      void print(label + ' [' + entry.request.profileId + '/' + entry.request.attemptId + '] ' +
        (entry.kind === 'permission' ? 'Permission requested\n' + JSON.stringify({subject:entry.request.resource, action:entry.request.action, options:entry.request.options},null,2)
        : 'Native form (deadline ' + new Date(entry.request.deadlineAt).toISOString() + ')\n' + JSON.stringify(entry.request.payload,null,2) + '\nEnter JSON object, decline or cancel.'));
      prompt();
    });
  }
  return { ask, print, printChunk, close() {
    for (const entry of [...pending.values()]) entry.finish({kind:'unavailable'});
    stopReader();
    if(openLine){void write('\n');openLine=false;chunkSource=undefined;}
    // Leave the error guard on this terminal stream through outstanding writes;
    // the CLI process owns its lifetime, not the presentation consumer.
  }};
}

/** @param {InputResult} result @returns {Awaited<ReturnType<PermissionHandler>>} */
export function permissionResult(result) {
  if (result.kind === 'answered') {
    const option = object(result.payload).optionId;
    return typeof option === 'string' ? {kind:'selected',option} : {kind:'invalid'};
  }
  return {kind:result.kind};
}
/** @param {InputResult} result @returns {InteractionResult} */
export function interactionResult(result) { return result; }
