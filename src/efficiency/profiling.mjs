// Provider-neutral composition measurements. Never persist content or paths.
const KINDS = Object.freeze(['role_contract', 'context_and_instructions', 'engineering_policy', 'task_body', 'engineering_checkpoint']);
const SUBKINDS = new Set(['project_instructions_and_skills', 'review_target', 'session_history']);
const BODY_KINDS = new Set(['user_task','plan','exploration','engineering_frame','implementation','working_diff','verification','review','quality_recovery','git_reconciliation','workflow_scaffold','other']);
const INSTRUCTION_SCOPES = new Set(['global-orchestrator','global','project-orchestrator','project','nested','global-orchestrator-reference','global-reference','project-orchestrator-reference','project-reference','nested-reference','active-skill']);
const MAX_BYTES=50_000_000;
const quantity = v => Number.isSafeInteger(v) && v>=0 && v<=MAX_BYTES ? v : null;
const len = v => typeof v==='string' ? v.length : 0;
const bytes = v => Buffer.byteLength(typeof v==='string'?v:'','utf8');
const lengths = (kind,text) => ({kind,characters:quantity(len(text)),utf8Bytes:quantity(bytes(text))});
/** Body sources are supplied directly by workflow, never inferred from headers in untrusted text.
 * Attribute only non-overlapping, uniquely present exact source spans. Uncertain
 * source placement stays 'other' and is not counted twice.
 */
export function profileTaskBody(body, sources=[]) {
  const spans=[];
  for(const src of Array.isArray(sources)?sources.slice(0,128):[]) {
    if(!BODY_KINDS.has(src?.kind) || src.kind==='other' || typeof src.value!=='string' || !src.value.length) continue;
    const pos=Number.isSafeInteger(src.start) && src.start>=0 ? src.start : body.indexOf(src.value);
    if(pos<0 || body.slice(pos,pos+src.value.length)!==src.value || (src.start===undefined && body.indexOf(src.value,pos+1)!==-1) || spans.some(s=>pos<s.end && pos+src.value.length>s.start)) continue;
    spans.push({start:pos,end:pos+src.value.length,kind:src.kind,value:src.value});
  }
  spans.sort((a,b)=>a.start-b.start);
  const categories=new Map();
  let offset=0;
  const add=(kind,text) => { const old=categories.get(kind) ?? {characters:0,utf8Bytes:0}; old.characters+=len(text);old.utf8Bytes+=bytes(text);categories.set(kind,old); };
  for(const span of spans){ add('other',body.slice(offset,span.start));add(span.kind,span.value);offset=span.end; }
  add('other',body.slice(offset));
  return {sourceCoverage:spans.length, sections:[...categories].map(([kind,v])=>({kind,...v}))};
}
export function profileRolePrompt({ sections=[], prompt='', promptBlocks=[], contextSubsections={}, taskBodySources=[], instructionSources=[] }={}) {
  const parts=sections.slice(0,KINDS.length).map((v,i)=>({...lengths(KINDS[i],v),included:typeof v==='string'&&v.length>0}));
  const body=typeof sections[3]==='string'?sections[3]:'';
  return {
    version:1, scope:'orchestrator_prepared_only', promptCharacters:quantity(len(prompt)),promptUtf8Bytes:quantity(bytes(prompt)),
    sections:parts,
    contextSubsections:Object.entries(contextSubsections).filter(([kind])=>SUBKINDS.has(kind)).map(([kind,v])=>lengths(kind,v)),
    taskBody:profileTaskBody(body,taskBodySources),
    instructionSources:(Array.isArray(instructionSources)?instructionSources:[]).slice(0,32)
      .filter(s=>INSTRUCTION_SCOPES.has(s?.scope) && typeof s?.body==='string')
      .map(s=>({scope:s.scope,characters:quantity(s.body.length),utf8Bytes:quantity(Buffer.byteLength(s.body,'utf8'))})),
    supplementalBlocks:quantity(Array.isArray(promptBlocks)?promptBlocks.length:0),
    tokenEstimate:null,providerAddedContext:'unknown',
  };
}
const allowed = (o, kindSet, max) => Array.isArray(o) && o.length<=max && o.every(p=>kindSet.has(p?.kind)&&quantity(p.characters)!==null&&quantity(p.utf8Bytes)!==null);
export function normalizeContextProfile(value) {
  if(!value||value.version!==1||value.scope!=='orchestrator_prepared_only') return null;
  if(!Array.isArray(value.sections)||value.sections.length>KINDS.length||value.sections.some(p=>!KINDS.includes(p?.kind))) return null;
  if(value.contextSubsections!==undefined && !allowed(value.contextSubsections,SUBKINDS,SUBKINDS.size)) return null;
  if(value.instructionSources!==undefined && (!Array.isArray(value.instructionSources) || value.instructionSources.length>32 || value.instructionSources.some(s=>!INSTRUCTION_SCOPES.has(s?.scope)||quantity(s.characters)===null||quantity(s.utf8Bytes)===null))) return null;
  if(value.taskBody!==undefined && (!value.taskBody||!allowed(value.taskBody.sections,BODY_KINDS,BODY_KINDS.size)||quantity(value.taskBody.sourceCoverage)===null)) return null;
  if (value.taskBody && value.sections[3]) {
    const ch=value.taskBody.sections.reduce((n,p)=>n+p.characters,0);
    const by=value.taskBody.sections.reduce((n,p)=>n+p.utf8Bytes,0);
    if (ch!==value.sections[3].characters || by!==value.sections[3].utf8Bytes) return null;
  }
  return {
    version:1,scope:'orchestrator_prepared_only',promptCharacters:quantity(value.promptCharacters),promptUtf8Bytes:quantity(value.promptUtf8Bytes),
    supplementalBlocks:quantity(value.supplementalBlocks),tokenEstimate:null,providerAddedContext:'unknown',
    sections:value.sections.map(p=>({...lengths(p.kind,''),included:p.included===true,characters:quantity(p.characters),utf8Bytes:quantity(p.utf8Bytes)})),
    contextSubsections:(value.contextSubsections??[]).map(p=>({kind:p.kind,characters:quantity(p.characters),utf8Bytes:quantity(p.utf8Bytes)})),
    instructionSources:(value.instructionSources??[]).map(s=>({scope:s.scope,characters:quantity(s.characters),utf8Bytes:quantity(s.utf8Bytes)})),
    taskBody:value.taskBody?{sourceCoverage:quantity(value.taskBody.sourceCoverage),sections:value.taskBody.sections.map(p=>({kind:p.kind,characters:quantity(p.characters),utf8Bytes:quantity(p.utf8Bytes)}))}:undefined,
  };
}
/** Provider-adapter boundary: never claims to observe hidden agent instructions. */
export function normalizeProviderPromptProfile(v) {
  if(!v||v.scope!=='provider_adapter_prepared_only') return null;
  return { scope:'provider_adapter_prepared_only',characters:quantity(v.characters),utf8Bytes:quantity(v.utf8Bytes),
    textBlocks:quantity(v.textBlocks),supplementalBlocks:quantity(v.supplementalBlocks) };
}
export function profileProviderPrompt(text, supplementalBlocks=0) {
  return {scope:'provider_adapter_prepared_only',characters:quantity(len(text)),utf8Bytes:quantity(bytes(text)),textBlocks:1,supplementalBlocks:quantity(supplementalBlocks)};
}

// Explicit source spans for tagged templates, including repeated equal-valued
// fragments. The rendered text is identical to an ordinary template literal.
const trackedPart = Symbol('p3-tracked-part');
const trackedBodyId = Symbol('p3-tracked-body');
export function contextPart(kind, value) {
  if (!BODY_KINDS.has(kind)) throw new TypeError('Unknown context part kind');
  const text=String(value);
  return { [trackedPart]: true, kind, text, [Symbol.toPrimitive]:()=>text };
}
export function trackedBody(strings, ...values) {
  let text = ''; const spans=[];
  for (let i=0; i<strings.length; i++) {
    if (strings[i].length) spans.push({kind:'workflow_scaffold',value:strings[i],start:text.length});
    text += strings[i];
    if (i<values.length) {
      const v=values[i];
      const rendered = v?.[trackedPart]===true ? v.text : String(v);
      if (v?.[trackedPart]===true && rendered.length) spans.push({kind:v.kind,value:rendered,start:text.length});
      text += rendered;
    }
  }
  return { [trackedBodyId]: true, text, spans };
}
export function unpackTrackedBody(body, fallbackSources=[]) {
  return body?.[trackedBodyId]===true ? { text:body.text, sources:body.spans } : {text:body,sources:fallbackSources};
}
