/** @import {Event, Operation} from '../core/operation.js' */
/** @typedef {{
 * journalEventId:string, operationId:string, kind:Event['kind'],
 * attemptId?:string, actionId?:string, attemptOrdinal?:number,
 * invocationKind?:'controller'|'delegate', roleId?:string, profileId?:string,
 * providerId?:string, modelSelector?:string, reasoning?:import('../core/ports.js').ReasoningSelection,
 * objective?:string, terminal?:import('../core/contracts.js').Outcome['terminal'],
 * effect?:import('../core/contracts.js').Outcome['effect'],
 * dispatchCertainty?:import('../core/operation.js').DispatchCertainty,
 * cancellation?:import('../core/contracts.js').CancellationSource,
 * invalidPath?:string, expected?:string,
 * late?:true, assessmentOverall?:import('../core/contracts.js').Assessment['overall'], waitingKind?:'question'|'technical'
 * }} ExecutionFact */

/** Read-only technical projection of a committed transition; no state retained.
 * Route and objective are historical, not inferred from today's configuration.
 * @param {Operation} state @param {Event} event @returns {ExecutionFact}
 */
export function executionFact(state,event) {
  const attemptId=event.kind==='attempt.outcome'?event.outcome.attemptId:
    'attemptId' in event?event.attemptId:undefined;
  const index=attemptId===undefined?-1:state.attempts.findIndex(item=>item.attemptId===attemptId);
  const attempt=index<0?undefined:state.attempts[index];
  const actionId=attempt?.actionId??('actionId' in event?event.actionId:undefined);
  /** @type {import('../core/contracts.js').Action|undefined} */
  let action;
  if (attempt && attempt.actionId!==attempt.attemptId) {
    for (let i=state.events.length-1;i>=0&&!action;i--) {
      const item=state.events[i];
      if (item.kind!=='controller.responded') continue;
      for (const admission of item.admissions??[]) {
        if (admission.kind==='accepted'&&admission.action.actionId===actionId) {action=admission.action;break;}
      }
    }
  }
  const route=event.kind==='attempt.dispatched'?event.route:attempt?.route;
  return {
    journalEventId:event.eventId,operationId:event.operationId,kind:event.kind,
    ...(attempt&&{attemptId:attempt.attemptId,actionId:attempt.actionId,attemptOrdinal:index+1,
      invocationKind:attempt.actionId===attempt.attemptId?'controller':'delegate',
      dispatchCertainty:attempt.dispatchCertainty,cancellation:attempt.cancellation}),
    ...(actionId!==undefined&&{actionId}),
    ...(route&&{profileId:route.profileId,providerId:route.providerId,modelSelector:route.model,
      reasoning:route.reasoning}),
    ...(action&&{roleId:action.roleId,objective:action.objective}),
    ...(event.kind==='attempt.outcome'&&{terminal:event.outcome.terminal,effect:event.outcome.effect,
      dispatchCertainty:event.dispatchCertainty,late:event.late}),
    ...(event.kind==='operation.finished'&&{assessmentOverall:event.assessment.overall}),
    ...(event.kind==='operation.waiting'&&{waitingKind:event.waiting.kind}),
    ...(event.kind==='controller.invalid_proposal'&&{invalidPath:event.reason.path,expected:event.reason.expected}),
    ...((event.kind==='attempt.cancel_requested'||event.kind==='action.cancelled'||event.kind==='operation.cancelled')&&{cancellation:event.source}),
  };
}
