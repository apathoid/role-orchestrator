// Provider-neutral execution accounting. Segment limits control one explicit
// execution attempt; operation hard limits remain binding across continuation.
const integer = v => Number.isSafeInteger(v) && v >= 0 ? v : null;
const HARD = {maxOperationInvocations:'invocations',maxOperationElapsedMs:'elapsed',
  maxOperationInputTokens:'input_tokens',maxOperationOutputTokens:'output_tokens'};
export function normalizeExecutionBudget(raw = {}, { fallbackInvocations = null } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid execution budget');
  const defaults = {maxInvocations:fallbackInvocations, maxElapsedMs:null,
    maxInputTokens:null, maxOutputTokens:null, ...Object.fromEntries(Object.keys(HARD).map(k=>[k,null]))};
  if (Object.keys(raw).some(k=>!(k in defaults))) throw new Error('Invalid execution budget key');
  const limits = {};
  for (const [key, fallback] of Object.entries(defaults)) {
    const v = raw[key] === undefined ? fallback : raw[key];
    if (v !== null && (!Number.isSafeInteger(v) || v < 1)) throw new Error(`Invalid execution budget ${key}`);
    limits[key] = v;
  }
  return Object.freeze(limits);
}
export class ExecutionBudget {
  constructor(limits = {}) {
    this.limits = normalizeExecutionBudget(limits);
    this.invocations = 0; // operation total; preserved for legacy consumers
    this.segmentInvocations = 0;
    this.segments = 1;
    this.startedAt = performance.now();
    this.segmentStartedAt = this.startedAt;
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.reportedUsage = 0;
    this.segmentInputTokens = 0;
    this.segmentOutputTokens = 0;
    this.segmentReportedUsage = 0;
  }
  restore(snapshot, { newSegment = false } = {}) {
    if (!snapshot || typeof snapshot !== 'object') return false;
    const calls = integer(snapshot.invocations), elapsed = integer(snapshot.elapsedMs);
    const reported = integer(snapshot.reportedUsage);
    if (calls === null || elapsed === null || reported === null || reported > calls) return false;
    const input = integer(snapshot.inputTokens), output = integer(snapshot.outputTokens);
    if (input === null || output === null) return false;
    const segment = snapshot.version === 2 ? snapshot.segment : null;
    const segCalls = segment ? integer(segment.invocations) : calls;
    const segElapsed = segment ? integer(segment.elapsedMs) : elapsed;
    const segReported = segment ? integer(segment.reportedUsage) : reported;
    const segInput = segment ? integer(segment.inputTokens) : input;
    const segOutput = segment ? integer(segment.outputTokens) : output;
    const segments = snapshot.version === 2 ? integer(snapshot.segments) : 1;
    if ([segCalls,segElapsed,segReported,segInput,segOutput,segments].some(x=>x===null) ||
        !segments || segCalls>calls || segElapsed>elapsed+1 || segReported>segCalls || segInput>input || segOutput>output) return false;
    const now = performance.now();
    this.invocations = calls; this.reportedUsage = reported;
    this.inputTokens = input; this.outputTokens = output;
    this.startedAt = now - elapsed; // excludes time spent between explicit resumes
    this.segments = segments + (newSegment ? 1 : 0);
    this.segmentInvocations = newSegment ? 0 : segCalls;
    this.segmentReportedUsage = newSegment ? 0 : segReported;
    this.segmentInputTokens = newSegment ? 0 : segInput;
    this.segmentOutputTokens = newSegment ? 0 : segOutput;
    this.segmentStartedAt = now - (newSegment ? 0 : segElapsed);
    return true;
  }
  snapshot() {
    return { version:2, invocations:this.invocations, reportedUsage:this.reportedUsage,
      inputTokens:this.inputTokens, outputTokens:this.outputTokens,
      elapsedMs:Math.max(0,Math.round(performance.now()-this.startedAt)), segments:this.segments,
      segment:{invocations:this.segmentInvocations, reportedUsage:this.segmentReportedUsage,
        inputTokens:this.segmentInputTokens,outputTokens:this.segmentOutputTokens,
        elapsedMs:Math.max(0,Math.round(performance.now()-this.segmentStartedAt))} };
  }
  observe() { this.invocations++; this.segmentInvocations++; }
  observeUsage(usage) {
    const input = integer(usage?.inputTokens), output = integer(usage?.outputTokens);
    if (input === null || output === null || !Number.isSafeInteger(this.inputTokens+input) ||
        !Number.isSafeInteger(this.outputTokens+output)) return;
    this.reportedUsage++; this.segmentReportedUsage++;
    this.inputTokens += input; this.outputTokens += output;
    this.segmentInputTokens += input; this.segmentOutputTokens += output;
  }
  disposition() {
    const elapsedMs = performance.now()-this.segmentStartedAt;
    const operationElapsedMs = performance.now()-this.startedAt;
    const reasons = [];
    if (this.limits.maxInvocations !== null && this.segmentInvocations >= this.limits.maxInvocations) reasons.push('invocations');
    if (this.limits.maxElapsedMs !== null && elapsedMs >= this.limits.maxElapsedMs) reasons.push('elapsed');
    const accounting = !this.reportedUsage ? 'unavailable' : this.reportedUsage === this.invocations ? 'provider_reported' : 'partial';
    const segmentAccounting = !this.segmentReportedUsage ? 'unavailable' :
      this.segmentReportedUsage === this.segmentInvocations ? 'provider_reported' : 'partial';
    if (segmentAccounting === 'provider_reported') {
      if (this.limits.maxInputTokens !== null && this.segmentInputTokens >= this.limits.maxInputTokens) reasons.push('input_tokens');
      if (this.limits.maxOutputTokens !== null && this.segmentOutputTokens >= this.limits.maxOutputTokens) reasons.push('output_tokens');
    }
    const operationReasons=[];
    for (const [key,reason] of Object.entries(HARD)) {
      const limit=this.limits[key];
      if (limit===null) continue;
      const current=key==='maxOperationInvocations'?this.invocations:key==='maxOperationElapsedMs'?operationElapsedMs:
        key==='maxOperationInputTokens'?this.inputTokens:this.outputTokens;
      if (['maxOperationInputTokens','maxOperationOutputTokens'].includes(key) && accounting!=='provider_reported' && this.invocations) {
        operationReasons.push('usage_unavailable');
      } else if (current>=limit) operationReasons.push(reason);
    }
    return { exhausted: reasons.length>0 || operationReasons.length>0, reasons:[...new Set([...operationReasons,...reasons])],
      segmentExhausted:reasons.length>0, operationExhausted:operationReasons.length>0,
      operationReasons:[...new Set(operationReasons)],invocations:this.segmentInvocations,
      operationInvocations:this.invocations, segments:this.segments,
      elapsedMs:Math.round(elapsedMs),operationElapsedMs:Math.round(operationElapsedMs),tokenAccounting:accounting,
      inputTokens:accounting==='provider_reported'?this.inputTokens:null,
      outputTokens:accounting==='provider_reported'?this.outputTokens:null };
  }
}
