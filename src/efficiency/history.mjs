// Cross-session read-only aggregates derived from canonical session JSON.
// No independent task database, no raw model content or prompts are exported.
import { readdir, lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { getSessionStateDir, normalizeEfficiencyRuns } from '../session-store.mjs';
import { efficiencyView, addExactNonnegative } from './analytics.mjs';
const MAX_SESSIONS = 200;
const MAX_CANDIDATES = 2000;
export async function historicalEfficiency(repoRoot, { enabled = false } = {}) {
  if (!enabled) return { enabled: false, reason: 'history_opt_in_required', sessions: 0, roles: [] };
  const dir = path.join(getSessionStateDir(), 'sessions');
  try { const st = await lstat(dir); if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('Unsafe history directory'); }
  catch (error) { if (error?.code === 'ENOENT') return { enabled: true, sessions: 0, roles: [] }; throw error; }
  const names = (await readdir(dir)).filter(x => /^[a-zA-Z0-9._-]{1,160}\.json$/.test(x));
  // Files are UUID-named: readdir order does not identify the most recent
  // sessions. Inspect bounded metadata and select by update time instead.
  const candidates = [];
  for (const name of names.slice(0, MAX_CANDIDATES)) {
    try {
      const stat = await lstat(path.join(dir, name));
      if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 20_000_000) {
        candidates.push({ name, mtimeMs: stat.mtimeMs });
      }
    } catch { /* racing deletion: later reads cannot assume existence */ }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
  // Restrict the *matching repository* to the latest MAX_SESSIONS. Applying
  // the cap before checking repoRoot can make a quieter project's history
  // disappear behind newer sessions from unrelated repositories.
  let truncated = names.length > MAX_CANDIDATES;
  const totals = new Map();
  let sessions = 0, skipped = 0;
  for (const { name: filename } of candidates) {
    let handle;
    try {
      handle = await open(path.join(dir, filename), constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 20_000_000) { skipped++; continue; }
      const data = JSON.parse(await handle.readFile('utf8'));
      if (data.repoRoot !== repoRoot || !Array.isArray(data.efficiencyRuns)) continue;
      if (sessions >= MAX_SESSIONS) { truncated = true; break; }
      sessions++;
      for (const row of efficiencyView({ efficiencyRuns: normalizeEfficiencyRuns(data.efficiencyRuns) }).roles) {
        const key = `${row.role}/${row.model}`;
        const t = totals.get(key) ?? { role: row.role, model: row.model, calls: 0, failed: 0, knownInputTokens: 0, knownOutputTokens: 0, inputCoverage: 0, outputCoverage: 0, elapsedMs: 0, durationCoverage: 0, numericOverflow: false, preparedCharacters: 0, contextProfileCoverage: 0, peakContextTokens: null, contextCoverage: 0, toolCalls: 0 };
        for (const field of ['calls','failed','knownInputTokens','knownOutputTokens','inputCoverage','outputCoverage','elapsedMs','durationCoverage','preparedCharacters','contextProfileCoverage','contextCoverage','toolCalls']) {
          const sum = addExactNonnegative(t[field], row[field]);
          if (sum === null) t.numericOverflow = true;
          t[field] = sum;
        }
        if (row.peakContextTokens !== null && row.peakContextTokens !== undefined) t.peakContextTokens = Math.max(t.peakContextTokens ?? 0, row.peakContextTokens);
        if (row.numericOverflow) t.numericOverflow = true;
        totals.set(key, t);
      }
    } catch { skipped++; } finally { await handle?.close().catch(() => {}); }
  }
  return { enabled: true, sessions, skipped, truncated, roles: [...totals.values()],
    note: 'Latest bounded sessions only; selection may be incomplete when the candidate cap is reached. Values with missing usage are lower bounds, never inferred model costs.' };
}
