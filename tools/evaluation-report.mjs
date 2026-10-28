// node tools/evaluation-report.mjs <session-id> [run-id]
// Reads only the sanitized observability trace. Does not open a provider,
// modify a workspace or create a session.
import { createExecutionObserver } from '../src/observability/execution-observer.mjs';
import { deriveExecutionMetrics } from '../src/observability/execution-metrics.mjs';

const [sessionId, runId] = process.argv.slice(2);
if (!sessionId || !/^[a-zA-Z0-9._-]{1,160}$/.test(sessionId) || (runId && !/^[a-zA-Z0-9._-]{1,160}$/.test(runId))) {
  console.error('Usage: npm run evaluation:report -- <session-id> [run-id]');
  process.exitCode = 2;
} else {
  const observer = createExecutionObserver();
  const events = await observer.getTrace(sessionId, { runId, full: true });
  if (!events.length) {
    console.error('No retained execution trace found for the requested run.');
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify({ sessionId, runId: events[0].runId, metrics: deriveExecutionMetrics(events) }, null, 2));
  }
}
