import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { arrayOf, decode, id, jsonValue, oneOf, optional, record, text } from '../core/decode.js';
import { createBoundedDelivery } from '../application/delivery.js';
import { HostError, hostError } from './commands.js';

/** @import {Command} from './commands.js' */
/** @import {Socket} from 'node:net' */
/** @typedef {{path: string, token: string, pid: number}} Descriptor */
/** @typedef {{controllerProfile?: string, preferredSkills?: string[]}} LaunchOverrides */
/** @typedef {(command: Command, accepted: (operationId: string) => void) => Promise<unknown>} Execute */
/** @typedef {{channel: 'activity', event: import('../core/ports.js').ActivityNotice} | {channel: 'execution', event: import('../core/diagnostics.js').DiagnosticEvent} | {channel: 'gap', droppedCount: number, reason: 'overflow'}} ControlNotice */
/** @typedef {{subscribe: (operationId: string, listener: (notice: ControlNotice) => Promise<void>) => () => void,
 * pending: (operationId: string) => unknown,
 * respond: (reply: import('../core/ports.js').InteractionReply) => unknown,
 * ownerAccepted?: (operationId:string,requestId:string,interactive:boolean)=>boolean,
 * ownerDetached?: (operationId:string,requestId:string)=>void}} ControlStreams */
/** @typedef {Command | {action: 'pending' | 'subscribe', requestId: string, operationId: string} | {action: 'answer', requestId: string, operationId: string, ownerRequestId: string, answerKey: string, reply: import('../core/ports.js').InteractionReply}} ControlCommand */

const version = 1;
const maximumRequestBytes = 2 * 1024 * 1024;
const descriptorName = '.control-v1.json';
const shape = record({
  version: oneOf(version), token: id, requestId: id,
  action: oneOf('run', 'resume', 'inspect', 'cancel', 'trace', 'export-diagnostics', 'subscribe', 'pending', 'answer'),
  operationId: optional(id),
  payload: record({
    text: optional(text), cwd: optional(id), questionId: optional(id), configurationRef: id,
    cancellationSource: optional(oneOf('client')),
    stream: optional(oneOf('live')), interactive: optional(oneOf('yes')), ownerRequestId: optional(id), answerKey: optional(id),
    reply: optional(record({ requestId: id, operationId: id, attemptId: id, providerRequestId: id, payload: jsonValue })),
    launch: optional(record({ controllerProfile: optional(id), preferredSkills: optional(arrayOf(id)) })),
  }),
});

/** @param {Socket} socket @param {unknown} value @param {boolean} [last] */
function send(socket, value, last = false) {
  if (socket.destroyed || !socket.writable) return;
  const line = JSON.stringify(value) + '\n';
  if (last) socket.end(line);
  else socket.write(line);
}

/** @param {LaunchOverrides} [overrides] */
function launchKey(overrides = {}) {
  return JSON.stringify([overrides.controllerProfile ?? null, overrides.preferredSkills ?? null]);
}

/** @param {string} directory @param {string} configurationRef @param {Execute} execute @param {LaunchOverrides} [launch] @param {ControlStreams} [streams] */
export async function openControl(directory, configurationRef, execute, launch, streams) {
  const parent = await mkdtemp(join(tmpdir(), 'ro-control-'));
  const descriptor = { path: join(parent, 's'), token: randomUUID(), pid: process.pid };
  const location = join(directory, descriptorName);
  const staging = location + '.' + descriptor.token;
  /** @type {Set<Socket>} */
  const sockets = new Set();
  /** @type {Set<Promise<void>>} */
  const active = new Set();
  /** @type {Map<string, {fingerprint: string, operationId?: string, result: Promise<unknown>, settled: boolean, clients: Set<Socket>, answerKey?: string, action: string}>} */
  const requests = new Map();
  /** @type {Set<Socket>} */
  const observers = new Set();
  let closing = false;
  let stopping = false;

  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => { sockets.delete(socket); });
    socket.setTimeout(5_000, () => socket.destroy());
    /** @type {Buffer[]} */
    const chunks = [];
    let bytes = 0;
    /** @param {Buffer} data */
    function receive(data) {
      const newline = data.indexOf(10);
      const chunk = newline === -1 ? data : data.subarray(0, newline);
      bytes += chunk.length;
      if (bytes > maximumRequestBytes) { socket.destroy(); return; }
      chunks.push(chunk);
      if (newline === -1) return;
      socket.removeListener('data', receive);
      socket.setTimeout(0);
      /** @type {unknown} */
      let raw;
      try { raw = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* Rejected below. */ }
      const requestId = raw && typeof raw === 'object' && 'requestId' in raw && typeof raw.requestId === 'string'
        ? raw.requestId : undefined;
      const response = run(raw, socket).then(
        outcome => send(socket, { requestId, outcome }, true),
        error => send(socket, { requestId, error: hostError(error) }, true),
      );
      if (!observers.has(socket)) active.add(response);
      void response.finally(() => active.delete(response)).catch(() => {});
    }
    socket.on('data', receive);
  });
  server.on('error', () => {});

  /** @param {Socket} socket @param {string} requestId @param {string} operationId */
  function subscribe(socket, requestId, operationId) {
    if (!streams || socket.destroyed) return () => {};
    const unsubscribe = streams.subscribe(operationId, notice => new Promise(resolve => {
      if (socket.destroyed || !socket.writable) { resolve(); return; }
      // Each source waits for its write callback. A slow socket cannot build
      // an unbounded writable backlog, and the execution path never awaits it.
      const done = () => { socket.removeListener('close', done); resolve(); };
      socket.once('close', done);
      socket.write(JSON.stringify({ requestId, notice }) + '\n', done);
    }));
    const close = () => { socket.removeListener('close', close); unsubscribe(); };
    socket.once('close', close);
    return close;
  }

  /** @param {unknown} raw @param {Socket} socket */
  async function run(raw, socket) {
    const decoded = decode(shape, raw);
    if (decoded.kind === 'rejected') throw new HostError('CONTROL_INVALID', 'Invalid control request: ' + decoded.reason.path);
    const { requestId, action, operationId, payload, token } = decoded.value;
    if (token !== descriptor.token) throw new HostError('CONTROL_UNAUTHORIZED', 'Invalid control session token');
    if (payload.configurationRef !== configurationRef) {
      throw new HostError('CONTROL_CONFIGURATION_MISMATCH', 'Live owner uses a different configuration');
    }
    if (payload.launch && launchKey(payload.launch) !== launchKey() && launchKey(payload.launch) !== launchKey(launch)) {
      throw new HostError('CONTROL_LAUNCH_UNAVAILABLE', 'Live owner uses different launch preferences');
    }
    if (action === 'subscribe') {
      if (closing || !streams || !operationId) throw new HostError('CONTROL_STREAM_UNAVAILABLE', 'Live subscription unavailable');
      observers.add(socket);
      const unsubscribe = subscribe(socket, requestId, operationId);
      send(socket, { requestId, accepted: operationId });
      try { await new Promise(resolve => socket.once('close', resolve)); }
      finally { observers.delete(socket); unsubscribe(); }
      return undefined;
    }
    if (action === 'pending') {
      if (!streams || !operationId) throw new HostError('CONTROL_STREAM_UNAVAILABLE', 'Pending inspection unavailable');
      return streams.pending(operationId);
    }
    // A presentation subscription is not a new execution request. Retain the
    // original input owner/capabilities on retries, regardless of the new view.
    const {stream: _stream, interactive: _interactive, ...executionPayload} = payload;
    const fingerprint = JSON.stringify([action, operationId, executionPayload]);
    let entry = requests.get(requestId);
    if (entry && entry.fingerprint !== fingerprint) throw new HostError('IDENTITY_CONFLICT', 'Request id reused');
    if (stopping || (closing && !entry && (action === 'run' || action === 'resume'))) {
      throw new HostError('CONTROL_CLOSING', 'The live owner is closing');
    }
    if (!entry) {
      // Application also deduplicates durable submit and continuation IDs.
      // Keep current replies only for this owner's lifetime.
      if (requests.size >= 1024) {
        const completed = [...requests].find(([, record]) => record.settled && record.clients.size === 0);
        if (completed) requests.delete(completed[0]);
        else throw new HostError('CONTROL_BUSY', 'Too many control requests in progress');
      }
      const clients = new Set([socket]);
      let answerKey = payload.stream === 'live' && (action === 'run' || action === 'resume') ? randomUUID() : undefined;
      const result = Promise.resolve().then(() => {
        if (action === 'answer') {
          const owner = payload.ownerRequestId && requests.get(payload.ownerRequestId);
          if (!streams || !owner || !owner.answerKey || owner.answerKey !== payload.answerKey ||
              owner.settled || owner.clients.size === 0 || owner.operationId !== operationId || !payload.reply || payload.reply.operationId !== operationId) {
            throw new HostError('CONTROL_INTERACTION_OWNER_REQUIRED', 'Interaction answer requires the owning work request');
          }
          return streams.respond(payload.reply);
        }
        return execute({ action, requestId, operationId, ...payload }, id => {
        const current = requests.get(requestId);
        if (current) {
          current.operationId = id;
          if (clients.size === 0 || (streams?.ownerAccepted && !streams.ownerAccepted(id,requestId,payload.interactive === 'yes'))) {
            current.answerKey = undefined; answerKey = undefined;
          }
        }
        for (const client of clients) {
          send(client, { requestId, accepted: id, answerKey });
          if (payload.stream === 'live') subscribe(client, requestId, id);
        }
      }); });
      const tracked = { fingerprint, result, clients, settled: false, answerKey, action };
      entry = tracked;
      requests.set(requestId, tracked);
      void result.then(() => { tracked.settled = true; }, () => { tracked.settled = true; });
    } else {
      entry.clients.add(socket);
      if (entry.operationId) {
        send(socket, { requestId, accepted: entry.operationId, answerKey: entry.answerKey });
        if (payload.stream === 'live' && !entry.settled) subscribe(socket, requestId, entry.operationId);
      }
    }
    const clients = entry.clients;
    const detach = () => {
      clients.delete(socket);
      if (clients.size === 0 && entry.operationId) streams?.ownerDetached?.(entry.operationId,requestId);
    };
    socket.once('close', detach);
    try { return await entry.result; }
    finally { socket.removeListener('close', detach); detach(); }
  }

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(descriptor.path, () => { server.removeListener('error', reject); resolve(undefined); });
    });
    await writeFile(staging, JSON.stringify(descriptor), { mode: 0o600, flag: 'wx' });
    await rename(staging, location);
  } catch (error) {
    server.close();
    await Promise.allSettled([rm(parent, { recursive: true, force: true }), rm(staging, { force: true })]);
    throw error;
  }

  /** @type {Promise<void> | undefined} */
  let shutdown;
  return {
    close() {
      return shutdown ??= (async () => {
        closing = true;
        for (const socket of observers) socket.destroy();
        await Promise.allSettled([...active]);
        stopping = true;
        const closed = new Promise(resolve => server.close(resolve));
        await Promise.allSettled([...active]);
        for (const socket of sockets) {
          socket.destroySoon();
          // A peer that never reads cannot prevent owner shutdown.
          const timer = setTimeout(() => socket.destroy(), 1000);
          timer.unref();
          socket.once('close', () => clearTimeout(timer));
        }
        await closed;
        try {
          const current = await readDescriptor(directory);
          if (current?.token === descriptor.token) await rm(location, { force: true });
        } finally { await rm(parent, { recursive: true, force: true }); }
      })();
    },
  };
}

/** @param {string} directory @returns {Promise<Descriptor | undefined>} */
export async function readDescriptor(directory) {
  try {
    const value = JSON.parse(await readFile(join(directory, descriptorName), 'utf8'));
    if (typeof value?.path === 'string' && typeof value.token === 'string' && Number.isSafeInteger(value.pid)) return value;
  } catch (error) {
    if (!(error instanceof SyntaxError) && !(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
  }
}

/** @param {Descriptor} descriptor @param {string} configurationRef @param {ControlCommand} command
 * @param {(operationId: string, answerKey?: string) => void} [accepted] @param {LaunchOverrides} [launch]
 * @param {{notice?: (notice: ControlNotice) => void | Promise<void>, signal?: AbortSignal, interactive?:boolean}} [live]
 */
export function callControl(descriptor, configurationRef, command, accepted, launch, live) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(descriptor.path);
    let sent = false;
    const delivery = live?.notice && createBoundedDelivery(live.notice,
      (/** @type {Extract<ControlNotice, {channel:'gap'}> | undefined} */ prior, /** @type {ControlNotice} */ _event) =>
        ({ channel: /** @type {const} */ ('gap'), droppedCount: (prior?.droppedCount ?? 0) + 1, reason: /** @type {const} */ ('overflow') }));
    const abort = () => { socket.destroy(); };
    live?.signal?.addEventListener('abort', abort, { once: true });
    socket.once('close', () => { live?.signal?.removeEventListener('abort', abort); });
    if (live?.signal?.aborted) abort();
    const lost = () => reject(new HostError('CONTROL_RESPONSE_LOST', 'Control reply was lost. Request id: ' + command.requestId));
    socket.once('connect', () => {
      sent = true;
      const { requestId, action, operationId } = command;
      const work = /** @type {Command} */ (command);
      const answer = action === 'answer' ? command : undefined;
      send(socket, { version, token: descriptor.token, requestId, action, operationId,
        payload: { text: work.text, cwd: work.cwd, questionId: work.questionId, configurationRef, cancellationSource: work.cancellationSource, launch,
          stream: (live?.notice || live?.interactive) && action !== 'subscribe' ? 'live' : undefined,
          interactive: live?.interactive ? 'yes' : undefined,
          ownerRequestId: answer?.ownerRequestId, answerKey: answer?.answerKey, reply: answer?.reply } });
    });
    socket.once('error', error => {
      if (!sent && ('code' in error) && ['ENOENT', 'ECONNREFUSED', 'EPERM', 'EAFNOSUPPORT', 'ENOSYS'].includes(String(error.code))) resolve(undefined);
      else if (sent) lost();
      else reject(error);
    });
    socket.once('close', () => { delivery?.close(); lost(); });
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
        try {
          const message = JSON.parse(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          if (message.requestId !== command.requestId) throw new Error('Correlation mismatch');
          if (typeof message.accepted === 'string') accepted?.(message.accepted, message.answerKey);
          else if (message.notice && delivery) delivery.enqueue(message.notice, Buffer.byteLength(JSON.stringify(message.notice)));
          else {
            if (message.error) reject(new HostError(message.error.code, message.error.message));
            else if (Object.hasOwn(message, 'outcome')) resolve(message.outcome);
            else throw new Error('Missing outcome');
            socket.end();
            return;
          }
        } catch {
          socket.destroy();
          lost();
          return;
        }
      }
    });
  });
}
