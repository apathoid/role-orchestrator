import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { hostError } from './commands.js';

/** @import {ControlCommand} from './local-control.js' */
/** @import {PendingInput, InputResult} from './cli-input.js' */
/** @typedef {{controller:AbortController, state:'input'|'sending'|'accepted'|'uncertain'|'rejected'|'unavailable', answerId?:string}} Delivery */

/**
 * Local input delivery only. No replay of work or automatic new answer.
 * An uncertain answer is never inferred to have succeeded from disappearance.
 * @param {{operationId:string,ownerRequestId:string,answerKey:string,signal:AbortSignal,
 *   call:(command:ControlCommand,signal:AbortSignal)=>Promise<unknown>,
 *   ask:(entry:PendingInput,signal:AbortSignal)=>Promise<InputResult>,
 *   print:(message:string)=>Promise<unknown>, intervalMs?:number}} options
 */
export async function pollAttachedInputs({operationId,ownerRequestId,answerKey,signal,call,ask,print,intervalMs=100}) {
  /** @type {Map<string,Delivery>} */
  const shown = new Map();
  const lifetime = new AbortController();
  const stop = AbortSignal.any([signal,lifetime.signal]);
  /** @param {string} message */
  const report = message => { if (!stop.aborted) void print(message); };
  /** @param {ControlCommand} command @param {AbortSignal} current */
  const request = (command,current) => call(command,AbortSignal.any([current,AbortSignal.timeout(5000)]));
  try {
    while (!stop.aborted) {
      const list = await request({action:'pending',operationId,requestId:randomUUID()},stop);
      if (!Array.isArray(list)) throw Error('Pending inspection unavailable');
      if (stop.aborted) break;
      const current = new Set(list.map(item=>item.request?.requestId));
      for (const [id,delivery] of shown) if (!current.has(id)) {
        if (delivery.state === 'uncertain') report('Interaction '+id+': no longer pending; answer acceptance is unconfirmed.');
        // Do not abort a reply just because its request disappeared: it may
        // have been accepted. Its own bounded transport wait determines this.
        if (delivery.state === 'input') delivery.controller.abort();
        shown.delete(id);
      }
      for (const entry of /** @type {PendingInput[]} */ (list)) {
        const native = entry.request;
        if (!native || native.operationId !== operationId) continue;
        const prior = shown.get(native.requestId);
        if (prior && prior.state !== 'rejected' && prior.state !== 'uncertain') continue;
        if (prior) {
          report('Interaction '+native.requestId+' remains pending; enter a new explicit reply (previous '+prior.state+').');
          prior.controller.abort();
        }
        /** @type {Delivery} */
        const delivery = {controller:new AbortController(),state:'input'};
        shown.set(native.requestId,delivery);
        const currentSignal = AbortSignal.any([stop,delivery.controller.signal]);
        void (async()=>{
          try {
            const payload = await ask(entry,currentSignal);
            if (currentSignal.aborted) return;
            if(prior && payload.kind!=='answered') {
              delivery.state='unavailable';
              report('Interaction '+native.requestId+': no new explicit reply; previous delivery remains unconfirmed.');
              return;
            }
            delivery.state = 'sending';
            const answerId = delivery.answerId = randomUUID();
            const response = await request({action:'answer',operationId,requestId:answerId,
              ownerRequestId,answerKey,reply:{requestId:native.requestId,operationId,
                attemptId:native.attemptId,providerRequestId:native.providerRequestId,payload}},currentSignal);
            if (currentSignal.aborted) return;
            if (response && typeof response === 'object' && 'kind' in response && response.kind === 'accepted') {
              delivery.state = 'accepted';
              return;
            }
            if (response && typeof response === 'object' && 'kind' in response && response.kind === 'rejected') {
              delivery.state = 'rejected';
              report('Interaction '+native.requestId+': reply '+answerId+' rejected ('+('code' in response ? String(response.code) : 'UNKNOWN')+').');
            } else {
              delivery.state = 'uncertain';
              report('Interaction '+native.requestId+': reply '+answerId+' delivery unconfirmed; checking pending state.');
            }
          } catch (error) {
            if (currentSignal.aborted) return;
            const issue = hostError(error);
            delivery.state = issue.code === 'CONTROL_INTERACTION_OWNER_REQUIRED' ? 'rejected' : 'uncertain';
            report('Interaction '+native.requestId+': '+issue.code+'; reply not confirmed.');
            if (issue.code === 'CONTROL_INTERACTION_OWNER_REQUIRED') lifetime.abort();
          }
        })();
      }
      await delay(intervalMs,undefined,{signal:stop});
    }
  } catch (error) {
    if (!stop.aborted) report('Interaction polling stopped for '+operationId+': '+hostError(error).code+
      '; pending reply state unknown. No answer will be replayed.');
  } finally {
    lifetime.abort();
    for (const delivery of shown.values()) delivery.controller.abort();
  }
}
