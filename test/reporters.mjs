import assert from 'node:assert/strict';
import { createCliReporter, formatResultMarkdown } from '../src/reporters.mjs';

const nativeResponse = formatResultMarkdown({
  status: 'review_findings',
  responseText: '# Review\n\nCustom model-chosen presentation.\n\n```diff\n- old\n+ new\n```',
  review: {
    verdict: 'fix',
    summary: 'Machine summary.',
    issues: [{ severity: 'major', path: 'src/a.ts', message: 'Issue.', suggestedFix: 'Fix it.' }],
  },
  finalValidation: null,
  reviewTarget: null,
});
assert.match(nativeResponse, /^# Review/m);
assert.match(nativeResponse, /```diff/);
assert.doesNotMatch(nativeResponse, /## Review result:/);

const defaultRendered = formatResultMarkdown({
  status: 'review_findings',
  activeSkill: null,
  review: {
    verdict: 'fix',
    summary: 'Machine summary.',
    issues: [{ severity: 'major', path: 'src/a.ts', message: 'Issue.', suggestedFix: 'Fix it.' }],
  },
  finalValidation: null,
  reviewTarget: null,
});
assert.match(defaultRendered, /^## Review result: findings reported/m);
assert.match(defaultRendered, /### Findings/);

const incompleteRendered = formatResultMarkdown({
  status: 'review_incomplete',
  review: { verdict: 'pass', summary: 'No defects among inspected files.', issues: [] },
  reviewCoverage: { checked: 1, total: 2, gaps: ['S2: unreviewed critical scenario'] },
});
assert.match(incompleteRendered, /Coverage incomplete/);
assert.match(incompleteRendered, /unreviewed critical scenario/);
assert.match(incompleteRendered, /No production-readiness claim/);

const investigatedText = formatResultMarkdown({
  status: 'investigated',
  exploration: { format: 'text', text: 'Explorer text.' },
  investigation: { format: 'text', text: 'Direct investigation answer.\n\n```ts\nconst x = 1;\n```' },
});
assert.match(investigatedText, /Direct investigation answer/);
assert.match(investigatedText, /```ts/);
assert.doesNotMatch(investigatedText, /Explorer text/);
assert.doesNotMatch(investigatedText, /Investigation result/);

const unresolved = formatResultMarkdown({
  status: 'completed_with_unresolved_review',
  review: { verdict: 'unknown', summary: 'Reviewer prose.', issues: [] },
  finalValidation: { verdict: 'unknown', summary: 'Validator prose.', issues: [] },
  verification: [],
  verificationDisposition: 'PASS',
});
assert.match(unresolved, /review decision unresolved/);
assert.match(unresolved, /Reviewer prose/);
assert.match(unresolved, /Validator prose/);

const fallbackWithGitDrift = formatResultMarkdown({
  status: 'applied',
  gitMetadataDrift: [{ stage: 'verification', command: 'git add greeting.txt', fields: ['index'] }],
  verification: [{ status: 'PASS' }],
  verificationDisposition: 'PASS',
});
assert.match(fallbackWithGitDrift, /Git metadata changed/);
assert.match(fallbackWithGitDrift, /source was not determined/);

let output = '';
await createCliReporter({ stream: { write: (chunk) => { output += chunk; } } })({
  type: 'git_metadata_drift', stage: 'verification', command: 'npm test', fields: ['HEAD', 'refs'],
  refs: { added: ['refs/heads/test'], removed: [], updated: [] },
});
assert.match(output, /Git metadata drift observed during verification after npm test/);
assert.match(output, /attribution unknown/);

output = '';
await createCliReporter({ stream: { write: (chunk) => { output += chunk; } } })({
  type: 'role_cancelled', role: 'reviewerMedium', message: '[SESSION_CANCELLED] The client cancelled the session.', elapsedMs: 1200,
});
assert.match(output, /reviewerMedium/);
assert.match(output, /SESSION_CANCELLED/);

console.log('reporters: passed');
