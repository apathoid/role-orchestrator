import { createInterface } from 'node:readline';

/** @import {PermissionHandler} from '../application/configuration/permissions.js' */

/**
 * @param {NodeJS.ReadableStream} input @param {NodeJS.WritableStream} output
 * @param {boolean} interactive @param {() => void} interrupt
 * @returns {PermissionHandler}
 */
export function cliPermissions(input, output, interactive, interrupt) {
  let queue = Promise.resolve();
  let eof = false;

  /** @type {PermissionHandler} */
  async function ask(request, signal) {
    if (signal.aborted) return { kind: 'cancelled' };
    if (!interactive || eof) {
      output.write('Permission unavailable for ' + JSON.stringify(request.resource) + '\n');
      return { kind: 'unavailable' };
    }
    const rl = createInterface({ input, output, terminal: true });
    try {
      output.write('Permission requested\n' + JSON.stringify({
        subject: request.resource, action: request.action, options: request.options,
      }, null, 2) + '\n');
      return await new Promise(resolve => {
        let settled = false;
        /** @param {Awaited<ReturnType<PermissionHandler>>} result */
        function finish(result) {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', abort);
          resolve(result);
        }
        const abort = () => finish({ kind: 'cancelled' });
        signal.addEventListener('abort', abort, { once: true });
        rl.once('close', () => { if (!settled) eof = true; finish({ kind: 'unavailable' }); });
        rl.once('SIGINT', () => { interrupt(); finish({ kind: 'cancelled' }); });
        const prompt = () => rl.question('Option id: ', answer => {
          const choice = request.options.find(option => option.id === answer.trim());
          if (choice) finish({ kind: 'selected', option: choice.id });
          else if (!settled) { output.write('Unknown option.\n'); prompt(); }
        });
        if (signal.aborted) abort();
        else prompt();
      });
    } finally {
      rl.close();
    }
  }

  return (request, signal) => {
    const result = queue.then(() => ask(request, signal));
    queue = result.then(() => {}, () => {});
    return result;
  };
}
