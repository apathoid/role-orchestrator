/** @typedef {Awaited<ReturnType<typeof import('../main/runtime.js').openRuntime>>['api']} RuntimeApi */
/** @typedef {import('./local-control.js').ControlStreams} ControlStreams */
/** @param {() => RuntimeApi | undefined} api @returns {ControlStreams} */
export function controlStreams(api) {
  return {
    subscribe(operationId, listener) {
      const current = api();
      if (!current) return () => {};
      const activity = current.subscribeActivity({ operationId }, event => listener({ channel: 'activity', event }));
      const execution = current.subscribeExecution({ operationId }, (event,findings,fact) => listener({ channel: 'execution', event,findings,fact }));
      return Object.assign(() => { activity(); execution(); }, { finish: async () => {
        const counts = await Promise.all([activity.finish(),execution.finish()]);
        return counts[0]+counts[1];
      } });
    },
    pending: operationId => api()?.pendingInteractions(operationId) ?? [],
    respond: reply => api()?.respondInteraction(reply) ?? { kind: 'rejected', code: 'INTERACTION_UNAVAILABLE' },
  };
}
