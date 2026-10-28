// Shared test-only fixture for the scoped Review Work Plan contract. Keep the
// fake ACP and fake CLI providers aligned with the production batch prompt.
// A missing/malformed assignment must not silently turn into fake evidence.
export function fakeReviewCoverage(prompt) {
  const current = prompt.match(/REVIEW WORK BATCH \d+ \(limit \d+ batches per run\)\. Assigned UNITS:\n([\s\S]*?)\n\n(?:REVIEW RISK OBLIGATIONS|RISK-ONLY FOLLOW-UP|Return scopedReview)/);
  if (current) {
    const assignment = current[1];
    const units = [...assignment.matchAll(/^(F\d+|C[SA]\d+): /gm)];
    const coverage = units.map((match, index) => {
      const block = assignment.slice(match.index, units[index + 1]?.index ?? assignment.length);
      const pathsLine = block.match(/^  requiredPaths=(\[[^\n]*\])$/m);
      if (!pathsLine) throw new Error(`Fixture: missing requiredPaths for ${match[1]}`);
      const paths = JSON.parse(pathsLine[1]);
      if (!Array.isArray(paths) || paths.some(path => typeof path !== 'string'))
        throw new Error(`Fixture: invalid requiredPaths for ${match[1]}`);
      return {
        id: match[1], status: 'checked',
        evidence: 'Fixture review checked the assigned unit against its source scope and acceptance contract.',
        reviewedPaths: paths,
        fileEvidence: paths.map(path => ({
          path, evidence: `Fixture examined ${path} and its behavior against the scoped changes.`,
        })),
      };
    });
    const uniquePaths = new Set(coverage.flatMap(row => row.reviewedPaths));
    return {
      coverage,
      inventory: { changedFiles: uniquePaths.size, reviewedFiles: uniquePaths.size,
        source: 'fake scoped review assignment (test fixture)' },
    };
  }
  // Backward compatibility for old checklist fixtures, without bypassing the
  // newer file-group evidence requirement.
  const old = prompt.match(/CHECKLIST BATCH \d+\/\d+ \(fixed, no implicit retries\):\n([\s\S]*?)\n\nReturn scopedReview/);
  if (!old) return null;
  const ids = [...old[1].matchAll(/^([SA]\d+): /gm)].map(match => match[1]);
  return {
    coverage: ids.map(id => ({ id, status: 'checked',
      evidence: 'Fixture checked the assigned checklist criterion against source evidence.',
      reviewedPaths: [], fileEvidence: [] })),
    inventory: { changedFiles: 1, reviewedFiles: 1, source: 'fake checklist fixture' },
  };
}
