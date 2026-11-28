import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { agent, methods, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk';
import { decode, id, invalid as invalidField, optional, record } from '../core/decode.js';
import { hostError } from './commands.js';
import { userSettings, agentSkill } from '../core/contracts.js';
import { featureKinds } from '../application/configuration/user-settings.js';
import { acpActivity, acpExecutionNotices, acpExecutionInline, acpAccepted, acpProgressGap, acpOwnMessage } from './presentation.js';

import { operationRequestId, operationReply, responseBoundary, historicalReply, replayHistory, turnRange } from './acp-history.js';
import { createBoundedDelivery } from '../application/delivery.js';

/** @import {AgentContext, AgentConnection, ClientCapabilities, Stream, SessionUpdate, SessionConfigOption} from '@agentclientprotocol/sdk' */
/** @import {ActivityListener, ActivityScope} from '../core/ports.js' */
/** @import {PresentationMode, ProgressDisplay} from './presentation.js' */
/** @import {Session} from './acp-history.js' */
/** @import {HostApi} from './commands.js' */
/** @typedef {HostApi & {settings: (workspace: import('../core/contracts.js').Request['workspaceContext'], controllerProfile?: string, overrides?:import('../core/contracts.js').UserSettings) => Promise<import('../application/configuration/user-settings.js').UserSettingsView>, skills?: (cwd:string)=>Promise<Awaited<ReturnType<typeof import('../adapters/configuration/agent-skills.js').discoverAgentSkills>>>, selectSkill?: (cwd:string,selection:string)=>Promise<import('../adapters/configuration/agent-skills.js').AgentSkill|undefined>, findRequest: import('./commands.js').Coordinator['findRequest'], subscribeActivity: (scope: ActivityScope, listener: ActivityListener) => (() => void) & {finish?: () => Promise<number>}, subscribeExecution?: (scope: ActivityScope, listener: import('../application/events.js').EventListener) => (() => void) & {finish?:()=>Promise<number>}}} AcpApi */
/** @typedef {{operationId?: string, cancelled: boolean, settled: Promise<void>, stopDisplay?:()=>void}} Turn */

const a = methods.agent;
const c = methods.client;

const turnOptions = record({
  requestId: optional(id), continueOperationId: optional(id), supersedeOperationId: optional(id),
  newOperation: optional((value, path) => typeof value === 'boolean' ? value : invalidField(path, 'a boolean')),
});

/** @param {string} message @param {unknown} [data] */
const invalid = (message, data) => new RequestError(-32602, message, data);

/** @param {AcpApi} api @param {string} directory @param {Stream} stream @param {PresentationMode} [mode] @param {ProgressDisplay} [progressDisplay] @param {import('./acp-history.js').ReplayContent} [replayContent] */
export function serveAcp(api, directory, stream, mode = 'compact', progressDisplay = 'inline', replayContent) {
  /** @type {Map<string, Session>} */
  const sessions = new Map();
  /** @type {Map<string, Turn>} */
  const turns = new Map();
  const loading = new Set();
  const changingSettings = new Set();
  /** @type {Map<string, Promise<void>>} */
  const sessionWrites = new Map();
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

  /** Serialize the existing session journal writes, including preference updates.
   * The new preference becomes visible only after the write succeeds.
   * @param {Session} session @param {Pick<Session,'controllerProfile'|'userSettings'>} [preferences]
   */
  async function save(session, preferences) {
    const previous = sessionWrites.get(session.sessionId) ?? Promise.resolve();
    const writing = previous.catch(() => {}).then(async () => {
      const file = sessionPath(session.sessionId);
      const temporary = file + '.' + randomUUID();
      try {
        await writeFile(temporary, JSON.stringify(preferences === undefined ? session : { ...session, ...preferences }), { mode: 0o600, flag: 'wx', flush: true });
        await rename(temporary, file);
        const handle = await open(directory, 'r');
        try { await handle.sync(); } finally { await handle.close(); }
        if (preferences !== undefined) Object.assign(session,preferences);
      } finally { await rm(temporary, { force: true }); }
    });
    sessionWrites.set(session.sessionId, writing);
    try { await writing; }
    finally { if (sessionWrites.get(session.sessionId) === writing) sessionWrites.delete(session.sessionId); }
  }

  /** @param {import('../application/configuration/user-settings.js').UserSettingsView} view
   * @param {string} [unavailable] @returns {SessionConfigOption[]}
   */
  function configOptions(view,unavailable) {
    /** @type {SessionConfigOption[]} */
    const options=[];
    const profile=view.controllerProfile;
    if(profile.current===undefined)return options;
    options.push({id:'controllerProfile',name:'Controller profile',category:'model',type:'select',
      ...(unavailable&&{description:'Previous profile unavailable: '+unavailable+'. Current default selected for future prompts.'}),
      currentValue:profile.current,options:profile.options.map(item=>({value:item.id,name:item.name}))});
    for(const kind of featureKinds) {
      const descriptor=view[kind];
      if(!descriptor||descriptor.current===undefined)continue;
      options.push({id:kind,type:'select',name:kind==='reasoningEffort'?'Reasoning effort':kind==='collaborationMode'?'Collaboration mode':'Approval mode',
        ...(kind==='reasoningEffort'&&{category:/** @type {const} */('thought_level')}),
        ...(kind==='collaborationMode'&&{category:/** @type {const} */('mode')}),
        currentValue:descriptor.current,options:descriptor.options.map(item=>({value:item.id,name:item.name,
          ...(item.description!==undefined&&{description:item.description})}))});
    }
    return options;
  }

  /** @param {Session} session */
  const settingsView=session=>api.settings({cwd:session.cwd},session.controllerProfile,session.userSettings);

  /** @param {string} cwd @param {readonly unknown[]} servers */
  function checkSession(cwd, servers) {
    if (!initialized) throw invalid('Initialize the ACP connection first');
    if (!isAbsolute(cwd)) throw invalid('Session cwd must be absolute');
    if (servers.length) throw invalid('Client-supplied MCP servers are unavailable');
  }

  /** @param {AgentContext} client @param {string} sessionId @param {SessionUpdate} update */
  async function sendUpdate(client,sessionId,update) {
    if (connection.signal.aborted) return;
    try {
      await client.notify(c.session.update, {
        sessionId, update,
      });
    } catch (error) {
      if (!connection.signal.aborted) throw error;
    }
  }

  /** @param {AgentContext} client @param {string} sessionId @param {string} text */
  const message=(client,sessionId,text)=>sendUpdate(client,sessionId,{sessionUpdate:'agent_message_chunk',content:{type:'text',text}});

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

  /** @param {AgentContext} client @param {Session} session */
  async function publishSkills(client,session) {
    if(!api.skills)return;
    try {
      const {commands}=await api.skills(session.cwd);
      if(!commands.length)return;
      await sendUpdate(client,session.sessionId,{sessionUpdate:'available_commands_update',availableCommands:commands.map(item=>({name:item.name,description:item.description,input:{hint:'Optional instruction'}}))});
    }catch{/* Discovery never prevents an ordinary session. */}
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
        agentCapabilities: { loadSession: true, promptCapabilities: { image: !!replayContent, audio: !!replayContent, embeddedContext: !!replayContent } },
      };
    })
    .onRequest(a.session.new, async ({ params,client }) => {
      checkSession(params.cwd, params.mcpServers);
      const session = { sessionId: randomUUID(), cwd: params.cwd, operations: [], requests: [] };
      const options = configOptions(await settingsView(session));
      await save(session);
      sessions.set(session.sessionId, session);
      await publishSkills(client,session);
      return { sessionId: session.sessionId, configOptions: options };
    })
    .onRequest(a.session.load, async ({ params, client }) => {
      const { sessionId, cwd } = params;
      checkSession(cwd, params.mcpServers);
      if (turns.has(sessionId) || loading.has(sessionId) || changingSettings.has(sessionId)) throw invalid('Session is busy');
      loading.add(sessionId);
      try {
        const file = sessionPath(sessionId);
        /** @type {Session} */
        const session = await readFile(file, 'utf8').then(JSON.parse).catch(() => { throw invalid('Unknown session'); });
        if (session.sessionId !== sessionId || !Array.isArray(session.operations) ||
            !session.operations.every(id => typeof id === 'string')) throw invalid('Invalid stored session');
        if (session.controllerProfile !== undefined && typeof session.controllerProfile !== 'string') throw invalid('Invalid stored profile selection');
        if (session.userSettings !== undefined && decode(userSettings,session.userSettings).kind!=='accepted') throw invalid('Invalid stored user settings');
        session.requests ??= [];
        if(!Array.isArray(session.requests)||session.requests.some(request=>!request||typeof request.requestId!=='string'||typeof request.fingerprint!=='string'||
          (request.controllerProfile!==undefined&&typeof request.controllerProfile!=='string')||
          (request.userSettings!==undefined&&decode(userSettings,request.userSettings).kind!=='accepted')||
          (request.agentSkill!==undefined&&decode(agentSkill,request.agentSkill).kind!=='accepted')||
          (request.operationId!==undefined&&!session.operations.includes(request.operationId))))throw invalid('Invalid stored session requests');
        for (const request of session.requests) {
          if (request.operationId) continue;
          const operation = await api.findRequest(operationRequestId(sessionId, request.requestId));
          if (operation&&turnRange(operation,operationRequestId(sessionId,request.requestId))) attach(session, request, operation.operationId);
        }
        session.cwd = cwd;
        let view=await settingsView(session);
        const unavailable=view.controllerProfile.unavailable;
        if(unavailable&&session.controllerProfile!==undefined) {
          session.controllerProfile=undefined;
          view=await settingsView(session);
        }
        session.userSettings=view.overrides;
        const options=configOptions(view,unavailable);
        await save(session);
        await replayHistory(session,id=>api.inspect(id),update=>sendUpdate(client,sessionId,update),mode,progressDisplay,connection.signal,replayContent);
        sessions.set(sessionId, session);
        await publishSkills(client,session);
        return { configOptions: options };
      } finally { loading.delete(sessionId); }
    })
    .onRequest(a.session.setConfigOption, async ({ params }) => {
      const { sessionId, configId, value } = params;
      const session = sessions.get(sessionId);
      if (!session || loading.has(sessionId) || changingSettings.has(sessionId)) throw invalid('Session is unavailable or settings are busy');
      if (typeof value !== 'string') throw invalid('Unknown logical setting value');
      changingSettings.add(sessionId);
      try {
        const view=await settingsView(session);
        /** @type {Pick<Session,'controllerProfile'|'userSettings'>} */
        const preferences={controllerProfile:session.controllerProfile,userSettings:session.userSettings};
        if(configId==='controllerProfile') {
          if(!view.controllerProfile.options.some(item=>item.id===value))throw invalid('Unavailable Controller profile');
          preferences.controllerProfile=value;
        } else {
          const kind=featureKinds.find(item=>item===configId);
          if(!kind||!view[kind]?.options.some(item=>item.id===value))throw invalid('Unavailable user setting');
          preferences.userSettings={...view.overrides,[kind]:value};
        }
        const updated=await settingsView({...session,...preferences});
        if(updated.controllerProfile.current===undefined)throw invalid('Unavailable Controller profile');
        preferences.userSettings=updated.overrides;
        await save(session,preferences);
        return {configOptions:configOptions(updated)};
      } finally { changingSettings.delete(sessionId); }
    })
    .onRequest(a.session.prompt, async ({ params, client }) => {
      const { sessionId, prompt } = params;
      const session = sessions.get(sessionId);
      if (!session || loading.has(sessionId)) throw invalid('Create or load the session before prompting');
      const ordered=prompt.some(block=>block.type!=='text'||block.annotations!==undefined||block._meta!==undefined)||prompt.length>1;
      if(ordered&&!replayContent)throw invalid('Ordered content transport is unavailable');
      if(!prompt.length)throw invalid('A nonempty prompt is required');
      const text=prompt.map(block=>block.type==='text'?block.text:'').join('\n');
      if(!ordered&&!text.trim())throw invalid('A nonempty prompt is required');
      const content=ordered?prompt.map(block=>{
        if(block.type==='text'){const {type,text,...metadata}=block;return {kind:'text',text,metadata};}
        if(block.type==='image'||block.type==='audio'){const {type,data,mimeType,...metadata}=block;return {kind:type,data,mediaType:mimeType,encoding:'binary',metadata};}
        if(block.type==='resource_link'){const {type,uri,mimeType,...metadata}=block;return {kind:'link',uri,mediaType:mimeType,metadata};}
        const {type,resource,...outer}=block;
        const raw=/** @type {Record<string,unknown>} */ (resource);
        const {uri,mimeType,text:body,blob,...metadata}=raw;
        return {kind:'resource',uri,mediaType:mimeType,data:typeof body==='string'?body:blob,encoding:typeof body==='string'?'utf8':'binary',metadata:{outer,resource:metadata}};
      }):undefined;
      const userInput=content?{content}:{text};
      const parsed = decode(turnOptions, params._meta?.roleOrchestrator ?? {});
      if (parsed.kind === 'rejected') throw invalid('Invalid Role Orchestrator turn options', parsed.reason.path);
      const { continueOperationId, supersedeOperationId, newOperation, requestId = randomUUID() } = parsed.value;
      if ((continueOperationId && newOperation) || (continueOperationId && supersedeOperationId)) {
        throw invalid('Choose one turn action');
      }
      const durableRequestId = operationRequestId(sessionId, requestId);
      const fingerprint = createHash('sha256').update(JSON.stringify([content??text, continueOperationId, supersedeOperationId, newOperation])).digest('hex');
      // Snapshot the committed UI preference before any asynchronous work.
      const selectedProfile = session.controllerProfile;
      const selectedSettings = structuredClone(session.userSettings);
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
      const ownProgress=progressDisplay==='inline'||notices;
      /** @typedef {{update?:SessionUpdate,count?:number}} TransportItem */
      /** @type {ReturnType<typeof createBoundedDelivery<TransportItem,TransportItem>>|undefined} */
      let transport;
      let subscribed = false;
      let displaying = true;
      const stopDisplay = () => { displaying = false; unsubscribe(); unsubscribeExecution(); transport?.close(); };
      turn.stopDisplay=stopDisplay;
      connection.signal.addEventListener('abort',stopDisplay,{once:true});
      try {
        if (!request) {
          const shortcut=/^\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\s|$)/u.exec(text);
          const skill=shortcut&&api.selectSkill?await api.selectSkill(session.cwd,shortcut[1]):undefined;
          const view=await api.settings({cwd:session.cwd},selectedProfile,selectedSettings);
          const selection=view.controllerProfile;
          if(selection.current===undefined&&selectedProfile!==undefined)throw invalid('Selected Controller profile is unavailable');
          request={requestId,fingerprint,controllerProfile:selection.current,userSettings:view.overrides,...(skill&&{agentSkill:{name:skill.name,path:skill.path,source:skill.source}})};
          session.requests.push(request);
          await save(session);
        }
        let operation = await api.findRequest(durableRequestId);
        const duplicate=operation!==undefined;
        if (!operation) {
          const last = session.operations.at(-1);
          if (continueOperationId && !session.operations.includes(continueOperationId)) throw invalid('Operation belongs to another session');
          const target = continueOperationId ?? (newOperation || supersedeOperationId ? undefined : last);
          const prior = target && await api.inspect(target);
          const workspaceContext = { cwd: session.cwd };
          const delivery = request;
          const continuing=Boolean(prior && (continueOperationId || prior.status === 'waiting' || prior.status === 'finished'));
          /** @param {string} id */
          const accepted = id => {
            turn.operationId = id;
            attach(session, delivery, id);
            delivery.progressDisplay=progressDisplay;
            if (subscribed||!displaying||turn.cancelled||connection.signal.aborted) return;
            subscribed = true;
            const canDisplay=()=>displaying&&!turn.cancelled&&!connection.signal.aborted&&turn.operationId===id&&turns.get(sessionId)===turn;
            // One bounded transport consumer for native and own presentation.
            // Producers never await the renderer; only the owning turn drains it.
            transport=createBoundedDelivery(/** @param {TransportItem} item */ async item=>{
              if(item.update&&canDisplay())await client.notify(c.session.update,{sessionId,update:item.update});
            },(prior,_dropped)=>{
              const count=(prior?.count??0)+1;
              return {count,update:acpProgressGap(id,count,'overflow',progressDisplay,notices)};
            });
            /** @param {SessionUpdate|undefined} update */
            const enqueue=update=>{
              if(update&&canDisplay())transport?.enqueue({update},Buffer.byteLength(JSON.stringify({sessionId,update}))+128);
            };
            if(ownProgress)enqueue(acpAccepted(id,durableRequestId,continuing,progressDisplay,false,mode));
            unsubscribe = api.subscribeActivity({operationId:id}, event => {
              if (!canDisplay()) return;
              enqueue(event.kind==='gap'?acpProgressGap(id,event.droppedCount,event.reason,progressDisplay,notices,event.attemptId):
                acpActivity(event,mode,event.invocationKind==='controller'));
            });
            if (ownProgress && api.subscribeExecution) unsubscribeExecution=api.subscribeExecution({operationId:id},(event,findings,fact)=>{
              if(!canDisplay())return;
              for(const update of progressDisplay==='inline'?acpExecutionInline(event,findings,mode,fact):acpExecutionNotices(event,findings,mode,fact))enqueue(update);
            });
          };
          const submission = prior && (continueOperationId || prior.status === 'waiting' || prior.status === 'finished')
            ? await api.resume(prior.operationId, { requestId: durableRequestId, ...userInput, workspaceContext, controllerProfile: request.controllerProfile, userSettings:request.userSettings, agentSkill:request.agentSkill, replaceSettings:true,
              questionId: prior.waiting?.kind === 'question' ? prior.waiting.questionId : undefined }, accepted)
            : await api.submit({
              schemaVersion: 1, requestId: durableRequestId, ...userInput, attachments: [], userConstraints: [],
              configurationRef: api.configurationRef, workspaceContext, controllerProfile: request.controllerProfile, userSettings:request.userSettings, agentSkill:request.agentSkill,
            }, accepted);
          accepted(submission.operation.operationId);
          if (turn.cancelled) await cancel(sessionId);
          // Retain ownership of a submitted operation even if the session journal write fails.
          await save(session).finally(() => submission.completion.then(() => {}, () => {}));
          operation = await submission.completion;
          const boundary=responseBoundary(operation,durableRequestId);
          if(boundary!==undefined){
            delivery.responseEventId=boundary;
            try{await save(session);}catch{
              const update=acpOwnMessage('Historical response boundary could not be persisted; recovery may be incomplete',
                {source:'history',operationId:operation.operationId,requestId:durableRequestId});
              if(displaying&&!connection.signal.aborted&&progressDisplay==='inline')void client.notify(c.session.update,{sessionId,update}).catch(()=>{});
            }
          }
        } else {
          attach(session, request, operation.operationId);
          await save(session);
        }
        if (!turn.cancelled && !connection.signal.aborted) {
          const [activityLost,executionLost]=await Promise.all([unsubscribe.finish?.(),unsubscribeExecution.finish?.()]);
          const transportLost=await transport?.finish()??0;
          const lost=(activityLost??0)+(executionLost??0)+transportLost;
          if(lost&&ownProgress&&!turn.cancelled&&!connection.signal.aborted){
            // Enqueue on the existing transport before final; never wait for an extra renderer acknowledgement.
            const update=acpProgressGap(operation.operationId,lost,'finish_unconfirmed',progressDisplay,notices);
            if(update)void client.notify(c.session.update,{sessionId,update}).catch(()=>{});
          }
        }
        stopDisplay();
        const recovered=duplicate?historicalReply(operation,durableRequestId,request.responseEventId):undefined;
        if(duplicate&&!recovered){
          await sendUpdate(client,sessionId,acpOwnMessage('Historical response boundary unavailable; original work was not replayed',
            {source:'history',operationId:operation.operationId,requestId:durableRequestId},durableRequestId));
          return {stopReason:'refusal'};
        }
        const reply=recovered?.reply??operationReply(operation);
        if (reply.text !== undefined) await message(client, sessionId, reply.text);
        return { stopReason: reply.stopReason };
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
