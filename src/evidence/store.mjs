// Scoped, content-addressed persistence for *derived* evidence. It never
// supersedes a workflow checkpoint, its security policy, or source freshness.
import { mkdir, lstat, open, readdir, rename, rm } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { projectName } from '../project.mjs';
import { validatedReviewObservations } from '../review-evidence-runtime.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const idPattern = /^[a-zA-Z0-9._-]{1,160}$/;
const MAX_RECORD_BYTES = 128 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_RECORDS = 1024;
const queues = new Map();
function validateId(id) {
  if (typeof id !== 'string' || !idPattern.test(id) || id === '.' || id === '..')
    throw new Error('Invalid evidence operation id');
  return id;
}
function location(root) {
  return path.resolve(root ?? path.join(process.env.AGENT_STATE_DIR ??
    (process.env.XDG_STATE_HOME ? path.join(process.env.XDG_STATE_HOME, projectName) : path.join(homedir(), '.local/state', projectName)), 'evidence'));
}
async function secureDir(dir) {
  try {
    const existing = await lstat(dir);
    if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error('Unsafe evidence storage directory');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const created = await lstat(dir);
    if (!created.isDirectory() || created.isSymbolicLink()) throw new Error('Unsafe evidence storage directory');
  }
}
async function withLock(key, fn) {
  const preceding = queues.get(key) ?? Promise.resolve();
  const running = preceding.catch(() => {}).then(fn);
  queues.set(key, running);
  try { return await running; } finally { if (queues.get(key) === running) queues.delete(key); }
}
async function atomicWrite(file, buffer) {
  const temp = `${file}.tmp-${randomUUID()}`;
  let handle;
  try {
    handle = await open(temp, 'wx', 0o600);
    await handle.writeFile(buffer);
    await handle.sync();
    await handle.close(); handle = null;
    await rename(temp, file);
    const dir = await open(path.dirname(file), 'r');
    try { await dir.sync(); } finally { await dir.close(); }
  } finally {
    await handle?.close().catch(() => {});
    await rm(temp, { force: true }).catch(() => {});
  }
}
async function safeReadFile(file, maxBytes) {
  const prior = await lstat(file);
  if (!prior.isFile() || prior.isSymbolicLink() || prior.size > maxBytes)
    throw new Error('Unsafe evidence file');
  const handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const actual = await handle.stat();
    if (!actual.isFile() || actual.dev !== prior.dev || actual.ino !== prior.ino || actual.size > maxBytes)
      throw new Error('Evidence file changed during read');
    const data = await handle.readFile();
    if (data.length > maxBytes) throw new Error('Evidence file exceeds size limit');
    return data;
  } finally { await handle.close(); }
}
function validatedGraph(graph) {
  if (!graph || graph.version !== 2 || !Array.isArray(graph.evidence) ||
      !Array.isArray(graph.obligations) || graph.evidence.length > MAX_RECORDS ||
      graph.obligations.length > MAX_RECORDS || typeof graph.sourceKey !== 'string')
    throw new Error('Invalid evidence graph');
  return graph;
}
// Publish blobs before the manifest. A failed publication cannot make an
// incomplete snapshot authoritative; unreferenced blobs are harmless.
export async function persistEvidenceSnapshot({ operationId, scopeKey, graph, root } = {}) {
  validateId(operationId);
  if (typeof scopeKey !== 'string' || !scopeKey || scopeKey.length > 256) throw new Error('Invalid evidence scope');
  validatedGraph(graph);
  const base = location(root);
  return withLock(`${base}:${operationId}`, async () => {
    await secureDir(base);
    const dir = path.join(base, operationId);
    await secureDir(dir);
    const blobDir = path.join(dir, 'objects');
    await secureDir(blobDir);
    const refs = [];
    for (const record of graph.evidence) {
      // Evidence bodies are bounded references, not arbitrary model transcripts.
      const serialized = Buffer.from(JSON.stringify({ version: 1, record }), 'utf8');
      if (serialized.length > MAX_RECORD_BYTES) throw new Error('Evidence record size limit exceeded');
      const digest = sha(serialized);
      const file = path.join(blobDir, digest);
      try {
        const existing = await lstat(file);
        if (!existing.isFile() || existing.isSymbolicLink() || sha(await safeReadFile(file,MAX_RECORD_BYTES)) !== digest)
          throw new Error('Evidence object is corrupt');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await atomicWrite(file, serialized);
      }
      refs.push({ id: record.id, digest });
    }
    const manifest = { version: 1, operationId, scopeKey, sourceKey: graph.sourceKey,
      createdAt: new Date().toISOString(), refs,
      // Review-only tool observations are bounded and never upgrade v3 Unit proof.
      verificationObservations: validatedReviewObservations(graph.verificationObservations, graph.sourceKey),
      obligations: graph.obligations.map(({ id, status, evidenceIds, dependencies }) =>
        ({ id, status, evidenceIds, dependencies })) };
    const bytes = Buffer.from(JSON.stringify(manifest), 'utf8');
    if (bytes.length > MAX_MANIFEST_BYTES) throw new Error('Evidence manifest size limit exceeded');
    await atomicWrite(path.join(dir, 'manifest.json'), bytes);
    // Reclaim superseded objects only AFTER durable manifest publication.
    // Never delete arbitrary names or follow symbolic links while cleaning.
    const live = new Set(refs.map(row => row.digest));
    for (const entry of await readdir(blobDir)) {
      if (!/^[a-f0-9]{64}$/.test(entry) || live.has(entry)) continue;
      const stale = path.join(blobDir, entry);
      const metadata = await lstat(stale);
      if (metadata.isFile() || metadata.isSymbolicLink()) await rm(stale, { force:true });
    }
    return { version: 1, records: refs.length, digest: sha(bytes) };
  });
}
export async function loadEvidenceSnapshot({ operationId, scopeKey, sourceKey, root } = {}) {
  validateId(operationId);
  if (typeof scopeKey !== 'string' || typeof sourceKey !== 'string') return null;
  const dir = path.join(location(root), operationId);
  let raw;
  try {
    await secureExisting(dir);
    raw = await safeReadFile(path.join(dir, 'manifest.json'),MAX_MANIFEST_BYTES);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (raw.length > MAX_MANIFEST_BYTES) throw new Error('Evidence manifest is oversized');
  const manifest = JSON.parse(raw);
  if (manifest.version !== 1 || manifest.operationId !== operationId ||
      manifest.scopeKey !== scopeKey || manifest.sourceKey !== sourceKey ||
      !Array.isArray(manifest.refs) || manifest.refs.length > MAX_RECORDS ||
      !Array.isArray(manifest.obligations)) return null;
  // NOFOLLOW on a file is not sufficient when its parent objects directory
  // can itself be replaced by a symbolic link.
  await secureExisting(path.join(dir, 'objects'));
  const records = [];
  for (const ref of manifest.refs) {
    if (typeof ref.id !== 'string' || !/^[a-f0-9]{64}$/.test(ref.digest)) throw new Error('Invalid evidence object ref');
    const file = path.join(dir, 'objects', ref.digest);
    const status = await lstat(file);
    if (!status.isFile() || status.isSymbolicLink() || status.size > MAX_RECORD_BYTES) throw new Error('Unsafe evidence object');
    const content = await safeReadFile(file,MAX_RECORD_BYTES);
    if (sha(content) !== ref.digest) throw new Error('Evidence object integrity mismatch');
    const object = JSON.parse(content);
    if (object.version !== 1 || object.record?.id !== ref.id) throw new Error('Evidence object identity mismatch');
    records.push(object.record);
  }
  return { version: 2, sourceKey, evidence: records, obligations: manifest.obligations,
    verificationObservations: validatedReviewObservations(manifest.verificationObservations, sourceKey),
    persistentBacking: 'review_checkpoint_v3', completeness: 'model_reported_only' };
}
async function secureExisting(dir) {
  const existing = await lstat(dir);
  if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error('Unsafe evidence directory');
}
export async function deleteEvidenceSnapshot(operationId, { root } = {}) {
  validateId(operationId);
  const base = location(root);
  return withLock(`${base}:${operationId}`, async () => {
    try { await secureExisting(path.join(base, operationId)); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    await rm(path.join(base, operationId), { recursive: true });
  });
}
