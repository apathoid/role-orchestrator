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
  /** @type {Error | undefined} */
  let outputFailure;
  /** @type {Set<(error?:Error)=>void>} */
  const writes = new Set();
  /** @param {unknown} [error] */
  function broken(error) {
    outputFailure ??= error instanceof Error ? error : new Error('CLI presentation output unavailable');
    for (const settle of writes) settle(outputFailure);
    // No actionable prompt can be confirmed on a failed terminal. Do not
    // fabricate an approval or keep a user waiting for invisible input.
    for (const value of [...pending.values()]) value.finish({kind:'unavailable'});
  }
  output.on('error',broken);
  output.once('close',broken);
  function unavailable() {
    return !!outputFailure || !output.writable ||
      ('destroyed' in output && output.destroyed) || ('writableEnded' in output && output.writableEnded);
  }
  /** @type {string|undefined} */
  let chunkSource;
  let openLine=false;
  /** A fulfilled callback confirms only the Writable boundary, not a human
   * reading the text. Delivery owns its existing bounded finish deadline.
   * @param {string} text @returns {Promise<void>}
   */
  function write(text) {
    if (unavailable()) {
      broken();
      return Promise.reject(outputFailure);
    }
    return new Promise((resolve,reject) => {
      /** @param {Error} [error] */
      const settle = error => {
        if (!writes.delete(settle)) return;
        if (error) reject(error);
        else resolve();
      };
      writes.add(settle);
      try {
        if (rl && interactive && 'isTTY' in output && output.isTTY) { clearLine(output, 0); cursorTo(output, 0); }
        output.write(terminalText(text), error => { if (error) broken(error); else settle(); });
        if (rl) rl.prompt(true);
      } catch (error) { broken(error); }
    });
  }
  /** @param {string} text */
  function print(text) {
    const prefix=openLine?'\n':'';
    openLine=false;chunkSource=undefined;
    return write(prefix+text+'\n');
  }
  /** Local messages do not own a delivery receipt. Never recursively
   * report an output failure to the same failed stream.
   * @param {string} text
   */
  function report(text) { return print(text).catch(()=>{}); }
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
      try {
        rl?.setPrompt('Reply (' + [...pending.keys()].join(', ') + '): ');
        rl?.prompt();
      } catch(error) { broken(error); }
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
      else void report('Select a pending request label and enter an offered option or form response.');
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
    if (!interactive || eof || unavailable() || (entry.kind === 'input' && !supportedForm(entry.request))) {
      void report(entry.kind === 'permission' ? 'Permission unavailable for ' + JSON.stringify(entry.request.resource) : 'Interaction unavailable: unsupported form or input');
      return {kind:'unavailable'};
    }
    const label = '#' + entry.request.requestId;
    if (pending.has(label)) return {kind:'unavailable'};
    if(openLine){void write('\n').catch(()=>{});openLine=false;chunkSource=undefined;}
    if(unavailable()) return {kind:'unavailable'};
    try { open(); } catch(error) { broken(error); return {kind:'unavailable'}; }
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
      void report(label + ' [' + entry.request.profileId + '/' + entry.request.attemptId + '] ' +
        (entry.kind === 'permission' ? 'Permission requested\n' + JSON.stringify({subject:entry.request.resource, action:entry.request.action, options:entry.request.options},null,2)
        : 'Native form (deadline ' + new Date(entry.request.deadlineAt).toISOString() + ')\n' + JSON.stringify(entry.request.payload,null,2) + '\nEnter JSON object, decline or cancel.'));
      prompt();
    });
  }
  return { ask, print, printChunk, report, close() {
    for (const entry of [...pending.values()]) entry.finish({kind:'unavailable'});
    stopReader();
    if(openLine){void write('\n').catch(()=>{});openLine=false;chunkSource=undefined;}
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
