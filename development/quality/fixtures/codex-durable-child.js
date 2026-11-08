import { access, appendFile, readFile, rename, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
const separator = '\n\nInvocation (JSON):\n';
const boundary = prompt.indexOf(separator);
if (boundary < 0) throw new Error('Missing invocation JSON');
const { attemptId, operationId, objective, context, kind, profileId } = JSON.parse(prompt.slice(boundary + separator.length));
const facts = context.find(item => item.ref === 'host:invocation-context')?.value;

const emit = event => new Promise((resolve, reject) => {
  process.stdout.write(JSON.stringify(event) + '\n', error => error ? reject(error) : resolve());
});
const message = (id, text) => emit({ type: 'item.completed', item: { id, type: 'agent_message', text } });
const readTarget = () => readFile('target.txt', 'utf8');
const assessment = (answer, overall = 'complete') => ({
  finalAssessment: { author: profileId, overall, requirements: [], observationRefs: [], findingRefs: [], unresolvedQuestions: [], answer },
});
const decision = fields => JSON.stringify({
  schemaVersion: 1, decisionId: attemptId + '-decision', operationId, contextCursor: facts.contextCursor,
  additions: [], cancellations: [], ...fields,
});

await appendFile('invocations.jsonl', JSON.stringify({ kind, attemptId, cwd: process.cwd() }) + '\n', { flush: true });
await emit({ type: 'thread.started', thread_id: 'durable-' + attemptId });
await emit({ type: 'turn.started' });
if (kind === 'delegate') {
  if (objective !== 'record one external effect') throw new Error('Unexpected delegated task');
  await appendFile('effects.log', attemptId + '\n', { flush: true });
  await emit({ type: 'item.completed', item: { id: 'tool', type: 'command_execution',
    command: 'synthetic external action', status: 'completed', exit_code: 0 } });
  await message('worker', 'external effect was recorded');
} else if (objective === 'recover-worker') {
  if (facts.outcomes.length === 0) {
    await message('plan', decision({
      additions: [{ actionId: 'worker', kind: 'delegate', objective: 'record one external effect',
        profileId, expectedResult: 'report the effect', contextRefs: [], dependsOn: [] }],
      waitPolicy: { kind: 'all_requested', targets: [{ kind: 'action', id: 'worker' }] },
    }));
  } else {
    const unresolved = facts.unresolvedAttempts.find(attempt => attempt.actionId === 'worker');
    if (unresolved?.effect !== 'unknown' || unresolved.dispatchCertainty !== 'unknown' ||
        unresolved.statusLookup !== 'unsupported') throw new Error('Expected unresolved prior Worker');
    await message('recovered', decision(assessment('unknown Worker effect; current target: ' + await readTarget(), 'partial')));
  }
} else if (objective === 'mutable-workspace' || objective === 'cancel-live') {
  const before = await readTarget();
  await message('progress', 'target before release: ' + before);
  await writeFile('ready.tmp', JSON.stringify({ pid: process.pid, attemptId }));
  await rename('ready.tmp', 'ready.json');
  const deadline = performance.now() + 8_000;
  for (;;) {
    try {
      await access('release');
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (performance.now() >= deadline) throw new Error('Timed out waiting for fixture release');
      await sleep(10);
    }
  }
  await message('final', decision(assessment('current target: ' + await readTarget())));
} else {
  throw new Error('Unexpected Controller task');
}
await emit({ type: 'turn.completed', usage: { input_tokens: 11, output_tokens: 5 } });
