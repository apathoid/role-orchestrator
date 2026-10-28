// Test-only ACP facade. This tests adapter lifecycle ordering without requiring
// an installed SDK. Real wire compatibility must still be integration-tested.
export const PROTOCOL_VERSION = 1;
export const methods = {
  client: { session: { requestPermission: 'permission', update: 'update' },
    elicitation: { create: 'elicitation.create', complete: 'elicitation.complete' } },
  agent: { initialize: 'initialize', session: {
    new: 'session.new', setMode: 'session.setMode', setConfigOption: 'session.setConfigOption',
    prompt: 'session.prompt', cancel: 'session.cancel', close: 'session.close',
  } },
};
export class RequestError extends Error {}
export const harness = {
  events: [], initializeGate: null, initializeRejectOnce: false,
  holdSessionNew: false, holdClose: false,
  reset() { this.events = []; this.initializeGate = null; this.initializeRejectOnce = false; this.holdSessionNew = false; this.holdClose = false; },
};
export const ndJsonStream = () => ({});
export function client() {
  const app = {
    onRequest() { return this; }, onNotification() { return this; },
    connect() {
      let done;
      const closed = new Promise(resolve => { done = resolve; });
      return {
        closed,
        close() { done(); },
        agent: { async request(method, params) {
          harness.events.push(method);
          if (method === 'initialize') {
            if (harness.initializeRejectOnce) {
              harness.initializeRejectOnce = false;
              throw new Error('rejected_initialize');
            }
            if (harness.initializeGate) await harness.initializeGate;
            return { protocolVersion: 1, agentCapabilities: { promptCapabilities: {} } };
          }
          if (method === 'session.new') {
            if (harness.holdSessionNew) return new Promise(() => {});
            return { sessionId: `s-${harness.events.length}` };
          }
          if (method === 'session.close' && harness.holdClose) return new Promise(() => {});
          if (method === 'session.prompt') return { stopReason: 'end_turn' };
          return {};
        } },
      };
    },
  };
  return app;
}
