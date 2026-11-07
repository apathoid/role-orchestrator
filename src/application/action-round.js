import { pendingDependencies } from '../core/action-graph.js';

/** @import {Action, ReasonCode} from '../core/contracts.js' */
/** @import {Operation} from '../core/operation.js' */

/**
 * Run the model's selected action set. Wait for predecessor
 * termination only when the corresponding edge explicitly allows it.
 * @param {readonly Action[]} selected
 * @param {Operation} state
 * @param {(action: Action) => Promise<boolean>} dispatch
 * @param {(action: Action, code: ReasonCode, resource?: string) => Promise<void>} defer
 * @param {Map<string, Promise<boolean>>} pending
 * @param {'all_requested' | 'next_completion'} policy
 * @param {boolean} alreadyObservedNewResult
 */
export async function runActionRound(selected, state, dispatch, defer, pending, policy, alreadyObservedNewResult) {
  const terminal = new Set(state.attempts.filter(attempt => attempt.status === 'terminal').map(attempt => attempt.actionId));
  const accepted = new Set(state.events.flatMap(event => event.kind === 'controller.responded'
    ? event.decision.acceptedActionIds ?? [] : []));
  const actions = new Map(selected.map(action => [action.actionId, action]));

  /** @param {Action} action @returns {Promise<boolean>} */
  function run(action) {
    if (terminal.has(action.actionId)) return Promise.resolve(true);
    const current = pending.get(action.actionId);
    if (current) return current;
    // The admission graph is acyclic. Defer recursion to a microtask for long chains.
    const task = Promise.resolve().then(async () => {
      for (const edge of pendingDependencies(action, terminal, accepted)) {
        const predecessor = actions.get(edge.actionId);
        if (edge.kind === 'after_model_acceptance' || !predecessor || !await run(predecessor)) {
          await defer(action, 'INVALID_PROPOSAL', edge.actionId);
          return false;
        }
      }
      return dispatch(action);
    }).finally(() => pending.delete(action.actionId));
    pending.set(action.actionId, task);
    return task;
  }

  const tasks = selected.filter(action => !terminal.has(action.actionId)).map(run);
  if (policy === 'next_completion') {
    const completed = Promise.any(tasks.map(async task => {
      if (!await task) throw new Error('Action was deferred');
    }));
    // Even when the result is already available, the rest of the selected
    // actions continue, with their rejection handlers installed here.
    void completed.catch(() => {});
    if (alreadyObservedNewResult) return;
    try { await completed; } catch {
      // All actions were either deferred or rejected. Forward a storage
      // failure, if any, instead of silently turning it into a model outcome.
      const settled = await Promise.allSettled(tasks);
      const failure = settled.find(result => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    }
    return;
  }
  const results = await Promise.allSettled(tasks);
  const failure = results.find(result => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
}
