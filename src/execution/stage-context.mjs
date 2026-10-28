// Compacts historical implementation reports without changing stage state,
// authority, or source-of-truth acceptance proofs. Truncation is explicit.
export function compactImplementationHandoff(checkpoint, { maxChars = 4800 } = {}) {
  if (!checkpoint) return '(no previous implementation stages)';
  const summary = {
    completedStages: Array.isArray(checkpoint.completedStages) ? checkpoint.completedStages : [],
    completedStepIds: Array.isArray(checkpoint.records) ? checkpoint.records.map(x => x.id) : [],
    recentReports: (checkpoint.reports ?? []).slice(-3).map((report) => ({
      stageId: report.stageId ?? null, status: report.status ?? null,
      // Do not elevate model-authored stage text into verified evidence.
      provenance: 'model_reported',
      description:typeof report.summary === 'string' ? report.summary.slice(0,220) : null,
    })),
    omittedRecords: (checkpoint.records ?? []).length,
    source: 'durable_implementation_checkpoint',
    instruction: 'Do not repeat completed stages. If details are omitted, inspect current source; do not guess.',
  };
  let text=JSON.stringify(summary);
  if (text.length > maxChars) {
    summary.recentReports=[];
    text=JSON.stringify(summary);
  }
  if (text.length > maxChars) return JSON.stringify({ completedStageCount:summary.completedStages.length,
    completedStepCount:summary.completedStepIds.length, detailOmitted:true,
    source:summary.source, instruction:summary.instruction });
  return text;
}
