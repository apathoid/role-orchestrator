import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { agent, methods, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk';
import { decode, id, invalid as invalidField, optional, record } from '../core/decode.js';
import { hostError } from './commands.js';
import { acpActivity, acpExecutionNotices, acpDeliveryGap } from './presentation.js';

/** @import {AgentContext, AgentConnection, ClientCapabilities, Stream, StopReason} from '@agentclientprotocol/sdk' */
/** @import {ActivityListener, ActivityScope} from '../core/ports.js' */
/** @import {PresentationMode} from './presentation.js' */
/** @import {Operation} from '../core/operation.js' */
/** @import {HostApi} from './commands.js' */
/** @typedef {HostApi & {findRequest: import('./commands.js').Coordinator['findRequest'], subscribeActivity: (scope: ActivityScope, listener: ActivityListener) => (() => void) & {finish?: () => Promise<number>}, subscribeExecution?: (scope: ActivityScope, listener: import('../application/events.js').EventListener) => (() => void) & {finish?:()=>Promise<number>}}} AcpApi */
/** @typedef {{sessionId: string, cwd: string, operations: string[], requests: {requestId: string, fingerprint: string, operationId?: string}[]}} Session */
/** @typedef {{operationId?: string, cancelled: boolean, settled: Promise<void>, stopDisplay?:()=>void}} Turn */

const a = methods.agent;
const c = methods.client;

/** @param {string} sessionId @param {string} requestId */
const operationRequestId = (sessionId, requestId) => 'acp:' + sessionId + ':' + requestId;
const turnOptions = record({
  requestId: optional(id), continueOperationId: optional(id), supersedeOperationId: optional(id),
  newOperation: optional((value, path) => typeof value === 'boolean' ? value : invalidField(path, 'a boolean')),
});

/** @param {string} message @param {unknown} [data] */
const invalid = (message, data) => new RequestError(-32602, message, data);

/** @param {Operation} operation @returns {StopReason} */
function stopReason(operation) {
  if (operation.status === 'cancelled') return 'cancelled';
  if (operation.waiting?.kind === 'technical') {
    return operation.waiting.reason.code === 'RESOURCE_LIMIT' ? 'max_turn_requests' : 'refusal';
  }
  return 'end_turn';
}

/** @param {Operation} operation */
function operationMessage(operation) {
  if (operation.status === 'finished') return operation.assessment?.answer;
  if (operation.waiting?.kind === 'question') return operation.waiting.question;
  if (operation.waiting?.kind === 'technical') {
    const reason = operation.waiting.reason;
    return reason.profileId
      ? 'Error: ' + reason.code + ' operation=' + operation.operationId +
        ' profile=' + reason.profileId + ' reasoningLevel=' + (reason.reasoningLevel ?? '(default)') +
        ' available=' + (reason.availableLevels ?? []).join(',') +
        (reason.reasoningCause ? ' cause=' + reason.reasoningCause : '')
      : 'Waiting: ' + reason.code;
  }
}

/** @param {AcpApi} api @param {string} directory @param {Stream} stream @param {PresentationMode} [mode] */
export function serveAcp(api, directory, stream, mode = 'compact') {
  /** @type {Map<string, Session>} */
  const sessions = new Map();
  /** @type {Map<string, Turn>} */
  const turns = new Map();
  const loading = new Set();
  let initialized = false;
  /** @type {ClientCapabilities} */
  let capabilities = {};
  // Capture the declaration at the wire boundary before the SDK normalizes it.
  // This is not negotiation or authority; only the accepted initialize is retained.
  /** @type {unknown} */
  let rawCapabilities;
  /** @type {Map<unknown, unknown>} */
  const declarations = new Map();
  /** @type {TransformStream<import('@agentclientprotocol/sdk').AnyMessage, import('@agentclientprotocol/sdk').AnyMessage>} */
  const capture = new TransformStream({
    transform(message, controller) {
      if (!initialized && message && typeof message === 'object' && 'method' in message &&
          message.method === a.initialize && 'id' in message && 'params' in message) {
        const params = message.params;
        if (params && typeof params === 'object' && 'clientCapabilities' in params) {
          if (declarations.size >= 8) declarations.delete(declarations.keys().next().value);
          declarations.set(message.id, structuredClone(params.clientCapabilities));
        }
      }
      controller.enqueue(message);
    },
  });

  /** @param {string} sessionId */
  function sessionPath(sessionId) {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(sessionId)) throw invalid('Unknown session');
    return join(directory, 'client-session-' + sessionId + '.json');
  }

  /** @param {Session} session */
  async function save(session) {
    const file = sessionPath(session.sessionId);
    const temporary = file + '.' + randomUUID();
    try {
      await writeFile(temporary, JSON.stringify(session), { mode: 0o600, flag: 'wx', flush: true });
      await rename(temporary, file);
      const handle = await open(directory, 'r');
      try { await handle.sync(); } finally { await handle.close(); }
    } finally { await rm(temporary, { force: true }); }
  }

  /** @param {string} cwd @param {readonly unknown[]} servers */
  function checkSession(cwd, servers) {
    if (!initialized) throw invalid('Initialize the ACP connection first');
    if (!isAbsolute(cwd)) throw invalid('Session cwd must be absolute');
    if (servers.length) throw invalid('Client-supplied MCP servers are unavailable');
  }

  /** @param {AgentContext} client @param {string} sessionId @param {string} text @param {boolean} [user] */
  async function message(client, sessionId, text, user = false) {
    if (connection.signal.aborted) return;
    try {
      await client.notify(c.session.update, {
        sessionId, update: { sessionUpdate: user ? 'user_message_chunk' : 'agent_message_chunk', content: { type: 'text', text } },
      });
    } catch (error) {
      if (!connection.signal.aborted) throw error;
    }
  }

  /** @param {string} sessionId @param {'client' | 'superseded'} [source] */
  async function cancel(sessionId, source = /** @type {const} */ ('client')) {
    const turn = turns.get(sessionId);
    if (!turn) return;
    turn.cancelled = true;
    turn.stopDisplay?.();
    if (turn.operationId) await api.cancel(turn.operationId, source).catch(error => {
      if (hostError(error).code !== 'INVALID_PROPOSAL') throw error;
    });
  }

  /** @param {Session} session @param {Session['requests'][number]} request @param {string} operationId */
  function attach(session, request, operationId) {
    request.operationId = operationId;
    if (!session.operations.includes(operationId)) session.operations.push(operationId);
  }

  const app = agent()
    .onRequest(a.initialize, ({ params, requestId }) => {
      if (initialized) throw invalid('ACP connection is already initialized');
      if (params.protocolVersion !== PROTOCOL_VERSION) throw invalid('Unsupported ACP protocol version', { supported: PROTOCOL_VERSION });
      initialized = true;
      capabilities = params.clientCapabilities ?? {};
      rawCapabilities = declarations.get(requestId);
      declarations.clear();
      return {
        protocolVersion: PROTOCOL_VERSION, agentInfo: { name: 'role-orchestrator', version: '0.1.0-dev.0' },
        agentCapabilities: { loadSession: true, promptCapabilities: { image: false, audio: false, embeddedContext: false } },
      };
    })
    .onRequest(a.session.new, async ({ params }) => {
      checkSession(params.cwd, params.mcpServers);
      const session = { sessionId: randomUUID(), cwd: params.cwd, operations: [], requests: [] };
      await save(session);
      sessions.set(session.sessionId, session);
      return { sessionId: session.sessionId };
    })
    .onRequest(a.session.load, async ({ params, client }) => {
      const { sessionId, cwd } = params;
      checkSession(cwd, params.mcpServers);
      if (turns.has(sessionId) || loading.has(sessionId)) throw invalid('Session is busy');
      loading.add(sessionId);
      try {
        const file = sessionPath(sessionId);
        /** @type {Session} */
        const session = await readFile(file, 'utf8').then(JSON.parse).catch(() => { throw invalid('Unknown session'); });
        if (session.sessionId !== sessionId || !Array.isArray(session.operations) ||
            !session.operations.every(id => typeof id === 'string')) throw invalid('Invalid stored session');
        session.requests ??= [];
        for (const request of session.requests) {
          if (request.operationId) continue;
          const operation = await api.findRequest(operationRequestId(sessionId, request.requestId));
          if (operation) attach(session, request, operation.operationId);
        }
        session.cwd = cwd;
        await save(session);
        for (const operationId of session.operations) {
          const operation = await api.inspect(operationId);
          await message(client, sessionId, operation.request.text, true);
          for (const event of operation.events) {
            if (event.kind === 'operation.continued') await message(client, sessionId, event.input.text, true);
            if (event.kind === 'operation.finished') await message(client, sessionId, event.assessment.answer);
            if (event.kind === 'operation.waiting' && event.waiting.kind === 'question') {
              await message(client, sessionId, event.waiting.question);
            }
          }
        }
        sessions.set(sessionId, session);
        return {};
      } finally { loading.delete(sessionId); }
    })
    .onRequest(a.session.prompt, async ({ params, client }) => {
      const { sessionId, prompt } = params;
      const session = sessions.get(sessionId);
      if (!session || loading.has(sessionId)) throw invalid('Create or load the session before prompting');
      if (prompt.some(block => block.type !== 'text')) throw invalid('This host supports text prompt blocks');
      const text = prompt.map(block => block.type === 'text' ? block.text : '').join('\n');
      if (!text.trim()) throw invalid('A nonempty prompt is required');
      const parsed = decode(turnOptions, params._meta?.roleOrchestrator ?? {});
      if (parsed.kind === 'rejected') throw invalid('Invalid Role Orchestrator turn options', parsed.reason.path);
      const { continueOperationId, supersedeOperationId, newOperation, requestId = randomUUID() } = parsed.value;
      if ((continueOperationId && newOperation) || (continueOperationId && supersedeOperationId)) {
        throw invalid('Choose one turn action');
      }
      const durableRequestId = operationRequestId(sessionId, requestId);
      const fingerprint = createHash('sha256').update(JSON.stringify([text, continueOperationId, supersedeOperationId, newOperation])).digest('hex');
      let request = session.requests.find(item => item.requestId === requestId);
      if (request && request.fingerprint !== fingerprint) throw invalid('Request id reused');
      const previous = turns.get(sessionId);
      if (previous) {
        if (request || !supersedeOperationId || previous.operationId !== supersedeOperationId) throw invalid('Session has an active prompt');
        await cancel(sessionId, 'superseded');
        await previous.settled;
        if (turns.has(sessionId) || loading.has(sessionId)) throw invalid('Session is busy');
      } else if (!request && supersedeOperationId) {
        throw invalid('Supersession requires a named active operation in this session');
      }
      const settled = Promise.withResolvers();
      /** @type {Turn} */
      const turn = { cancelled: false, settled: settled.promise };
      turns.set(sessionId, turn);
      /** @type {(() => void) & {finish?:()=>Promise<number>}} */
      let unsubscribe = () => {};
      /** @type {(() => void) & {finish?:()=>Promise<number>}} */
      let unsubscribeExecution = () => {};
      const notices = capabilities.session?.notices != null;
      let subscribed = false;
      let displaying = true;
      const stopDisplay = () => { displaying = false; unsubscribe(); unsubscribeExecution(); };
      turn.stopDisplay=stopDisplay;
      connection.signal.addEventListener('abort',stopDisplay,{once:true});
      try {
        if (!request) {
          request = { requestId, fingerprint };
          session.requests.push(request);
          await save(session);
        }
        let operation = await api.findRequest(durableRequestId);
        if (!operation) {
          const last = session.operations.at(-1);
          if (continueOperationId && !session.operations.includes(continueOperationId)) throw invalid('Operation belongs to another session');
          const target = continueOperationId ?? (newOperation || supersedeOperationId ? undefined : last);
          const prior = target && await api.inspect(target);
          const workspaceContext = { cwd: session.cwd };
          const delivery = request;
          /** @param {string} id */
          const accepted = id => {
            turn.operationId = id;
            attach(session, delivery, id);
            if (subscribed||!displaying||turn.cancelled||connection.signal.aborted) return;
            subscribed = true;
            unsubscribe = api.subscribeActivity({operationId:id}, async event => {
              if (!displaying || turn.cancelled || connection.signal.aborted || turn.operationId !== id) return;
              const update = event.kind==='gap' && notices ? acpDeliveryGap(id,event.droppedCount,event.reason,event.attemptId) : acpActivity(event, mode, event.kind!=='gap'&&event.invocationKind==='controller');
              if (update && displaying && !turn.cancelled && !connection.signal.aborted) {
                await client.notify(c.session.update, {sessionId, update});
              }
            });
            if (notices && api.subscribeExecution) unsubscribeExecution=api.subscribeExecution({operationId:id},async(event,findings)=>{
              for(const update of acpExecutionNotices(event,findings,mode)){
                if(!displaying||turn.cancelled||connection.signal.aborted||turn.operationId!==id) return;
                await client.notify(c.session.update,{sessionId,update});
              }
            });
          };
          const submission = prior && (continueOperationId || prior.status === 'waiting' || prior.status === 'finished')
            ? await api.resume(prior.operationId, { requestId: durableRequestId, text, workspaceContext,
              questionId: prior.waiting?.kind === 'question' ? prior.waiting.questionId : undefined }, accepted)
            : await api.submit({
              schemaVersion: 1, requestId: durableRequestId, text, attachments: [], userConstraints: [],
              configurationRef: api.configurationRef, workspaceContext,
            }, accepted);
          accepted(submission.operation.operationId);
          if (turn.cancelled) await cancel(sessionId);
          // Retain ownership of a submitted operation even if the session journal write fails.
          await save(session).finally(() => submission.completion.then(() => {}, () => {}));
          operation = await submission.completion;
        } else {
          attach(session, request, operation.operationId);
          await save(session);
        }
        if (!turn.cancelled && !connection.signal.aborted) {
          const [activityLost,executionLost]=await Promise.all([unsubscribe.finish?.(),unsubscribeExecution.finish?.()]);
          const lost=(activityLost??0)+(executionLost??0);
          if(lost&&notices&&!turn.cancelled&&!connection.signal.aborted){
            // Enqueue on the existing transport before final; never wait for an extra renderer acknowledgement.
            void client.notify(c.session.update,{sessionId,update:acpDeliveryGap(operation.operationId,lost,'finish_unconfirmed')}).catch(()=>{});
          }
        }
        stopDisplay();
        const answer = operationMessage(operation);
        if (answer !== undefined) await message(client, sessionId, answer);
        return { stopReason: stopReason(operation) };
      } catch (error) {
        const issue = hostError(error);
        if (error instanceof RequestError) throw error;
        throw new RequestError(-32000, issue.message, { code: issue.code, path: issue.path });
      } finally {
        stopDisplay();
        connection.signal.removeEventListener('abort',stopDisplay);
        turns.delete(sessionId);
        settled.resolve(undefined);
      }
    })
    .onNotification(a.session.cancel, ({ params }) => cancel(params.sessionId));

  /** @type {AgentConnection} */
  const connection = app.connect({ writable: stream.writable, readable: stream.readable.pipeThrough(capture) });
  return {
    connection,
    async drain() {
      while (turns.size) await Promise.allSettled([...turns.values()].map(turn => turn.settled));
    },
    /** @param {string | undefined} operationId */
    route(operationId) {
      if (!operationId || connection.signal.aborted) return undefined;
      for (const [sessionId, session] of sessions) {
        if (session.operations.includes(operationId)) {
          const turn = turns.get(sessionId);
          if (turn?.operationId === operationId && turn.cancelled) return undefined;
          return { sessionId, client: connection.client, signal: connection.signal, capabilities, rawCapabilities };
        }
      }
    },
  };
}
