// An opt-in, standalone Router-only A/B evaluation. The normal workflow is
// interrupted immediately after the authoritative route event: Explorer,
// Coder, verification and all repository mutations are NEVER invoked.
import { runWorkflow } from '../workflow.mjs';

const MODES=new Set(['change','review','investigate','plan']);
const RISK=['normal','architecture','security_or_data'];
const COMPLEXITY=['low','medium','high'];
const WRITES=new Set(['explicit','not_requested','ambiguous']);
const OVERRIDES=new Set(['change','review','investigate']);
const safeId=s=>typeof s==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(s);
const validValue=(v,options)=>v===undefined||options.has(v);
const routingFields=['mode','writeIntent','complexity','risk'];
const policyFields=['mode','tier','plan','coder','reviewer','responder','finalValidation','runVerification'];
export function validateRouterFixture(f) {
  if(!f||!safeId(f.id)||typeof f.task!=='string'||!f.task.trim()||f.task.length>12_000 ||
    (f.modeOverride!==undefined&&!OVERRIDES.has(f.modeOverride)) ||
    (f.planOnly!==undefined&&typeof f.planOnly!=='boolean') ||
    (f.skillName!==undefined&&(!safeId(f.skillName)||f.skillName.length>48)) ||
    (f.expected!==undefined&&(!f.expected||typeof f.expected!=='object'||Array.isArray(f.expected)||
      Object.keys(f.expected).some(k=>!routingFields.includes(k))||
      !validValue(f.expected.mode,MODES)||!validValue(f.expected.writeIntent,WRITES)||
      !validValue(f.expected.complexity,new Set(COMPLEXITY))||!validValue(f.expected.risk,new Set(RISK)))))
    throw new TypeError('Invalid Router evaluation fixture (id/task/modeOverride/expected)');
  return {id:f.id,task:f.task,modeOverride:f.modeOverride??null,planOnly:f.planOnly===true,
    skillName:f.skillName??null,expected:f.expected??null};
}
const cmp=(actual,expected,fields)=>Object.fromEntries(fields.filter(f=>actual?.[f]!==expected?.[f]).map(f=>[f,{legacy:actual?.[f]??null,optimized:expected?.[f]??null}]));
export function compareRouterDecisions(legacy,optimized,expected=null) {
  if(!legacy?.classification||!optimized?.classification||!legacy?.policy||!optimized?.policy) throw new TypeError('Both route events are required');
  const routingDifference=cmp(legacy.classification,optimized.classification,routingFields);
  const policyDifference=cmp(legacy.policy,optimized.policy,policyFields);
  const violations=[];
  const before=legacy.classification,after=optimized.classification;
  if(before.mode!=='change' && after.mode==='change' && after.writeIntent==='explicit') violations.push('unexpected_write_route');
  if(before.risk && after.risk && RISK.indexOf(after.risk)<RISK.indexOf(before.risk)) violations.push('risk_downgrade');
  if(before.complexity && after.complexity && COMPLEXITY.indexOf(after.complexity)<COMPLEXITY.indexOf(before.complexity)) violations.push('complexity_downgrade');
  if(legacy.policy.finalValidation===true && optimized.policy.finalValidation!==true) violations.push('required_final_validation_lost');
  if(legacy.policy.runVerification===true && optimized.policy.runVerification!==true) violations.push('required_verification_lost');
  const expectedMismatches=expected?Object.keys(expected).filter(key=>optimized.classification[key]!==expected[key]):[];
  const legacyMismatches=expected?Object.keys(expected).filter(key=>legacy.classification[key]!==expected[key]):[];
  return {equivalent:Object.keys(routingDifference).length===0&&Object.keys(policyDifference).length===0,
    routingDifference,policyDifference,violations,expectedMismatches,legacyMismatches,
    acceptable:violations.length===0&&expectedMismatches.length===0&&Object.keys(policyDifference).length===0};
}
class RouteCaptured extends Error { constructor(){super('ROUTER_EVALUATION_STOP');this.code='ROUTER_EVALUATION_STOP';} }
export async function evaluateRouterFixture({fixture,repoRoot,config,registryFactory, onRoute}={}) {
  const safe=validateRouterFixture(fixture);
  if(typeof registryFactory!=='function') throw new TypeError('A registryFactory is required');
  const results={};
  for(const mode of ['legacy','optimized']) {
    const registry=await registryFactory();
    let route=null,context=null;
    try {
      try {
        await runWorkflow({task:safe.task,repoStart:repoRoot,config,registry,modeOverride:safe.modeOverride,
          planOnly:safe.planOnly,skillName:safe.skillName,efficiency:{routerContextMode:mode},reporter:async event=>{
            if(event.type==='role_router_context') context=event.routerContext;
            if(event.type==='route') {route={classification:event.classification,policy:event.policy};throw new RouteCaptured();}
          }});
        throw new Error('Router evaluation did not reach a route event');
      } catch(error) { if(!(error instanceof RouteCaptured)) throw error; }
    } finally { await registry.close?.(); }
    if(!route) throw new Error('Missing Router result');
    results[mode]={...route,context};
    onRoute?.(mode,{classification:route.classification,policy:route.policy,context});
  }
  const comparison=compareRouterDecisions(results.legacy,results.optimized,safe.expected);
  const selected=results.optimized.context?.selected??'legacy';
  // A fallback to full context cannot prove optimization quality or savings.
  return {id:safe.id,optimizedContextSelected:selected,manifestReason:results.optimized.context?.reason??'unknown',
    legacyContextChars:results.legacy.context?.originalCharacters??null,
    candidateContextChars:results.optimized.context?.projectedCharacters??null,
    ...comparison,eligible:selected==='optimized',
    pass:selected==='optimized'&&comparison.acceptable};
}
