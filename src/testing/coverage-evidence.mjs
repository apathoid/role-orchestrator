// Test coverage inventory for a Git-backed semantic Task Spec. No test-file
// existence, matcher or scenario template is ever promoted to code coverage.
import { execFileSafe } from '../repo.mjs';
import { resolveReviewScope } from '../review-scope.mjs';
import { validateTaskSpec } from '../routing/task-spec.mjs';
import { classifyTestCandidate, associateTestCandidates } from './discovery.mjs';
export async function buildTestCoverageEvidence(root, taskSpec, {signal,maxProductionFiles=150,discoveryAdapters=undefined}={}) {
  const typed = validateTaskSpec(taskSpec);
  if (typed.target.kind!=='git') return {status:'UNVERIFIED',reason:'git_scope_not_selected',files:[]};
  const scope=await resolveReviewScope(root,typed,null,signal);
  if (!scope.complete) return {status:'UNVERIFIED',reason:scope.reason??'incomplete_git_scope',scope,files:[]};
  const {stdout}=await execFileSafe('git',['ls-files','--cached','--others','--exclude-standard','-z'],
    {cwd:root,signal,env:{GIT_OPTIONAL_LOCKS:'0'},requireComplete:true,
      maxCaptureChars:10_000_000,maxResultChars:10_000_000,timeoutMs:30_000});
  const files=new Set(stdout.split('\0').filter(Boolean));
  const options=discoveryAdapters ? {adapters:discoveryAdapters} : {};
  const classified=new Map([...new Set([...files,...scope.paths.map(p=>p.path)])].map(path=>[path,classifyTestCandidate(path,options)]));
  const tests=[...files].filter(path=>classified.get(path)?.kind==='test').sort();
  const selected=scope.paths.map(p=>p.path);
  const production=selected.filter(path=>classified.get(path)?.kind==='production_candidate');
  const changedTests=selected.filter(path=>classified.get(path)?.kind==='test');
  const unknownPaths=selected.filter(path=>classified.get(path)?.kind==='unknown');
  const truncated=production.length>maxProductionFiles;
  const evidence=production.slice(0,maxProductionFiles).map(path=>{
    const candidates=associateTestCandidates(path,tests,options);
    const changed=new Set(changedTests);
    const changes=scope.paths.find(p=>p.path===path)?.changes??[];
    return {productionPath:path,changes,sourceAdapter:classified.get(path).adapter,
      pathPresence:files.has(path)?'PRESENT':'DELETED_OR_MISSING',
      existingTests:candidates.filter(({path})=>!changed.has(path)).map(({path})=>path),
      changedTests:candidates.filter(({path})=>changed.has(path)).map(({path})=>path),
      testCandidates:candidates,
      // Nothing here assesses changed behavior. Empty scenarios are more
      // truthful than manufacturing generic positive/concurrency cases.
      scenarios:[],scenarioAssessment:{status:'NOT_VERIFIED',reason:'behavior_and_assertions_not_adjudicated'},
      testAssociation:'HEURISTIC',behaviorCoverage:'NOT_VERIFIED'};
  });
  return {version:1,status:truncated || unknownPaths.length?'PARTIAL':'INVENTORIED_NOT_VERIFIED',
    scope:{selector:scope.selector,revisionKey:scope.revisionKey,manifestKey:scope.manifestKey,
      sourceChangesets:scope.changesets.length,uniqueChangedPaths:scope.paths.length},
    productionFilesTotal:production.length,productionFilesReported:evidence.length,
    changedTestFiles:changedTests,unknownChangedPaths:unknownPaths,discoveryStatus:unknownPaths.length?'PARTIAL':'CANDIDATES_ONLY',files:evidence,
    codeCoverage:{status:'UNAVAILABLE',percentage:null,reason:'no_instrumented_coverage_report_witnessed'},
    scenarioCoverage:{status:'NOT_VERIFIED',percentage:null},
    caveat:'File name associations are unverified candidates; scenario matrices, assertions, executed tests and code coverage are not established by inventory.'};
}
