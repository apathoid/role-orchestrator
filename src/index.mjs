import { loadConfig } from './config.mjs';
import { createModelRegistry } from './models.mjs';
import { loadInvocationContext, parseSlashInvocation } from './context.mjs';
import { createCliReporter } from './reporters.mjs';
import { runWorkflow } from './workflow.mjs';
import { resolveRepoRoot } from './repo.mjs';
import { randomUUID } from 'node:crypto';
import { createExecutionObserver } from './observability/execution-observer.mjs';
import { executionFailureDiagnostic } from './observability/execution-diagnostics.mjs';

function parseArgs(argv) {
  let mode = null;
  let skill = null;
  let reviewCommit = null;
  const task = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--mode') { mode = argv[++i]; continue; }
    if (arg === '--skill') { skill = argv[++i]; continue; }
    if (arg === '--review-commit') { reviewCommit = argv[++i]; mode = mode ?? 'review'; continue; }
    task.push(arg);
  }
  if (mode && !['change', 'review', 'investigate'].includes(mode)) throw new Error('--mode must be change, review, or investigate.');
  return { mode, skill, reviewCommit, task: task.join(' ').trim() };
}

const args = parseArgs(process.argv.slice(2));
if (!args.task) {
  console.error('Usage: npm run agent -- [--mode review|change|investigate] [--review-commit revision] [--skill name] "Describe the task"');
  process.exit(2);
}

const repoStart = process.env.AGENT_REPO ?? process.cwd();
const repoRoot = await resolveRepoRoot(repoStart);
const config = await loadConfig({ repoRoot });
const registry = createModelRegistry(config);
const availableContext = await loadInvocationContext(repoRoot, { scopePaths: [repoStart] });
const slash = parseSlashInvocation(args.task, availableContext.skills);
if (slash.error) throw new Error(slash.error);
const task = slash.command ? slash.task : args.task;
const skillName = args.skill ?? slash.skillName;
const modeOverride = args.mode ?? slash.modeOverride;
const reviewTarget = args.reviewCommit
  ? { type: 'commit', revision: args.reviewCommit }
  : slash.reviewTarget;

// CLI uses the same host-neutral observation contract but does not create an
// ACP session or change existing stateless CLI execution semantics.
const observer = createExecutionObserver({ onError: (error) => console.error(`[observability] ${error?.message ?? error}`) });
const observed = observer.begin(`cli-${randomUUID()}`);
observed.running();
const cliReporter = createCliReporter();
let result;
try {
  result = await runWorkflow({
    task,
    config,
    registry,
    repoStart,
    modeOverride,
    skillName,
    reviewTarget,
    reporter: async (event) => { observed.event(event); await cliReporter(event); },
  });
  await observed.finish({ status: 'completed', resultStatus: result.status, committed: false });
} catch (error) {
  await observed.finish({ status: 'failed', ...executionFailureDiagnostic(error) });
  throw error;
} finally {
  await registry.close?.();
}
console.error(`Execution trace: ${observed.runId}`);

console.log(JSON.stringify(result, null, 2));
console.error('\nModel runs (ChatGPT-auth runs consume plan allowance, not API token billing):');
for (const r of result.runs ?? []) {
  console.error(`- ${r.role}: ${r.profile} -> ${r.provider}/${r.model}; ${(r.elapsedMs / 1000).toFixed(1)}s`);
}
