// The Router is the sole natural-language semantic authority.
// This guard compares typed fields only; it never searches the user prompt.
export function validateRouteConsistency(classification, { taskSpec = null } = {}) {
  if (!taskSpec) return {classification, status:'missing',reason:'task_spec_required'};
  // The old top-level route has no 'plan' enum: a read-only Plan is a
  // specialized Investigate, never an independent write authorization.
  const planAlias=taskSpec.operation==='plan' && classification.mode==='investigate' &&
    classification.writeIntent==='not_requested';
  if (!planAlias && (taskSpec.operation !== classification.mode || taskSpec.writeIntent !== classification.writeIntent)) {
    return {classification:{...classification,mode:'investigate',writeIntent:'not_requested'},
      status:'rejected',reason:'typed_contract_mismatch'};
  }
  return {classification:planAlias ? {...classification,mode:'plan'} : classification,status:'accepted',reason:'validated_semantic_task'};
}
