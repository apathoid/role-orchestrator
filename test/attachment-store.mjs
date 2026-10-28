import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = await mkdtemp(path.join(tmpdir(), 'role-orchestrator-attachments-'));
process.env.AGENT_STATE_DIR = root;

const {
  __attachmentStoreInternals,
  buildHistoricalAttachmentBlocks,
  cleanupSessionAttachments,
  loadAttachmentById,
  persistTurnAttachments,
  reconcileAttachmentStore,
} = await import('../src/attachment-store.mjs');
const { saveSession, loadSession, deleteSession } = await import('../src/session-store.mjs');

const image = (text, mimeType = 'image/png') => ({ type: 'image', data: Buffer.from(text).toString('base64'), mimeType });
const textResource = (text, uri = 'file:///context.txt') => ({
  type: 'resource',
  resource: { uri, mimeType: 'text/plain', text },
});
const blobResource = (text, uri = 'file:///context.bin') => ({
  type: 'resource',
  resource: { uri, mimeType: 'application/octet-stream', blob: Buffer.from(text).toString('base64') },
});
const linkResource = (uri = 'https://example.invalid/context') => ({
  type: 'resource_link',
  name: 'linked context',
  uri,
  mimeType: 'text/plain',
  description: 'Do not fetch automatically',
});

function baseSession(transcript = []) {
  return {
    cwd: '/tmp/project',
    repoRoot: '/tmp/project',
    createdAt: '2026-09-26T00:00:00.000Z',
    history: [],
    transcript,
    title: null,
  };
}

function runNode(code) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      cwd: new URL('..', import.meta.url).pathname,
      env: { ...process.env, AGENT_STATE_DIR: root },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => stdout += chunk);
    child.stderr.on('data', (chunk) => stderr += chunk);
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr || stdout)));
  });
}

async function blobFiles(sessionId) {
  const dir = __attachmentStoreInternals.sessionAttachmentDir(sessionId);
  const names = await readdir(dir).catch(() => []);
  return names.filter((name) => /^[a-f0-9]{64}$/.test(name));
}

async function persistSuccessfulTurn(sessionId, block, user = 'turn', assistant = 'answer', limits = undefined) {
  const tx = await persistTurnAttachments(sessionId, Array.isArray(block) ? block : [block], { limits });
  const session = baseSession([{ user, assistant, attachments: tx.attachments }]);
  await saveSession(sessionId, session);
  await tx.commitSucceeded();
  return { tx, session };
}

// 1 + 2. Turn-1 image survives persistence and process-style reload, then is rehydrated.
{
  const sessionId = 'historical-image';
  const { tx } = await persistSuccessfulTurn(sessionId, image('turn-one-image'));
  assert.equal(tx.attachments[0].persisted, true);
  assert.match(tx.attachments[0].blob, /^sha256:[a-f0-9]{64}$/);
  const loaded = await loadSession(sessionId);
  const historical = await buildHistoricalAttachmentBlocks(sessionId, loaded.transcript);
  assert.equal(historical.blocks.length, 2);
  assert.match(historical.blocks[0].text, /historical outer user attachment/i);
  assert.equal(historical.blocks[1].type, 'image');
  assert.equal(Buffer.from(historical.blocks[1].data, 'base64').toString(), 'turn-one-image');
  const childOutput = await runNode(`
    const { loadSession } = await import('./src/session-store.mjs');
    const { buildHistoricalAttachmentBlocks } = await import('./src/attachment-store.mjs');
    const session = await loadSession('${sessionId}');
    const historical = await buildHistoricalAttachmentBlocks('${sessionId}', session.transcript);
    const image = historical.blocks.find((block) => block.type === 'image');
    console.log(Buffer.from(image.data, 'base64').toString());
  `);
  assert.equal(childOutput, 'turn-one-image', 'historical image must survive a fresh Node process');
  const direct = await loadAttachmentById(sessionId, loaded.transcript, tx.attachments[0].id);
  assert.equal(Buffer.from(direct.block.data, 'base64').toString(), 'turn-one-image');
  await deleteSession(sessionId);
}

// 3. Current media remains independent and follows historical media in the invocation payload.
{
  const sessionId = 'current-plus-history';
  const { session } = await persistSuccessfulTurn(sessionId, image('old'));
  const historical = await buildHistoricalAttachmentBlocks(sessionId, session.transcript);
  const current = image('current');
  const promptBlocks = [...historical.blocks, current];
  assert.equal(Buffer.from(promptBlocks.at(-1).data, 'base64').toString(), 'current');
  assert.equal(Buffer.from(promptBlocks[1].data, 'base64').toString(), 'old');
  await deleteSession(sessionId);
}

// 4. Historical selection is bounded and prefers the most recent attachments.
{
  const sessionId = 'bounded-history';
  const transcript = [];
  for (const value of ['one', 'two', 'three']) {
    const tx = await persistTurnAttachments(sessionId, [image(value)]);
    transcript.push({ user: value, assistant: 'ok', attachments: tx.attachments });
    await saveSession(sessionId, baseSession(transcript));
    await tx.commitSucceeded();
  }
  const bounded = await buildHistoricalAttachmentBlocks(sessionId, transcript, {
    limits: { maxHistoricalItems: 2, maxHistoricalBytes: 1024 },
  });
  assert.equal(bounded.selected.length, 2);
  assert.deepEqual(bounded.selected.map((x) => x.turnIndex), [1, 2]);
  assert.deepEqual(bounded.blocks.filter((x) => x.type === 'image').map((x) => Buffer.from(x.data, 'base64').toString()), ['two', 'three']);
  const byteBounded = await buildHistoricalAttachmentBlocks(sessionId, transcript, {
    limits: { maxHistoricalItems: 8, maxHistoricalBytes: 5 },
  });
  assert.deepEqual(byteBounded.blocks.filter((x) => x.type === 'image').map((x) => Buffer.from(x.data, 'base64').toString()), ['three']);
  const unavailableNewest = {
    user: 'too large', assistant: 'ok',
    attachments: [{ id: 'att_unavailable1234', type: 'image', mimeType: 'image/png', size: 999, payloadKind: 'base64', persisted: false, reason: 'single_attachment_limit' }],
  };
  const availableDespiteNewerFailure = await buildHistoricalAttachmentBlocks(sessionId, [...transcript, unavailableNewest], {
    limits: { maxHistoricalItems: 1, maxHistoricalBytes: 1024 },
  });
  assert.deepEqual(availableDespiteNewerFailure.blocks.filter((x) => x.type === 'image').map((x) => Buffer.from(x.data, 'base64').toString()), ['three']);
  await deleteSession(sessionId);
}

// 5. Same content in one session deduplicates to one content-addressed blob.
{
  const sessionId = 'dedup';
  const tx = await persistTurnAttachments(sessionId, [image('same'), image('same')]);
  assert.equal(tx.attachments[0].blob, tx.attachments[1].blob);
  await saveSession(sessionId, baseSession([{ user: 'dup', assistant: 'ok', attachments: tx.attachments }]));
  await tx.commitSucceeded();
  assert.equal((await blobFiles(sessionId)).length, 1);
  await deleteSession(sessionId);
}

// A dedup hit on a previously orphaned blob is pending-protected until its new reference commits.
{
  const sessionId = 'dedup-orphan-reuse';
  const orphan = await persistTurnAttachments(sessionId, [image('same-orphan')]);
  await orphan.commitFailed();
  assert.equal((await blobFiles(sessionId)).length, 1);
  const reuse = await persistTurnAttachments(sessionId, [image('same-orphan')]);
  const oldDurable = baseSession([{ user: 'before', assistant: 'ok', attachments: [] }]);
  await saveSession(sessionId, oldDurable);
  assert.equal((await blobFiles(sessionId)).length, 1, 'dedup-hit pending marker must protect orphan reuse');
  const committed = baseSession([{ user: 'after', assistant: 'ok', attachments: reuse.attachments }]);
  await saveSession(sessionId, committed);
  await reuse.commitSucceeded();
  assert.equal((await blobFiles(sessionId)).length, 1);
  await deleteSession(sessionId);
}

// 6. Transcript trimming commits first, then eagerly removes newly unreachable blobs.
{
  const sessionId = 'trim';
  const tx1 = await persistTurnAttachments(sessionId, [image('old-blob')]);
  const tx2 = await persistTurnAttachments(sessionId, [image('new-blob')]);
  const first = { user: 'old', assistant: 'ok', attachments: tx1.attachments };
  const second = { user: 'new', assistant: 'ok', attachments: tx2.attachments };
  await saveSession(sessionId, baseSession([first, second]));
  await tx1.commitSucceeded(); await tx2.commitSucceeded();
  assert.equal((await blobFiles(sessionId)).length, 2);
  await saveSession(sessionId, baseSession([second]));
  assert.equal((await blobFiles(sessionId)).length, 1);
  assert.equal((await blobFiles(sessionId))[0], tx2.attachments[0].blob.slice('sha256:'.length));
  await deleteSession(sessionId);
}

// 7. Explicit session deletion eagerly removes its attachment directory.
{
  const sessionId = 'delete-cleanup';
  await persistSuccessfulTurn(sessionId, image('delete-me'));
  await deleteSession(sessionId);
  await assert.rejects(() => stat(__attachmentStoreInternals.sessionAttachmentDir(sessionId)), (error) => error?.code === 'ENOENT');
}

// 8. Crash orphan is retained during grace, then startup/periodic reconciliation collects it.
{
  const sessionId = 'orphan-crash';
  const tx = await persistTurnAttachments(sessionId, [image('orphan')]);
  assert.equal((await blobFiles(sessionId)).length, 1);
  await reconcileAttachmentStore({ now: Date.now(), limits: { orphanGraceMs: 60_000 } });
  assert.equal((await blobFiles(sessionId)).length, 1, 'fresh pending blob must survive GC');
  await reconcileAttachmentStore({ now: Date.now() + 120_000, limits: { orphanGraceMs: 1 } });
  assert.equal((await blobFiles(sessionId)).length, 0, 'expired orphan must be collected');
  await tx.commitFailed();
  await rm(__attachmentStoreInternals.sessionAttachmentDir(sessionId), { recursive: true, force: true });
}

// 9. A missing referenced blob degrades to an explicit historical marker, not a session failure.
{
  const sessionId = 'missing-blob';
  const { session, tx } = await persistSuccessfulTurn(sessionId, image('missing'));
  await rm(__attachmentStoreInternals.blobPath(sessionId, tx.attachments[0].blob), { force: true });
  const historical = await buildHistoricalAttachmentBlocks(sessionId, session.transcript);
  assert.equal(historical.unavailable[0].reason, 'missing_blob');
  assert.match(historical.blocks[0].text, /unavailable/i);
  await deleteSession(sessionId);
}

// 10. Corrupted payload and corrupted metadata are isolated instead of crashing the session.
{
  const sessionId = 'corruption';
  const { session, tx } = await persistSuccessfulTurn(sessionId, image('good'));
  await writeFile(__attachmentStoreInternals.blobPath(sessionId, tx.attachments[0].blob), Buffer.from('bad'));
  const historical = await buildHistoricalAttachmentBlocks(sessionId, session.transcript);
  assert.match(historical.unavailable[0].reason, /size_mismatch|hash_mismatch/);

  const file = path.join(root, 'sessions', `${sessionId}.json`);
  const parsed = JSON.parse(await readFile(file, 'utf8'));
  parsed.transcript[0].attachments.push({ id: '../../bad', type: 'image', persisted: true, blob: 'sha256:../../etc/passwd', payloadKind: 'base64' });
  await writeFile(file, JSON.stringify(parsed));
  const loaded = await loadSession(sessionId);
  assert.equal(loaded.transcript[0].attachments.length, 1);
  await deleteSession(sessionId);
}

// 11. Failed serialization leaves the last atomically committed session readable.
{
  const sessionId = 'atomic-save';
  await saveSession(sessionId, baseSession([{ user: 'stable', assistant: 'stable', attachments: [] }]));
  const cyclic = {}; cyclic.self = cyclic;
  await assert.rejects(() => saveSession(sessionId, { ...baseSession([]), profileOverrides: cyclic }), /circular|cyclic/i);
  const loaded = await loadSession(sessionId);
  assert.equal(loaded.transcript[0].user, 'stable');
  await deleteSession(sessionId);
}

// Failed final session save releases pending protection and permits cleanup against the last durable transcript.
{
  const sessionId = 'attachment-save-failure';
  const durable = baseSession([{ user: 'before', assistant: 'ok', attachments: [] }]);
  await saveSession(sessionId, durable);
  const tx = await persistTurnAttachments(sessionId, [image('pending-final-save')]);
  const cyclic = {}; cyclic.self = cyclic;
  await assert.rejects(() => saveSession(sessionId, {
    ...baseSession([{ user: 'after', assistant: 'no', attachments: tx.attachments }]),
    profileOverrides: cyclic,
  }), /circular|cyclic/i);
  await tx.commitFailed();
  await cleanupSessionAttachments(sessionId, durable.transcript);
  assert.equal((await blobFiles(sessionId)).length, 0);
  assert.equal((await loadSession(sessionId)).transcript[0].user, 'before');
  await deleteSession(sessionId);
}

// A normal session/config save while an attachment is pending cannot collect the in-flight blob.
{
  const sessionId = 'pending-save-race';
  const durable = baseSession([{ user: 'before', assistant: 'ok', attachments: [] }]);
  await saveSession(sessionId, durable);
  const tx = await persistTurnAttachments(sessionId, [image('pending-during-save')]);
  await saveSession(sessionId, durable);
  assert.equal((await blobFiles(sessionId)).length, 1);
  const committed = baseSession([...durable.transcript, { user: 'after', assistant: 'ok', attachments: tx.attachments }]);
  await saveSession(sessionId, committed);
  await tx.commitSucceeded();
  assert.equal((await blobFiles(sessionId)).length, 1);
  await deleteSession(sessionId);
}

// 12. Same-process concurrent saves are serialized; invocation order is durable.
{
  const sessionId = 'concurrent-save';
  const big = baseSession([{ user: 'first', assistant: 'x'.repeat(2_000_000), attachments: [] }]);
  const last = baseSession([{ user: 'second', assistant: 'last', attachments: [] }]);
  await Promise.all([saveSession(sessionId, big), saveSession(sessionId, last)]);
  const loaded = await loadSession(sessionId);
  assert.equal(loaded.transcript[0].user, 'second');
  await deleteSession(sessionId);
}

// 13. Oversized current attachments still work for the current turn, but persistence is explicitly refused.
{
  const sessionId = 'oversized';
  const block = image('0123456789');
  const tx = await persistTurnAttachments(sessionId, [block], { limits: { maxSingleBytes: 4, maxTurnBytes: 100, maxSessionBytes: 100, maxGlobalBytes: 1000 } });
  assert.equal(tx.attachments[0].persisted, false);
  assert.equal(tx.attachments[0].reason, 'single_attachment_limit');
  assert.equal((await blobFiles(sessionId)).length, 0);
  await tx.commitFailed();
  await rm(__attachmentStoreInternals.sessionAttachmentDir(sessionId), { recursive: true, force: true });
}

// Per-turn decoded-byte quota is independent of the single-attachment limit.
{
  const sessionId = 'turn-quota';
  const tx = await persistTurnAttachments(sessionId, [image('1234'), image('5678')], { limits: { maxSingleBytes: 10, maxTurnBytes: 6, maxSessionBytes: 100, maxGlobalBytes: 1000 } });
  assert.equal(tx.attachments[0].persisted, true);
  assert.equal(tx.attachments[1].persisted, false);
  assert.equal(tx.attachments[1].reason, 'turn_quota');
  await tx.commitFailed();
  await cleanupSessionAttachments(sessionId, []);
  await rm(__attachmentStoreInternals.sessionAttachmentDir(sessionId), { recursive: true, force: true });
}

// 14. Per-session quota refuses only the new persistence attempt and keeps existing references intact.
{
  const sessionId = 'session-quota';
  const first = await persistTurnAttachments(sessionId, [image('12345')], { limits: { maxSingleBytes: 100, maxTurnBytes: 100, maxSessionBytes: 8, maxGlobalBytes: 1000, orphanGraceMs: 60_000 } });
  const transcript = [{ user: 'one', assistant: 'ok', attachments: first.attachments }];
  await saveSession(sessionId, baseSession(transcript)); await first.commitSucceeded();
  const second = await persistTurnAttachments(sessionId, [image('abcde')], { limits: { maxSingleBytes: 100, maxTurnBytes: 100, maxSessionBytes: 8, maxGlobalBytes: 1000, orphanGraceMs: 60_000 } });
  assert.equal(second.attachments[0].persisted, false);
  assert.equal(second.attachments[0].reason, 'session_quota');
  assert.equal((await blobFiles(sessionId)).length, 1);
  await second.commitFailed();
  await deleteSession(sessionId);
}

// 15. Global quota never evicts referenced blobs; it refuses a new session's payload instead.
{
  const one = 'global-one', two = 'global-two';
  const first = await persistTurnAttachments(one, [image('12345')], { limits: { maxSingleBytes: 100, maxTurnBytes: 100, maxSessionBytes: 100, maxGlobalBytes: 8, orphanGraceMs: 60_000 } });
  await saveSession(one, baseSession([{ user: 'one', assistant: 'ok', attachments: first.attachments }])); await first.commitSucceeded();
  const second = await persistTurnAttachments(two, [image('abcde')], { limits: { maxSingleBytes: 100, maxTurnBytes: 100, maxSessionBytes: 100, maxGlobalBytes: 8, orphanGraceMs: 60_000 } });
  assert.equal(second.attachments[0].persisted, false);
  assert.equal(second.attachments[0].reason, 'global_quota');
  assert.equal((await blobFiles(one)).length, 1);
  assert.equal((await blobFiles(two)).length, 0);
  await second.commitFailed();
  await deleteSession(one); await rm(__attachmentStoreInternals.sessionAttachmentDir(two), { recursive: true, force: true });
}

// Concurrent global-quota admissions are serialized in-process and cannot both overshoot the limit.
{
  const limits = { maxSingleBytes: 100, maxTurnBytes: 100, maxSessionBytes: 100, maxGlobalBytes: 8, orphanGraceMs: 60_000 };
  const [a, b] = await Promise.all([
    persistTurnAttachments('quota-race-a', [image('aaaaa')], { limits }),
    persistTurnAttachments('quota-race-b', [image('bbbbb')], { limits }),
  ]);
  const persisted = [a, b].filter((tx) => tx.attachments[0].persisted);
  const refused = [a, b].filter((tx) => !tx.attachments[0].persisted);
  assert.equal(persisted.length, 1);
  assert.equal(refused.length, 1);
  assert.equal(refused[0].attachments[0].reason, 'global_quota');
  await a.commitFailed(); await b.commitFailed();
  await cleanupSessionAttachments('quota-race-a', []);
  await cleanupSessionAttachments('quota-race-b', []);
  await rm(__attachmentStoreInternals.sessionAttachmentDir('quota-race-a'), { recursive: true, force: true });
  await rm(__attachmentStoreInternals.sessionAttachmentDir('quota-race-b'), { recursive: true, force: true });
}

// 16. Embedded text/blob resources are snapshotted and reconstructed with native ACP semantics.
{
  const sessionId = 'embedded-resource';
  const tx = await persistTurnAttachments(sessionId, [textResource('hello resource'), blobResource('binary')]);
  const transcript = [{ user: 'resources', assistant: 'ok', attachments: tx.attachments }];
  await saveSession(sessionId, baseSession(transcript)); await tx.commitSucceeded();
  const historical = await buildHistoricalAttachmentBlocks(sessionId, transcript);
  const resources = historical.blocks.filter((x) => x.type === 'resource');
  assert.equal(resources[0].resource.text, 'hello resource');
  assert.equal(Buffer.from(resources[1].resource.blob, 'base64').toString(), 'binary');
  assert.equal(resources[0].resource.uri, 'file:///context.txt');
  await deleteSession(sessionId);
}

// 17. resource_link persists only link metadata; no URI content is downloaded or blob-created.
{
  const sessionId = 'resource-link';
  const tx = await persistTurnAttachments(sessionId, [linkResource()]);
  assert.equal(tx.attachments[0].type, 'resource_link');
  assert.equal(tx.attachments[0].blob, undefined);
  const transcript = [{ user: 'link', assistant: 'ok', attachments: tx.attachments }];
  await saveSession(sessionId, baseSession(transcript)); await tx.commitSucceeded();
  assert.equal((await blobFiles(sessionId)).length, 0);
  const historical = await buildHistoricalAttachmentBlocks(sessionId, transcript);
  const link = historical.blocks.find((x) => x.type === 'resource_link');
  assert.equal(link.uri, 'https://example.invalid/context');
  assert.equal(link.name, 'linked context');
  await deleteSession(sessionId);
}

// 18. Legacy v1 text-only sessions load and are migrated to v2 with empty attachment arrays.
{
  const sessionId = 'legacy-v1';
  const dir = path.join(root, 'sessions'); await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.json`);
  await writeFile(file, JSON.stringify({ version: 1, sessionId, cwd: '/tmp/project', repoRoot: '/tmp/project', history: [], transcript: [{ user: 'old', assistant: 'reply' }] }));
  const loaded = await loadSession(sessionId);
  assert.deepEqual(loaded.transcript[0].attachments, []);
  const migrated = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(migrated.version, 2);
  assert.deepEqual(migrated.transcript[0].attachments, []);
  await deleteSession(sessionId);
}

// 19. A live pending attachment cannot be swept before its session JSON commit.
{
  const sessionId = 'active-pending';
  const tx = await persistTurnAttachments(sessionId, [image('pending')]);
  await reconcileAttachmentStore({ now: Date.now() + 1_000, limits: { orphanGraceMs: 60_000 } });
  assert.equal((await blobFiles(sessionId)).length, 1);
  const transcript = [{ user: 'pending', assistant: 'ok', attachments: tx.attachments }];
  await saveSession(sessionId, baseSession(transcript));
  await tx.commitSucceeded();
  await reconcileAttachmentStore({ now: Date.now() + 120_000, limits: { orphanGraceMs: 1 } });
  assert.equal((await blobFiles(sessionId)).length, 1, 'persisted reachability wins after pending marker expires');
  await deleteSession(sessionId);
}

// Manually deleting a session file leaves an orphan directory that reconciliation removes after grace.
{
  const sessionId = 'manual-session-delete';
  await persistSuccessfulTurn(sessionId, image('manual-delete'));
  await rm(path.join(root, 'sessions', `${sessionId}.json`), { force: true });
  await reconcileAttachmentStore({ now: Date.now() + 120_000, limits: { orphanGraceMs: 1 } });
  await assert.rejects(() => stat(__attachmentStoreInternals.sessionAttachmentDir(sessionId)), (error) => error?.code === 'ENOENT');
}

// Fresh partial temp files survive grace; stale partial writes are cleaned without following anything.
{
  const sessionId = 'partial-temp';
  const dir = __attachmentStoreInternals.sessionAttachmentDir(sessionId);
  await mkdir(dir, { recursive: true });
  const temp = path.join(dir, '.deadbeef.tmp');
  await writeFile(temp, 'partial');
  await reconcileAttachmentStore({ now: Date.now(), limits: { orphanGraceMs: 60_000 } });
  assert.equal(await readFile(temp, 'utf8'), 'partial');
  await reconcileAttachmentStore({ now: Date.now() + 120_000, limits: { orphanGraceMs: 1 } });
  await assert.rejects(() => stat(temp), (error) => error?.code === 'ENOENT');
  await rm(dir, { recursive: true, force: true });
}

// Reconciliation fails safe when the sessions root itself is a symlink.
{
  const sessionId = 'gc-session-root-symlink';
  const victim = await mkdtemp(path.join(tmpdir(), 'role-orchestrator-gc-session-victim-'));
  const sessionsRoot = __attachmentStoreInternals.sessionsRoot();
  await rm(sessionsRoot, { recursive: true, force: true });
  await symlink(victim, sessionsRoot);
  const dir = __attachmentStoreInternals.sessionAttachmentDir(sessionId);
  await mkdir(dir, { recursive: true });
  const fakeBlob = path.join(dir, 'a'.repeat(64));
  await writeFile(fakeBlob, 'must-survive');
  const result = await reconcileAttachmentStore({ now: Date.now() + 120_000, limits: { orphanGraceMs: 1 } });
  assert.ok(result.protectedSessions.includes(sessionId));
  assert.equal(await readFile(fakeBlob, 'utf8'), 'must-survive');
  await rm(sessionsRoot, { force: true });
  await mkdir(sessionsRoot, { recursive: true });
  await rm(dir, { recursive: true, force: true });
  await rm(victim, { recursive: true, force: true });
}

// A replaced .pending directory is never traversed; GC protects the session fail-safe.
{
  const sessionId = 'pending-root-symlink';
  const victim = await mkdtemp(path.join(tmpdir(), 'role-orchestrator-pending-victim-'));
  await writeFile(path.join(victim, 'keep.txt'), 'safe');
  const dir = __attachmentStoreInternals.sessionAttachmentDir(sessionId);
  await mkdir(dir, { recursive: true });
  const fakeBlob = path.join(dir, 'b'.repeat(64));
  await writeFile(fakeBlob, 'must-survive');
  await symlink(victim, path.join(dir, '.pending'));
  await reconcileAttachmentStore({ now: Date.now() + 120_000, limits: { orphanGraceMs: 1 } });
  assert.equal(await readFile(fakeBlob, 'utf8'), 'must-survive');
  assert.equal(await readFile(path.join(victim, 'keep.txt'), 'utf8'), 'safe');
  await rm(path.join(dir, '.pending'), { force: true });
  await rm(dir, { recursive: true, force: true });
  await rm(victim, { recursive: true, force: true });
}

// Stale atomic session-write temp files are reconciled, while fresh ones keep their grace period.
{
  const sessionsRoot = __attachmentStoreInternals.sessionsRoot();
  await mkdir(sessionsRoot, { recursive: true });
  const fresh = path.join(sessionsRoot, 'temp-session.json.123.aaaaaaaa-bbbb.tmp');
  await writeFile(fresh, 'partial');
  await reconcileAttachmentStore({ now: Date.now(), limits: { orphanGraceMs: 60_000 } });
  assert.equal(await readFile(fresh, 'utf8'), 'partial');
  await reconcileAttachmentStore({ now: Date.now() + 120_000, limits: { orphanGraceMs: 1 } });
  await assert.rejects(() => stat(fresh), (error) => error?.code === 'ENOENT');
}

// Symlinked per-session attachment directories are rejected and never followed.
{
  const sessionId = 'symlink-attack';
  const victim = await mkdtemp(path.join(tmpdir(), 'role-orchestrator-victim-'));
  await writeFile(path.join(victim, 'keep.txt'), 'safe');
  await mkdir(__attachmentStoreInternals.attachmentsRoot(), { recursive: true });
  await symlink(victim, __attachmentStoreInternals.sessionAttachmentDir(sessionId));
  const tx = await persistTurnAttachments(sessionId, [image('unsafe')]);
  assert.equal(tx.attachments[0].persisted, false);
  assert.match(tx.attachments[0].reason, /^persistence_failed:/);
  assert.equal(await readFile(path.join(victim, 'keep.txt'), 'utf8'), 'safe');
  await rm(__attachmentStoreInternals.sessionAttachmentDir(sessionId), { force: true });
  await rm(victim, { recursive: true, force: true });
}

// 20. Cleanup leaves no leaked per-session blob state after all sessions are gone.
{
  await reconcileAttachmentStore({ now: Date.now() + 24 * 60 * 60 * 1000, limits: { orphanGraceMs: 1 } });
  const entries = await readdir(__attachmentStoreInternals.attachmentsRoot()).catch(() => []);
  assert.deepEqual(entries, []);
}

console.log('attachment-store: passed');
