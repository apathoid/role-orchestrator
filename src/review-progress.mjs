// Guard against repeated structurally useless reviewer batches. Zero evidence
// alone is not enough: require consecutive batches with the SAME failure class.
export class ReviewNoProgressGuard {
  constructor({ threshold = 2 } = {}) { this.threshold = threshold; this.reason = null; this.count = 0; }
  observe({ assigned, verified, problems = [], outputFormat }) {
    if (!assigned || verified > 0) { this.reason = null; this.count = 0; return { blocked: false }; }
    let reason = null;
    if (outputFormat !== 'structured') reason = 'UNSTRUCTURED_REVIEW_OUTPUT';
    else if (problems.length >= assigned && problems.every((p) => /missing_unit_result$/.test(p))) reason = 'MISSING_REVIEW_UNIT_RESULTS';
    else if (problems.length >= assigned && problems.every((p) => /missing_evidence_or_unchecked$/.test(p))) reason = 'REPEATED_MISSING_EVIDENCE';
    else if (problems.length >= assigned && problems.every((p) => /reviewed_paths_not_verified$/.test(p))) reason = 'REPEATED_INVALID_FILE_EVIDENCE';
    if (!reason) { this.reason = null; this.count = 0; return { blocked: false }; }
    this.count = this.reason === reason ? this.count + 1 : 1;
    this.reason = reason;
    return { blocked: this.count >= this.threshold, reason, consecutiveBatches: this.count };
  }
}
