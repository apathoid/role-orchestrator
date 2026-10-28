// Deterministic test-provider output. This models the current typed Router
// contract; it is not an alternative production parser or authorization path.
import { emptyTaskSpec, validateTaskSpec } from '../src/routing/task-spec.mjs';

export function fakeRouterResult({ prompt, high, reviewOnly, investigateOnly }) {
  const mode = reviewOnly ? 'review' : investigateOnly ? 'investigate' : 'change';
  const writeIntent = mode === 'change' ? 'explicit' : 'not_requested';
  const task = emptyTaskSpec(mode, writeIntent);
  // The commit target belongs to the current test request; the smoke test
  // checks that this exact revision is passed to the real Git scope resolver.
  const requestedCommit = mode === 'review'
    ? prompt.match(/USER TASK:\nReview commit ([0-9a-f]{40})(?:\.|\s|$)/i)?.[1]
    : null;
  if (requestedCommit) task.target = { kind: 'git', selector: { type: 'commit', ref: requestedCommit } };
  validateTaskSpec(task);
  return {
    mode, writeIntent,
    complexity: high ? 'high' : 'low',
    risk: high ? 'security_or_data' : 'normal',
    reason: high ? 'smoke-test high-risk route' : 'smoke-test low route',
    title: 'Update greeting behavior',
    task,
  };
}
