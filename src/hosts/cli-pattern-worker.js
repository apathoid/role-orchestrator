import { parentPort, workerData } from 'node:worker_threads';

// Technical worker only. No model calls, tools, project filesystem or execution state.
// A pathological provider pattern must never execute on the Coordinator's event loop.
try {
  const { pattern, value } = /** @type {{pattern:string,value:string}} */ (workerData);
  parentPort?.postMessage({kind:new RegExp(pattern,'u').test(value)?'match':'mismatch'});
} catch {
  parentPort?.postMessage({kind:'invalid_pattern'});
}
