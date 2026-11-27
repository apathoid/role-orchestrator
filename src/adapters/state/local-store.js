import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { constants as bufferLimits } from 'node:buffer';
import * as fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { artifactRef, expiredArtifacts } from './artifact-retention.js';
import { sameRecord } from '../../core/operation.js';
import { decodeSnapshot, encodeSnapshot } from '../../core/snapshot.js';

/** @import {ArtifactRetention, ArtifactRead, ArtifactStore, CommitResult, SnapshotUnavailableReason, StateListEntry, StateStore} from '../../core/ports.js' */
/** @import {Operation} from '../../core/operation.js' */

const snapshotName = /^([a-f0-9]{64})(?:-([a-f0-9]{64}))?\.json$/u;
const temporaryName = /^\.state-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.tmp$/u;
const utf8 = new TextDecoder('utf-8', { fatal: true });

/** @param {Uint8Array} bytes */
const hashBytes = bytes => createHash('sha256').update(bytes).digest('hex');

/** @param {number} maxBytes */
function checkBound(maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes >= bufferLimits.MAX_LENGTH) {
    throw new RangeError('Invalid artifact byte bound');
  }
}

/** @param {string} id */
function key(id) {
  return createHash('sha256').update(id, 'utf16le').digest('hex');
}

export class LocalStoreError extends Error {
  /** @param {SnapshotUnavailableReason | 'closed' | 'in_use' | 'absent'} reason @param {unknown} [cause] */
  constructor(reason, cause) {
    super('Local state store: ' + reason, { cause });
    this.code = reason === 'in_use' ? 'STATE_STORE_IN_USE' : 'STORE_UNAVAILABLE';
    this.reason = reason;
  }
}

/** @param {unknown} error */
function isMissing(error) {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/** @param {string} root @param {Pick<typeof fs, 'readFile' | 'readdir'>} io */
function localSnapshots(root, io) {
  /** @param {string} name @returns {Promise<Operation | undefined>} */
  async function read(name) {
    let content;
    try {
      content = await io.readFile(join(root, name));
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw new LocalStoreError('io', error);
    }
    let serialized;
    try {
      serialized = utf8.decode(content);
    } catch (error) {
      throw new LocalStoreError('corrupt_snapshot', error);
    }
    const parsed = decodeSnapshot(serialized);
    if (parsed.kind !== 'accepted') {
      throw new LocalStoreError(parsed.kind === 'corrupt' ? 'corrupt_snapshot' : parsed.kind);
    }
    const [, slot, requestKey] = snapshotName.exec(name) ?? [];
    if (slot !== key(parsed.value.operationId) || (requestKey && requestKey !== key(parsed.value.request.requestId))) {
      throw new LocalStoreError('corrupt_snapshot');
    }
    return parsed.value;
  }


  async function snapshotNames() {
    try {
      return (await io.readdir(root)).filter(name => snapshotName.test(name));
    } catch (error) {
      throw new LocalStoreError('io', error);
    }
  }

  /** @param {string} slot */
  async function locate(slot) {
    const matching = (await snapshotNames()).filter(name => name.startsWith(slot));
    if (matching.length > 1) throw new LocalStoreError('corrupt_snapshot');
    return matching[0];
  }

  /** @param {string} operationId */
  async function load(operationId) {
    const name = await locate(key(operationId));
    const operation = name ? await read(name) : undefined;
    if (operation && operation.operationId !== operationId) throw new LocalStoreError('corrupt_snapshot');
    return operation;
  }
  return { read, snapshotNames, locate, load };
}

/** Read the authoritative atomic snapshot without opening a writer or doing maintenance.
 * @param {string} directory @param {string} operationId */
export async function readLocalOperation(directory, operationId) {
  try {
    return await localSnapshots(resolve(directory), fs).load(operationId);
  } catch (error) {
    // Only the directory listing can surface a missing path here; a
    // disappeared snapshot is already handled by the shared reader.
    if (error instanceof LocalStoreError && error.reason === 'io' && isMissing(error.cause)) {
      throw new LocalStoreError('absent', error.cause);
    }
    throw error;
  }
}

/** @param {string} root */
function acquireWriter(root) {
  const lock = new DatabaseSync(join(root, '.writer.sqlite'), { timeout: 0 });
  try {
    lock.exec('BEGIN IMMEDIATE');
    return lock;
  } catch (error) {
    lock.close();
    throw error;
  }
}

/** @param {unknown} error */
function writerError(error) {
  const busy = error instanceof Error && 'errcode' in error && typeof error.errcode === 'number' &&
    (error.errcode & 0xff) === 5; // SQLITE_BUSY, including extended codes
  return new LocalStoreError(busy ? 'in_use' : 'io', error);
}

/**
 * Observe RO writer ownership at this instant using the same SQLite lock.
 * Never create a missing directory/lock, do maintenance or touch snapshots.
 * @param {string} directory
 * @returns {Promise<'absent' | 'idle'>}
 */
export async function probeLocalStore(directory) {
  const root = resolve(directory);
  /** @type {import('node:fs/promises').FileHandle | undefined} */
  let handle;
  /** @type {DatabaseSync | undefined} */
  let lock;
  try {
    try {
      try { handle = await fs.open(root, constants.O_RDONLY | constants.O_DIRECTORY); }
      catch (error) { if (isMissing(error)) return 'absent'; throw error; }
      const path = join(root, '.writer.sqlite');
      let marker;
      try { marker = await fs.lstat(path); }
      catch (error) { if (isMissing(error)) return 'idle'; throw error; }
      if (marker.isSymbolicLink()) marker = await fs.stat(path);
      if (!marker.isFile()) throw new Error('Invalid writer lock file');
      lock = acquireWriter(root);
      return 'idle';
    } finally {
      try { lock?.close(); } finally { await handle?.close(); }
    }
  } catch (error) {
    throw writerError(error);
  }
}

/**
 * The caller provisions a directory on a filesystem with atomic replacement
 * and directory sync. The adapter acquires writer ownership on open.
 * @param {string} directory
 * @param {Pick<typeof fs, 'open' | 'readFile' | 'readdir' | 'rename' | 'unlink'>} [io]
 * @returns {StateStore & ArtifactStore}
 */
export function createLocalStateStore(directory, io = fs) {
  const root = resolve(directory);
  /** @type {import('node:fs/promises').FileHandle | undefined} */
  let directoryHandle;
  /** @type {DatabaseSync | undefined} */
  let owner;
  let queue = Promise.resolve();
  // One verified immutable artifact image per StateStore instance. The cache
  // is an ephemeral optimization, never a second persistent source of truth.
  // Recheck the backing inode/version (including ctime) on every access.
  const verifiedCacheMaxBytes = 16 * 1024 * 1024;
  /** @type {{hash:string, stamp:string, bytes:Buffer} | undefined} */
  let verifiedCache;

  /** @template T @param {() => Promise<T>} task */
  function serialize(task) {
    const result = queue.then(task);
    queue = result.then(() => {}, () => {});
    return result;
  }

  function requireOpen() {
    if (!directoryHandle) throw new LocalStoreError('closed');
    return directoryHandle;
  }

  const { read, snapshotNames, locate, load } = localSnapshots(root, io);

  /**
   * Read/verify the full content-addressed bytes once for each unchanged file
   * version. Cached bytes are never returned directly to an external caller.
   * @param {import('../../core/observation.js').ArtifactReference} reference
   * @returns {Promise<ArtifactRead>}
   */
  async function verifiedArtifact(reference) {
    requireOpen();
    const match = artifactRef.exec(reference.ref);
    if (!match || !Number.isSafeInteger(reference.size) || reference.size < 0 ||
        !Number.isSafeInteger(reference.originalSize) || reference.originalSize < reference.size ||
        reference.truncated !== (reference.size < reference.originalSize)) return {kind:'integrity_error'};
    try {
      const file = await io.open(join(root, 'artifact-' + match[1] + '.blob'), 'r');
      try {
        const stat = await file.stat({bigint:true});
        const stamp = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
        if (verifiedCache?.hash === match[1] && verifiedCache.stamp === stamp &&
            verifiedCache.bytes.length === reference.size) {
          return {kind:'available',bytes:verifiedCache.bytes};
        }
        verifiedCache = undefined;
        const data = Buffer.allocUnsafe(reference.size + 1);
        let offset = 0;
        while (offset < data.length) {
          const {bytesRead} = await file.read(data, offset, data.length - offset, offset);
          if (!bytesRead) break;
          offset += bytesRead;
        }
        const bytes = data.subarray(0, offset);
        if (offset !== reference.size || hashBytes(bytes) !== match[1]) return {kind:'integrity_error'};
        // A close can race a previously started read. Never retain verified
        // bytes after the owning Store has closed.
        if (directoryHandle && bytes.length <= verifiedCacheMaxBytes) {
          verifiedCache = {hash:match[1],stamp,bytes};
        }
        return {kind:'available',bytes};
      } finally {
        await file.close();
      }
    } catch (error) {
      verifiedCache=undefined;
      return isMissing(error) && await hasRetentionMarker(match[1])
        ? {kind:'unavailable',reason:'retention'} : {kind:'unavailable'};
    }
  }

  /**
   * @param {import('node:fs/promises').FileHandle} handle
   * @param {string} name @param {string | Uint8Array} content
   */
  async function publish(handle, name, content) {
    const tmp = join(root, '.state-' + randomUUID() + '.tmp');
    const file = await io.open(tmp, 'wx', 0o600);
    let renamed = false;
    try {
      try {
        await file.writeFile(content, 'utf8');
        await file.sync();
      } finally {
        await file.close();
      }
      await io.rename(tmp, join(root, name));
      renamed = true;
      // A failed directory sync can follow a successful publication.
      await handle.sync();
    } finally {
      if (!renamed) await io.unlink(tmp).catch(() => {});
    }
  }

  /** @param {string} hash */
  async function hasRetentionMarker(hash) {
    try {
      const marker = await io.open(join(root, 'artifact-' + hash + '.retention'), 'r');
      await marker.close();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Run under the exclusive writer lock, before any capture can publish a
   * blob whose receipt has yet to reach the operation journal.
   * @param {import('node:fs/promises').FileHandle} handle
   * @param {readonly string[]} names @param {ArtifactRetention} policy
   */
  async function retainArtifacts(handle, names, policy) {
    const operations = [];
    const slots = new Set();
    for (const name of names) {
      if (!snapshotName.test(name)) continue;
      const slot = name.slice(0, 64);
      if (slots.has(slot)) return;
      slots.add(slot);
      const operation = await read(name).catch(() => undefined);
      if (!operation) return;
      operations.push(operation);
    }
    for (const hash of expiredArtifacts(operations, new Set(names), policy, Date.now())) {
      try {
        // Persist the reason before unlink. A blob left by an interruption
        // remains readable and is eligible for a later maintenance pass.
        await publish(handle, 'artifact-' + hash + '.retention', '');
        await io.unlink(join(root, 'artifact-' + hash + '.blob'));
        await handle.sync();
      } catch {
        // Maintenance is best-effort. The immutable operation is still usable.
      }
    }
  }

  return {
    open(retention) {
      return serialize(async () => {
        if (directoryHandle) return;
        if (retention && (retention.maxAgeMs === undefined && retention.maxBytes === undefined ||
            [retention.maxAgeMs, retention.maxBytes].some(value => value !== undefined &&
              (!Number.isSafeInteger(value) || value < 0)))) throw new RangeError('Invalid artifact retention policy');
        let handle;
        let lock;
        try {
          handle = await io.open(root, constants.O_RDONLY | constants.O_DIRECTORY);
          // SQLite owns the interprocess lock. This connection never writes
          // an operation or removes the shared lock file.
          lock = acquireWriter(root);
          const names = await io.readdir(root);
          for (const name of names) {
            if (temporaryName.test(name)) await io.unlink(join(root, name)).catch(() => {});
          }
          if (retention) await retainArtifacts(handle, names, retention);
        } catch (error) {
          lock?.close();
          await handle?.close().catch(() => {});
          throw writerError(error);
        }
        owner = lock;
        directoryHandle = handle;
      });
    },

    async load(operationId) {
      requireOpen();
      return load(operationId);
    },

    async list(requestId) {
      requireOpen();
      const names = (await snapshotNames()).sort();
      const duplicates = new Set(names.filter((name, index) => index > 0 &&
        name.slice(0, 64) === names[index - 1].slice(0, 64)).map(name => name.slice(0, 64)));
      const requested = requestId === undefined ? undefined : key(requestId);
      const entries = await Promise.all(names.map(async name => {
        /** @type {SnapshotUnavailableReason} */
        let reason = 'corrupt_snapshot';
        const [, slot, requestKey] = snapshotName.exec(name) ?? [];
        if (!duplicates.has(slot)) {
          try {
            return await read(name);
          } catch (error) {
            if (!(error instanceof LocalStoreError)) throw error;
            reason = error.reason === 'unsupported_version' || error.reason === 'corrupt_snapshot' ? error.reason : 'io';
          }
        }
        /** @type {StateListEntry} */
        const unavailable = { kind: 'unavailable', ref: 'state:' + slot, reason };
        if (requested && requested === requestKey) unavailable.requestMatch = true;
        if (requested && !requestKey) unavailable.requestMatch = 'unknown';
        return unavailable;
      }));
      return entries.filter(entry => entry !== undefined);
    },

    commit(operationId, expectedRevision, next) {
      return serialize(async () => {
        /** @type {CommitResult} */
        const unavailable = { kind: 'unavailable' };
        try {
          const handle = requireOpen();
          const slot = key(operationId);
          const existing = await locate(slot);
          const previous = existing ? await read(existing) : undefined;
          const name = existing ?? slot + '-' + key(next.request.requestId) + '.json';
          if ((previous?.revision ?? null) !== expectedRevision) return { kind: 'conflict' };
          if (next.operationId !== operationId ||
              (previous && !sameRecord(next.request, previous.request))) return unavailable;
          if (previous && next.revision === previous.revision) {
            if (!sameRecord(previous, next)) return { kind: 'conflict' };
            await handle.sync();
            return { kind: 'committed' };
          }
          if (next.revision !== (expectedRevision ?? -1) + 1) return unavailable;
          await publish(handle, name, encodeSnapshot(next));
          return { kind: 'committed' };
        } catch {
          return unavailable;
        }
      });
    },

    async writeArtifact(bytes, maxBytes) {
      checkBound(maxBytes);
      const originalSize = bytes.byteLength;
      const data = Buffer.from(bytes.subarray(0, maxBytes));
      const hash = hashBytes(data);
      return serialize(async () => {
        const handle = requireOpen();
        try {
          verifiedCache = undefined;
          await publish(handle, 'artifact-' + hash + '.blob', data);
          if (await hasRetentionMarker(hash)) {
            await io.unlink(join(root, 'artifact-' + hash + '.retention')).then(() => handle.sync()).catch(() => {});
          }
        } catch (error) {
          throw new LocalStoreError('io', error);
        }
        return { ref: 'sha256:' + hash, size: data.length, originalSize, truncated: data.length < originalSize };
      });
    },

    async readArtifact(reference, maxBytes) {
      checkBound(maxBytes);
      requireOpen();
      if (reference.size > maxBytes) return {kind:'unavailable'};
      const result = await verifiedArtifact(reference);
      return result.kind === 'available'
        ? {kind:'available',bytes:Buffer.from(result.bytes)} : result;
    },

    async readArtifactSlice(reference, offset, length) {
      checkBound(length);
      requireOpen();
      if (!Number.isSafeInteger(offset) || offset < 0 ||
          !Number.isSafeInteger(reference.size) || offset > reference.size) {
        return {kind:'integrity_error'};
      }
      const result = await verifiedArtifact(reference);
      return result.kind === 'available'
        ? {kind:'available',bytes:Buffer.from(result.bytes.subarray(offset,Math.min(reference.size,offset+length)))}
        : result;
    },

    async artifactPresence(reference) {
      requireOpen();
      const hash = artifactRef.exec(reference.ref)?.[1];
      if (!hash) return 'missing';
      try {
        const file = await io.open(join(root, 'artifact-' + hash + '.blob'), 'r');
        await file.close();
        return 'present';
      } catch (error) {
        return isMissing(error) && await hasRetentionMarker(hash) ? 'retention' : 'missing';
      }
    },

    close() {
      return serialize(async () => {
        const handle = directoryHandle;
        directoryHandle = undefined;
        verifiedCache = undefined;
        try {
          try {
            await handle?.close();
          } finally {
            owner?.close();
            owner = undefined;
          }
        } catch (error) {
          throw new LocalStoreError('io', error);
        }
      });
    },
  };
}
