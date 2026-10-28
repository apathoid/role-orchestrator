#!/usr/bin/env node
// Export P3 allowlisted telemetry for one explicitly selected outer ACP session.
// Never emit conversation history, prompts, tool payloads or repository paths.
import { loadSession, normalizeEfficiencyRuns } from '../src/session-store.mjs';

const [, , sessionId, runId] = process.argv;
if (!sessionId || !/^[A-Za-z0-9._-]{1,160}$/.test(sessionId) || (runId && !/^[A-Za-z0-9._/-]{1,128}$/.test(runId)) || process.argv.length > 4) {
  console.error('Usage: node tools/efficiency-export.mjs <outer-session-id> [run-id] > efficiency.json');
  process.exitCode = 2;
} else {
  try {
    const session = await loadSession(sessionId);
    if (!session) throw new Error('Session not found');
    const runs = [...new Map(normalizeEfficiencyRuns(session.efficiencyRuns).map(run => [run.runId, run])).values()];
    const selected = runId ? runs.filter(run => run.runId === runId) : runs;
    process.stdout.write(`${JSON.stringify({ version: 1, scope: 'session', retainedRuns: runs.length, runs: selected,
      note: 'Allowlists only. Prompt characters are not model tokens; ACP occupancy is not billed usage; unknown values are null.' }, null, 2)}\n`);
  } catch (error) {
    console.error(`Efficiency export failed: ${error?.message ?? 'unavailable'}`);
    process.exitCode = 1;
  }
}
