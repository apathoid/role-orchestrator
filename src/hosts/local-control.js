import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { arrayOf, decode, id, jsonValue, oneOf, optional, record, text } from '../core/decode.js';
import { userSettings } from '../core/contracts.js';
import { createBoundedDelivery } from '../application/delivery.js';
import { HostError, hostError, isAdministrativeAction } from './commands.js';

/** @import {Command} from './commands.js' */
/** @import {Socket} from 'node:net' */
/** @typedef {{path: string, token: string, pid: number}} Descriptor */
/** @typedef {{controllerProfile?: string, preferredSkills?: string[]}} LaunchOverrides */
/** @typedef {(command: Command, accepted: (operationId: string) => void) => Promise<unknown>} Execute */
/** @typedef {{channel: 'activity', event: import('../core/ports.js').ActivityNotice} | {channel: 'execution', event: import('../core/diagnostics.js').DiagnosticEvent, findings?:readonly import('../core/finding.js').Finding[],fact?:import('../application/execution-facts.js').ExecutionFact} | {channel: 'gap', droppedCount: number, reason: 'overflow' | 'finish_unconfirmed'}} ControlNotice */
/** @typedef {{subscribe: (operationId: string, listener: (notice: ControlNotice) => Promise<void>) => (() => void) & {finish?:()=>Promise<number>},
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
    text: optional(text), cwd: optional(id), questionId: optional(id), configurationRef: optional(id),
    controllerProfile:optional(id),userSettings:optional(userSettings),
    cancellationSource: optional(oneOf('client')),
    stream: optional(oneOf('live')), interactive: optional(oneOf('yes')), ownerRequestId: optional(id), answerKey: optional(id), reconnectKey: optional(id),
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
  /** @type {Map<string, {fingerprint: string, operationId?: string, result: Promise<unknown>, settled: boolean, clients: Set<Socket>, ownerClients: Set<Socket>, views: Set<Socket>, interactive: boolean, ownerBound: boolean, answerKey?: string, action: string}>} */
  const requests = new Map();
  /** @type {Set<Socket>} */
  const observers = new Set();
  let closing = false;
  let stopping = false;
  /** @type {Map<Socket, (()=>void) & {finish?:()=>Promise<number>}>} */
  const subscriptions = new Map();

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
      async function finishView() {
        const subscription = subscriptions.get(socket);
        const omitted = await subscription?.finish?.() ?? 0;
        subscription?.();
        if (omitted) send(socket,{requestId,notice:{channel:'gap',droppedCount:omitted,reason:'finish_unconfirmed'}});
      }
      const response = run(raw, socket).then(
        async outcome => { await finishView(); send(socket, { requestId, outcome }, true); },
        async error => { await finishView(); send(socket, { requestId, error: hostError(error) }, true); },
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
    const close = () => { socket.removeListener('close', close); subscriptions.delete(socket); unsubscribe(); };
    const subscription = Object.assign(close,{finish:()=>unsubscribe.finish?.() ?? Promise.resolve(0)});
    subscriptions.set(socket,subscription);
    socket.once('close', close);
    return subscription;
  }

  /** @param {unknown} raw @param {Socket} socket */
  async function run(raw, socket) {
    const decoded = decode(shape, raw);
    if (decoded.kind === 'rejected') throw new HostError('CONTROL_INVALID', 'Invalid control request: ' + decoded.reason.path);
    const { requestId, action, operationId, payload, token } = decoded.value;
    if (token !== descriptor.token) throw new HostError('CONTROL_UNAUTHORIZED', 'Invalid control session token');
    const administrative = isAdministrativeAction(action);
    if (!administrative && payload.configurationRef !== configurationRef) {
      throw new HostError('CONTROL_CONFIGURATION_MISMATCH', 'Live owner uses a different configuration');
    }
    if (!administrative && payload.launch && launchKey(payload.launch) !== launchKey() && launchKey(payload.launch) !== launchKey(launch)) {
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
    const {stream: _stream, interactive: _interactive, reconnectKey: _reconnectKey, ...executionPayload} = payload;
    const { configurationRef: _configuration, launch: _launch, ...administrativePayload } = executionPayload;
    const fingerprint = JSON.stringify([action, operationId, administrative ? administrativePayload : executionPayload]);
    let entry = requests.get(requestId);
    if (entry && entry.fingerprint !== fingerprint) throw new HostError('IDENTITY_CONFLICT', 'Request id reused');
    if (stopping || (closing && !entry && (action === 'run' || action === 'resume'))) {
      throw new HostError('CONTROL_CLOSING', 'The live owner is closing');
    }
    if (!entry && payload.reconnectKey) throw new HostError('CONTROL_INTERACTION_OWNER_REQUIRED', 'Original work binding unavailable; no work replayed');
    if (!entry) {
      // Application also deduplicates durable submit and continuation IDs.
      // Keep current replies only for this owner's lifetime.
      if (requests.size >= 1024) {
        const completed = [...requests].find(([, record]) => record.settled && record.clients.size === 0);
        if (completed) requests.delete(completed[0]);
        else throw new HostError('CONTROL_BUSY', 'Too many control requests in progress');
      }
      const clients = new Set([socket]);
      const ownerClients = new Set([socket]);
      const views = new Set(payload.stream === 'live' ? [socket] : []);
      const interactive = payload.interactive === 'yes';
      const answerKey = interactive && (action === 'run' || action === 'resume') ? randomUUID() : undefined;
      const result = Promise.resolve().then(() => {
        if (action === 'answer') {
          const owner = payload.ownerRequestId && requests.get(payload.ownerRequestId);
          if (!streams || !owner || !owner.answerKey || owner.answerKey !== payload.answerKey ||
              owner.settled || !owner.ownerBound || owner.ownerClients.size === 0 || owner.operationId !== operationId || !payload.reply || payload.reply.operationId !== operationId) {
            throw new HostError('CONTROL_INTERACTION_OWNER_REQUIRED', 'Interaction answer requires the owning work request');
          }
          return streams.respond(payload.reply);
        }
        return execute({ action, requestId, operationId, ...payload }, id => {
        const current = requests.get(requestId);
        if (current) {
          current.operationId = id;
          current.ownerBound = ownerClients.size > 0 && (streams?.ownerAccepted?.(id,requestId,interactive) ?? true);
        }
        for (const client of clients) {
          send(client, { requestId, accepted: id, answerKey: current?.ownerBound && ownerClients.has(client) ? answerKey : undefined });
          if (views.has(client)) subscribe(client, requestId, id);
        }
      }); });
      const tracked = { fingerprint, result, clients, ownerClients, views, interactive, ownerBound: false, settled: false, answerKey, action };
      entry = tracked;
      requests.set(requestId, tracked);
      void result.then(() => { tracked.settled = true; }, () => { tracked.settled = true; });
    } else {
      const reconnect = !entry.settled && !!entry.answerKey && payload.reconnectKey === entry.answerKey;
      if (payload.reconnectKey && !reconnect && !entry.settled) throw new HostError('CONTROL_INTERACTION_OWNER_REQUIRED', 'Original work binding unavailable');
      entry.clients.add(socket);
      if (payload.stream === 'live') entry.views.add(socket);
      if (reconnect) {
        if (entry.operationId && !entry.ownerBound) {
          entry.ownerBound = streams?.ownerAccepted?.(entry.operationId,requestId,entry.interactive) ?? true;
        }
        if (entry.ownerBound) entry.ownerClients.add(socket);
      }
      if (entry.operationId) {
        send(socket, { requestId, accepted: entry.operationId, answerKey: reconnect && entry.ownerBound ? entry.answerKey : undefined });
        if (payload.stream === 'live' && !entry.settled) subscribe(socket, requestId, entry.operationId);
      }
    }
    const clients = entry.clients;
    const detach = () => {
      clients.delete(socket);
      entry.views.delete(socket);
      if (entry.ownerClients.delete(socket) && entry.ownerClients.size === 0 && entry.operationId && entry.ownerBound) {
        entry.ownerBound = false;
        streams?.ownerDetached?.(entry.operationId,requestId);
      }
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

/** @param {Descriptor} descriptor @param {string | undefined} configurationRef @param {ControlCommand} command
 * @param {(operationId: string, answerKey?: string) => void} [accepted] @param {LaunchOverrides} [launch]
 * @param {{notice?: (notice: ControlNotice) => void | Promise<void>, signal?: AbortSignal, interactive?:boolean, reconnectKey?:string, onGap?:(count:number)=>void}} [live]
 */
export function callControl(descriptor, configurationRef, command, accepted, launch, live) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(descriptor.path);
    let sent = false, terminalReceived = false;
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
        payload: { text: work.text, cwd: work.cwd, questionId: work.questionId,controllerProfile:work.controllerProfile,userSettings:work.userSettings, configurationRef, cancellationSource: work.cancellationSource, launch,
          stream: live?.notice && action !== 'subscribe' ? 'live' : undefined,
          interactive: live?.interactive ? 'yes' : undefined, reconnectKey: live?.reconnectKey,
          ownerRequestId: answer?.ownerRequestId, answerKey: answer?.answerKey, reply: answer?.reply } });
    });
    socket.once('error', error => {
      if (terminalReceived) return;
      if (!sent && ('code' in error) && ['ENOENT', 'ECONNREFUSED', 'EPERM', 'EAFNOSUPPORT', 'ENOSYS'].includes(String(error.code))) resolve(undefined);
      else if (sent) lost();
      else reject(error);
    });
    socket.once('close', () => { if (!terminalReceived) { delivery?.close(); lost(); } });
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
          else if (message.notice) delivery?.enqueue(message.notice, Buffer.byteLength(JSON.stringify(message.notice)));
          else {
            if (!message.error && !Object.hasOwn(message, 'outcome')) throw new Error('Missing outcome');
            terminalReceived = true;
            socket.end();
            void (async () => {
              const omitted = await delivery?.finish() ?? 0;
              if (omitted) { try { live?.onGap?.(omitted); } catch { /* Presentation only. */ } }
              if (message.error) reject(new HostError(message.error.code, message.error.message));
              else resolve(message.outcome);
            })().catch(reject);
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
