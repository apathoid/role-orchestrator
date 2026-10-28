// Optional explicit Skill metadata. A skill cannot grant write permissions or
// bypass mandatory host security/Engineering Core checks.
export function resolveSkillExecutionPolicy(skill) {
  const declared = skill?.orchestratorDelegation ?? null;
  const delegation = ['allowed','restricted','forbidden'].includes(declared) ? declared : 'unspecified';
  return { delegation, explicit:delegation !== 'unspecified', source:skill ? 'skill_metadata' : 'none' };
}
export function skillExecutionCompatibility(skillPolicy, workflowMode) {
  if (!skillPolicy.explicit) return {compatible:true, reason:null};
  // Forbidden delegation cannot be represented by a multi-agent Role Orchestrator
  // workflow. Fail explicitly; never reinterpret as authorization to skip safety.
  if (skillPolicy.delegation === 'forbidden' && ['change','review','investigate'].includes(workflowMode))
    return {compatible:false, reason:'skill_forbids_multiagent_execution'};
  return {compatible:true, reason:null};
}
