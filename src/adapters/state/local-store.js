import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { decodeSnapshot, encodeSnapshot } from '../../core/snapshot.js';

/** @import {CommitResult, StateStore} from '../../core/ports.js' */
/** @import {Operation} from '../../core/operation.js' */

const snapshotName = /^[a-f0-9]{64}\.json$/u;

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
 * @returns {StateStore}
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
      content = await io.readFile(join(root, name), 'utf8');
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw new LocalStoreError('io', error);
    }
    const parsed = decodeSnapshot(content);
    if (parsed.kind !== 'accepted') {
      throw new LocalStoreError(parsed.kind === 'corrupt' ? 'corrupt_snapshot' : parsed.kind);
    }
    if (filename(parsed.value.operationId) !== name) throw new LocalStoreError('corrupt_snapshot');
    return parsed.value;
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
        let tmp;
        try {
          const handle = requireOpen();
          const name = filename(operationId);
          const previous = await read(name);
          if ((previous?.revision ?? null) !== expectedRevision) return { kind: 'conflict' };
          if (next.operationId !== operationId || next.revision !== (expectedRevision ?? -1) + 1) return unavailable;
          const content = encodeSnapshot(next);
          const path = join(root, '.snapshot-' + randomUUID() + '.tmp');
          const file = await io.open(path, 'wx', 0o600);
          tmp = path;
          try {
            await file.writeFile(content, 'utf8');
            await file.sync();
          } finally {
            await file.close();
          }
          await io.rename(tmp, join(root, name));
          tmp = undefined;
          // Rename made the complete snapshot visible. If directory sync
          // fails, the caller must load to learn which revision is present.
          await handle.sync();
          return { kind: 'committed' };
        } catch {
          return unavailable;
        } finally {
          if (tmp) await io.unlink(tmp).catch(() => {});
        }
      });
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
