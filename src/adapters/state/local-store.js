import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { constants as bufferLimits } from 'node:buffer';
import * as fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sameRecord } from '../../core/operation.js';
import { decodeSnapshot, encodeSnapshot } from '../../core/snapshot.js';

/** @import {CommitResult, StateStore} from '../../core/ports.js' */
/** @import {Operation} from '../../core/operation.js' */

const snapshotName = /^[a-f0-9]{64}\.json$/u;
const artifactRef = /^sha256:([a-f0-9]{64})$/u;
const temporaryName = /^\.state-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.tmp$/u;
const utf8 = new TextDecoder('utf-8', { fatal: true });

/** @typedef {{ref: string, size: number, originalSize: number, truncated: boolean}} ArtifactReference */
/** @typedef {{kind: 'available', bytes: Uint8Array} | {kind: 'unavailable' | 'integrity_error'}} ArtifactRead */
/** @typedef {{
 *   writeArtifact: (bytes: Uint8Array, maxBytes: number) => Promise<ArtifactReference>,
 *   readArtifact: (reference: ArtifactReference, maxBytes: number) => Promise<ArtifactRead>
 * }} ArtifactStore */

/** @param {Uint8Array} bytes */
const hashBytes = bytes => createHash('sha256').update(bytes).digest('hex');

/** @param {number} maxBytes */
function checkBound(maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes >= bufferLimits.MAX_LENGTH) {
    throw new RangeError('Invalid artifact byte bound');
  }
}

/** @param {string} id */
function filename(id) {
  return createHash('sha256').update(id, 'utf16le').digest('hex') + '.json';
}

export class LocalStoreError extends Error {
  /** @param {'io' | 'closed' | 'corrupt_snapshot' | 'unsupported_version' | 'in_use'} reason @param {unknown} [cause] */
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
    if (filename(parsed.value.operationId) !== name) throw new LocalStoreError('corrupt_snapshot');
    return parsed.value;
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

  return {
    open() {
      return serialize(async () => {
        if (directoryHandle) return;
        let handle;
        let lock;
        try {
          handle = await io.open(root, constants.O_RDONLY | constants.O_DIRECTORY);
          // SQLite owns the interprocess lock. This connection never writes
          // an operation or removes the shared lock file.
          lock = new DatabaseSync(join(root, '.writer.sqlite'), { timeout: 0 });
          lock.exec('BEGIN IMMEDIATE');
          for (const name of await io.readdir(root)) {
            if (temporaryName.test(name)) await io.unlink(join(root, name)).catch(() => {});
          }
        } catch (error) {
          lock?.close();
          await handle?.close().catch(() => {});
          const busy = error instanceof Error && 'errcode' in error && typeof error.errcode === 'number' &&
            (error.errcode & 0xff) === 5; // SQLITE_BUSY, including extended codes
          throw new LocalStoreError(busy ? 'in_use' : 'io', error);
        }
        owner = lock;
        directoryHandle = handle;
      });
    },

    async load(operationId) {
      requireOpen();
      return read(filename(operationId));
    },

    async list() {
      requireOpen();
      let names;
      try {
        names = await io.readdir(root);
      } catch (error) {
        throw new LocalStoreError('io', error);
      }
      const entries = await Promise.all(names.filter(name => snapshotName.test(name)).sort().map(read));
      return entries.filter(entry => entry !== undefined);
    },

    commit(operationId, expectedRevision, next) {
      return serialize(async () => {
        /** @type {CommitResult} */
        const unavailable = { kind: 'unavailable' };
        try {
          const handle = requireOpen();
          const name = filename(operationId);
          const previous = await read(name);
          if ((previous?.revision ?? null) !== expectedRevision) return { kind: 'conflict' };
          if (next.operationId !== operationId) return unavailable;
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
          await publish(handle, 'artifact-' + hash + '.blob', data);
        } catch (error) {
          throw new LocalStoreError('io', error);
        }
        return { ref: 'sha256:' + hash, size: data.length, originalSize, truncated: data.length < originalSize };
      });
    },

    async readArtifact(reference, maxBytes) {
      checkBound(maxBytes);
      requireOpen();
      const match = artifactRef.exec(reference.ref);
      if (!match || !Number.isSafeInteger(reference.size) || reference.size < 0 ||
          !Number.isSafeInteger(reference.originalSize) || reference.originalSize < reference.size ||
          reference.truncated !== (reference.size < reference.originalSize)) return { kind: 'integrity_error' };
      if (reference.size > maxBytes) return { kind: 'unavailable' };

      try {
        const file = await io.open(join(root, 'artifact-' + match[1] + '.blob'), 'r');
        try {
          // Read one extra byte to distinguish a longer or changing file.
          const data = Buffer.allocUnsafe(reference.size + 1);
          let offset = 0;
          while (offset < data.length) {
            const { bytesRead } = await file.read(data, offset, data.length - offset, offset);
            if (!bytesRead) break;
            offset += bytesRead;
          }
          const bytes = data.subarray(0, offset);
          if (offset !== reference.size || hashBytes(bytes) !== match[1]) return { kind: 'integrity_error' };
          return { kind: 'available', bytes };
        } finally {
          await file.close();
        }
      } catch {
        return { kind: 'unavailable' };
      }
    },

    close() {
      return serialize(async () => {
        const handle = directoryHandle;
        directoryHandle = undefined;
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
