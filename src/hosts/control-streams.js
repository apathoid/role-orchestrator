/** @typedef {Awaited<ReturnType<typeof import('../main/runtime.js').openRuntime>>['api']} RuntimeApi */
/** @typedef {import('./local-control.js').ControlStreams} ControlStreams */
/** @param {() => RuntimeApi | undefined} api @returns {ControlStreams} */
export function controlStreams(api) {
  return {
    subscribe(operationId, listener) {
      const current = api();
      if (!current) return () => {};
      const activity = current.subscribeActivity({ operationId }, event => listener({ channel: 'activity', event }));
      const execution = current.subscribeExecution({ operationId }, event => listener({ channel: 'execution', event }));
      return () => { activity(); execution(); };
    },
    pending: operationId => api()?.pendingInteractions(operationId) ?? [],
    respond: reply => api()?.respondInteraction(reply) ?? { kind: 'rejected', code: 'INTERACTION_UNAVAILABLE' },
  };
}
