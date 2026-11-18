import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { final } from './application.js';
import { assessment, outcome } from './core.js';

export const manifest = { id: 'host-fixture', version: '1', apiVersion: 1, exports: ['createProvider'] };

export function createProvider({ providerId }) {
  return {
    async describe() { return { providerId, maxConcurrency: null, capabilities: {} }; },
    async open() { return { sessionId: crypto.randomUUID() }; },
    async invoke(_session, invocation, observe, activity) {
      if (invocation.kind === 'delegate') {
        if (invocation.objective === 'quick-relay') {
          while (true) {
            try { await access(join(invocation.workspaceContext.cwd, 'relay-ready')); break; }
            catch (error) { if (error.code !== 'ENOENT') throw error; await delay(10, undefined, { signal: invocation.signal }); }
          }
        }
        const ref = observe({ ref: 'worker-output', kind: 'model', sourceId: invocation.attemptId,
          completeness: 'complete', value: 'Worker completed' });
        return { dispatchCertainty: 'sent', outcome: outcome(invocation.attemptId, {
          outputRefs: [{ ref, source: 'model_claim', kind: 'output' }],
        }), output: 'Worker completed', ...(invocation.objective==='notice-worker' && {findings:[{findingId:'notice-finding',author:invocation.profile.profileId,claim:'Model-authored notice',subject:'fixture',supports:[ref],uncertainties:['fixture uncertainty']} ]}) };
      }
      if (typeof invocation.context[0].value === 'string' && invocation.context[0].value.startsWith('hold')) {
        activity?.({kind:'reasoning',nativeKind:'agent_thought_chunk',payload:{sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'Fixture native hold'}}});
        await new Promise(resolve => {
          if (invocation.signal.aborted) resolve();
          else invocation.signal.addEventListener('abort', resolve, { once: true });
        });
      }
      const latest = invocation.context.findLast(item => item.provenance?.kind === 'user')?.value ?? invocation.context[0].value;
      const original = invocation.context[0].value;
      const unsafe = '\x1b[2JПривет 🌍\nLine\x1b]52;c;SECRET\x07\x9b31m!';
      if (latest === 'tty-question') return final(invocation, {finalAssessment:undefined,clarification:{question:unsafe}});
      if (latest === 'tty-control') return final(invocation, {finalAssessment:assessment({author:invocation.profile.profileId,answer:unsafe,overall:'complete'})});
      if (original === 'clarify' && latest === 'clarify') {
        return final(invocation, { finalAssessment: undefined, clarification: { question: 'What scope?' } });
      }
      if (latest === 'relay-clarify') {
        if (invocation.context.some(item => item.value === 'Worker completed')) {
          return final(invocation, { finalAssessment: undefined, clarification: { question: 'While the worker runs?' } });
        }
        const actions = [['quick', 'primary', 'quick-relay'], ['slow', 'relay', 'slow-relay']].map(([actionId, profileId, objective]) => ({
          kind: 'delegate', actionId, profileId, objective, expectedResult: 'Worker result', contextRefs: [], dependsOn: [],
          ...(actionId === 'slow' && { requiredCapabilities: ['tools.bridge'] }),
        }));
        return final(invocation, { finalAssessment: undefined, additions: actions,
          waitPolicy: { kind: 'next_completion', targets: actions.map(({ actionId }) => ({ kind: 'action', id: actionId })) } });
      }
      if ((latest === 'delegate'||latest==='notice-delegate') && !invocation.context.some(item => item.value === 'Worker completed')) {
        return final(invocation, { finalAssessment: undefined, additions: [{
          kind: 'delegate', actionId: 'delegated', profileId: invocation.profile.profileId, objective: latest==='notice-delegate'?'notice-worker':'Do the work',
          expectedResult: 'Worker result', contextRefs: [], dependsOn: [],
        }], waitPolicy: { kind: 'all_requested', targets: [{ kind: 'action', id: 'delegated' }] } });
      }
      let answer = latest === 'cwd' ? invocation.workspaceContext?.cwd : latest === 'delegate' ? 'Delegated result' : latest==='notice-delegate'?'Notice final': 'Ответ: ' + latest;
      if (latest === 'settings') answer = JSON.stringify([invocation.profile.profileId, invocation.timeoutMs]);
      if (latest === 'permission'||latest === 'permission-paged') {
        const options=latest==='permission-paged'
          ?Array.from({length:30},(_,i)=>({
            id:'option-'+(i+1),kind:i===29?'allow':'deny',
            label:i===29?'Allow all paths':'Deny '+(i+1),
            scope:i===29?'always':'once',
          }))
          :[{ id: 'allow', kind: 'allow' }, { id: 'deny', kind: 'deny' }];
        const permission = await invocation.permissions.request({
          providerRequestId: 'fixture', resource: 'fixture:read', options,
        });
        answer = permission.kind === 'selected' ? permission.option : permission.kind;
      }
      return final(invocation, { finalAssessment: assessment({
        author: invocation.profile.profileId, answer, overall: latest === 'partial' ? 'partial' : 'complete',
      }) });
    },
    async cancel() {},
    async close() {},
  };
}
