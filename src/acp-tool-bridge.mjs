import { randomUUID } from 'node:crypto';

// ACP v1: tool_call_update requires an existing tool_call in the *outer*
// session. Each inner ACP session has its own tool-call namespace; never expose
// raw inner IDs in Zed or send an update for an unpublished outer card.
export function createOuterToolCallBridge({ publish, warn = console.error } = {}) {
  if (typeof publish !== 'function') throw new TypeError('publish must be a function');
  const published = new Set();
  const outerTurnId = randomUUID();
  let tail = Promise.resolve();

  const scopeFor = (event) => event?.innerSessionId && event?.provider
    ? `${event.provider}:${event.innerSessionId}`
    : event?.invocationId;

  const outerId = (event, id) => {
    const scope = scopeFor(event);
    return typeof scope === 'string' && scope && typeof id === 'string' && id
      ? `${outerTurnId}:${scope}:${id}` : null;
  };

  // Serialize async notifications so a create cannot race its update or
  // accompanying permission request. A failed publication does not register
  // the card as existing in the outer client.
  const enqueue = (operation) => {
    const next = tail.catch(() => {}).then(operation);
    tail = next;
    return next;
  };

  async function forward(event) {
    return enqueue(async () => {
      const update = event?.update;
      if (update?.sessionUpdate !== 'tool_call' && update?.sessionUpdate !== 'tool_call_update') return;
      const id = outerId(event, update.toolCallId);
      if (!id) {
        warn('[acp] dropping inner tool event without a session/invocation scope or toolCallId');
        return;
      }
      if (!published.has(id)) {
        if (update.sessionUpdate === 'tool_call') {
          await publish({ ...update, toolCallId: id });
          published.add(id);
          return;
        }
        // Some ACP agents send only a v2-style upsert. Convert to ACP v1
        // creation if the first update has the mandatory title. Do not invent
        // a tool call when it contains only status or an opaque ID.
        if (typeof update.title === 'string' && update.title.trim()) {
          await publish({ ...update, sessionUpdate: 'tool_call', toolCallId: id });
          published.add(id);
          return;
        }
        warn(`[acp] dropping orphan inner tool_call_update for ${event.role ?? 'unknown role'}`);
        return;
      }
      await publish({ ...update, sessionUpdate: 'tool_call_update', toolCallId: id });
    });
  }

  async function permission(innerParams, metadata) {
    return enqueue(async () => {
      const id = outerId(metadata, innerParams?.toolCall?.toolCallId);
      if (!id) {
        warn('[acp] denied permission request without an inner session/toolCallId');
        return null;
      }
      // The outer client must know the subject of permission, including when
      // the provider normally hides that kind of command card in its telemetry.
      if (!published.has(id)) {
        const subject = innerParams.toolCall;
        const title = typeof subject.title === 'string' && subject.title.trim()
          ? subject.title : 'Tool permission request';
        await publish({ ...subject, sessionUpdate: 'tool_call', toolCallId: id, title });
        published.add(id);
      }
      return { ...innerParams, toolCall: { ...innerParams.toolCall, toolCallId: id } };
    });
  }

  forward.permission = permission;
  return forward;
}
