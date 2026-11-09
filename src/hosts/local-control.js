import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decode, id, oneOf, optional, record, text } from '../core/decode.js';
import { HostError, hostError } from './commands.js';

/** @import {Command} from './commands.js' */
/** @import {Socket} from 'node:net' */
/** @typedef {{path: string, token: string, pid: number}} Descriptor */
/** @typedef {(command: Command, accepted: (operationId: string) => void) => Promise<unknown>} Execute */

const version = 1;
const maximumRequestBytes = 2 * 1024 * 1024;
const descriptorName = '.control-v1.json';
const shape = record({
  version: oneOf(version), token: id, requestId: id,
  action: oneOf('run', 'resume', 'inspect', 'cancel', 'trace', 'export-diagnostics'),
  operationId: optional(id),
  payload: record({ text: optional(text), cwd: optional(id), questionId: optional(id), configurationRef: id }),
});

/** @param {Socket} socket @param {unknown} value @param {boolean} [last] */
function send(socket, value, last = false) {
  if (socket.destroyed || !socket.writable) return;
  const line = JSON.stringify(value) + '\n';
  if (last) socket.end(line);
  else socket.write(line);
}

/** @param {string} directory @param {string} configurationRef @param {Execute} execute */
export async function openControl(directory, configurationRef, execute) {
  const parent = await mkdtemp(join(tmpdir(), 'ro-control-'));
  const descriptor = { path: join(parent, 's'), token: randomUUID(), pid: process.pid };
  const location = join(directory, descriptorName);
  const staging = location + '.' + descriptor.token;
  /** @type {Set<Socket>} */
  const sockets = new Set();
  /** @type {Set<Promise<void>>} */
  const active = new Set();
  /** @type {Map<string, {fingerprint: string, operationId?: string, result: Promise<unknown>, settled: boolean, clients: Set<Socket>}>} */
  const requests = new Map();
  let closing = false;

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
      active.add(response);
      void response.finally(() => active.delete(response)).catch(() => {});
    }
    socket.on('data', receive);
  });
  server.on('error', () => {});

  /** @param {unknown} raw @param {Socket} socket */
  async function run(raw, socket) {
    if (closing) throw new HostError('CONTROL_CLOSING', 'The live owner is closing');
    const decoded = decode(shape, raw);
    if (decoded.kind === 'rejected') throw new HostError('CONTROL_INVALID', 'Invalid control request: ' + decoded.reason.path);
    const { requestId, action, operationId, payload, token } = decoded.value;
    if (token !== descriptor.token) throw new HostError('CONTROL_UNAUTHORIZED', 'Invalid control session token');
    if (payload.configurationRef !== configurationRef) {
      throw new HostError('CONTROL_CONFIGURATION_MISMATCH', 'Live owner uses a different configuration');
    }
    const fingerprint = JSON.stringify([action, operationId, payload]);
    let entry = requests.get(requestId);
    if (entry && entry.fingerprint !== fingerprint) throw new HostError('IDENTITY_CONFLICT', 'Request id reused');
    if (!entry) {
      // Application also deduplicates durable submit and continuation IDs.
      // Keep current replies only for this owner's lifetime.
      if (requests.size >= 1024) {
        const completed = [...requests].find(([, record]) => record.settled && record.clients.size === 0);
        if (completed) requests.delete(completed[0]);
        else throw new HostError('CONTROL_BUSY', 'Too many control requests in progress');
      }
      const clients = new Set([socket]);
      const result = Promise.resolve().then(() => execute({ action, requestId, operationId, ...payload }, id => {
        const current = requests.get(requestId);
        if (current) current.operationId = id;
        for (const client of clients) send(client, { requestId, accepted: id });
      }));
      const tracked = { fingerprint, result, clients, settled: false };
      entry = tracked;
      requests.set(requestId, tracked);
      void result.then(() => { tracked.settled = true; }, () => { tracked.settled = true; });
    } else {
      entry.clients.add(socket);
      if (entry.operationId) send(socket, { requestId, accepted: entry.operationId });
    }
    const clients = entry.clients;
    const detach = () => { clients.delete(socket); };
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
        while (active.size) await Promise.allSettled([...active]);
        closing = true;
        const closed = new Promise(resolve => server.close(resolve));
        for (const socket of sockets) socket.destroySoon();
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

/** @param {Descriptor} descriptor @param {string} configurationRef @param {Command} command
 * @param {(operationId: string) => void} [accepted]
 */
export function callControl(descriptor, configurationRef, command, accepted) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(descriptor.path);
    let sent = false;
    const lost = () => reject(new HostError('CONTROL_RESPONSE_LOST', 'Control reply was lost. Request id: ' + command.requestId));
    socket.once('connect', () => {
      sent = true;
      const { requestId, action, operationId, text, cwd, questionId } = command;
      send(socket, { version, token: descriptor.token, requestId, action, operationId,
        payload: { text, cwd, questionId, configurationRef } });
    });
    socket.once('error', error => {
      if (!sent && ('code' in error) && ['ENOENT', 'ECONNREFUSED', 'EPERM', 'EAFNOSUPPORT', 'ENOSYS'].includes(String(error.code))) resolve(undefined);
      else if (sent) lost();
      else reject(error);
    });
    socket.once('close', lost);
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
        try {
          const message = JSON.parse(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          if (message.requestId !== command.requestId) throw new Error('Correlation mismatch');
          if (typeof message.accepted === 'string') accepted?.(message.accepted);
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
