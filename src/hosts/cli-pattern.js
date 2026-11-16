import { Worker } from 'node:worker_threads';

/** @typedef {'match'|'mismatch'|'invalid_pattern'|'timeout'|'resource_limit'|'unavailable'|'cancelled'} PatternOutcome */
const maxConcurrent=4, maxPatternBytes=8192, maxValueBytes=256*1024, validationTimeoutMs=750;
let active=0;

/** Validate a provider-defined ACP pattern in an isolated, terminating technical worker.
 * No model environment is isolated, and no UI validation affects orchestration policy.
 * On uncertainty the answer must not be sent as valid or mislabeled "mismatch".
 * @param {string} pattern @param {string} value @param {AbortSignal} [signal]
 * @returns {Promise<PatternOutcome>}
 */
export function checkPattern(pattern,value,signal){
  if(signal?.aborted)return Promise.resolve('cancelled');
  if(Buffer.byteLength(pattern,'utf8')>maxPatternBytes||Buffer.byteLength(value,'utf8')>maxValueBytes||
    active>=maxConcurrent)return Promise.resolve('resource_limit');
  active++;
  return new Promise(resolve=>{
    /** @type {Worker|undefined} */
    let worker;
    let settled=false;
    /** @type {NodeJS.Timeout|undefined} */
    let timeout;
    /** @param {PatternOutcome} outcome */
    const finish=outcome=>{
      if(settled)return;
      settled=true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort',abort);
      // Resolution never waits for an untrusted regex. Keep its slot charged
      // until Worker.terminate actually frees the resource.
      if(worker)void worker.terminate().catch(()=>{}).finally(()=>{active--;});
      else active--;
      resolve(outcome);
    };
    const abort=()=>finish('cancelled');
    signal?.addEventListener('abort',abort,{once:true});
    timeout=setTimeout(()=>finish('timeout'),validationTimeoutMs);
    try{
      worker=new Worker(new URL('./cli-pattern-worker.js',import.meta.url),{
        workerData:{pattern,value},
        resourceLimits:{maxOldGenerationSizeMb:32,maxYoungGenerationSizeMb:8,stackSizeMb:1},
      });
      worker.once('message',data=>{
        const result=data&&typeof data==='object'&&'kind' in data?data.kind:undefined;
        finish(['match','mismatch','invalid_pattern'].includes(result)?
          /** @type {PatternOutcome} */(result):'unavailable');
      });
      worker.once('error',()=>finish('unavailable'));
      worker.once('exit',()=>finish('unavailable'));
      if(signal?.aborted)abort();
    }catch{finish('unavailable');}
  });
}
