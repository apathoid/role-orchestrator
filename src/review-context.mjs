// Review-only history reduction. Never alters project/skill/security policies,
// active task, source scope, or the evidence required for an assignment.
// Off by default because historical user constraints may still be relevant.
const historicalDependency = /(?:как\s+(?:ранее|обсуждали|договаривались)|по\s+предыдущ|как\s+прежде|согласно\s+прошл|same\s+as\s+(?:before|earlier)|as\s+(?:discussed|above)|previous\s+(?:instructions|request)|earlier\s+(?:instructions|request))/iu;
export function boundedReviewHistory(history, { task = '', maxCharacters = 10000, mode = 'legacy' } = {}) {
  if (!['legacy','bounded_history'].includes(mode)) throw new Error('Invalid Review context mode');
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 3000 || maxCharacters > 100000)
    throw new Error('Invalid Review history limit');
  const value = String(history ?? '');
  const tooLong = value.length > maxCharacters;
  if (mode === 'legacy' || !tooLong || historicalDependency.test(task)) return {
    text:value, reduced:false, originalCharacters:value.length, savedCharacters:0,
    reason:historicalDependency.test(task) && tooLong ? 'historical_reference_requires_full_context' : 'full_history' };
  // The original task and all authoritative instruction files are supplied by
  // different REQUIRED prompt blocks. This *opt-in* reduction concerns only
  // old, non-authoritative conversation history.
  const tail=value.slice(-maxCharacters);
  const boundary=tail.indexOf('\n');
  const retained=boundary >= 0 && boundary < 200 ? tail.slice(boundary+1) : tail;
  const header='HISTORICAL CONTEXT PARTIAL: earlier turns were omitted by explicitly configured Review policy. Do not infer missing constraints. Inspect primary sources and report uncertainty when needed.\n';
  return {text:header+retained,reduced:true,originalCharacters:value.length,
    savedCharacters:Math.max(0,value.length-header.length-retained.length),reason:'optional_review_history_bounded'};
}
