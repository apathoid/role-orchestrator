#!/usr/bin/env node
// Explicit offline migration: sanitizes ONLY stored task Quality State.
// Never writes a raw backup containing credentials. Stop the orchestrator first.
import { open, lstat, rename, rm, chmod } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { sanitizeQualityValue } from '../src/quality-privacy.mjs';

export async function scrubQualityStateFile(filename) {
  const target = path.resolve(filename);
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 20_000_000) throw new Error('Refusing unsafe or oversized session file');
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  let raw;
  try { raw = await handle.readFile('utf8'); }
  finally { await handle.close(); }
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.implementationTasks)) throw new Error('No implementationTasks array; no file was changed');
  let modified = 0;
  for (const task of parsed.implementationTasks) {
    if (!task?.quality) continue;
    const scrubbed = sanitizeQualityValue(task.quality);
    if (JSON.stringify(scrubbed) !== JSON.stringify(task.quality)) {
      task.quality = scrubbed; modified++;
    }
  }
  if (!modified) return { modified: 0 };
  const temp = `${target}.${process.pid}.${randomUUID()}.scrub.tmp`;
  try {
    const file = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try { await file.writeFile(JSON.stringify(parsed, null, 2)); await file.sync(); }
    finally { await file.close(); }
    await rename(temp, target);
    await chmod(target, 0o600);
    const dir = await open(path.dirname(target), constants.O_RDONLY);
    try { await dir.sync(); } catch (error) {
      if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(error.code)) throw error;
    } finally { await dir.close(); }
  } catch (error) { await rm(temp, { force: true }).catch(() => {}); throw error; }
  return { modified };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename ?? '')) {
  if (process.argv.length !== 3) {
    console.error('Usage: node tools/scrub-quality-state.mjs /path/to/sessions/session-id.json (stop orchestrator first)');
    process.exitCode = 2;
  } else {
    scrubQualityStateFile(process.argv[2]).then(({ modified }) =>
      console.log(`Quality scrub complete: ${modified} task(s) changed; inspect third-party logs/backups separately.`)).catch((error) => {
      console.error(`Quality scrub refused: ${error.message}`); process.exitCode = 1;
    });
  }
}
