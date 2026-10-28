import assert from 'node:assert/strict';
import { renderReviewSections } from '../src/review-output-contract.mjs';

const sections = {
  'Краткое резюме': 'Verified scope summary',
  'Что хорошо': 'No independent positive evidence',
  'Замечания и проблемы': 'RF-1111111111111111: one confirmed structured finding',
  'Рекомендации улучшений': 'Address the reported finding',
};
const supplementarySections = { Evidence: '2 of 2 checked Review Units; workflow checks not run' };
const skill = { body: '# Output format\n\nUse the heading "Skill review format" and an "Evidence" section.' };
const report = renderReviewSections(sections, {skill,supplementarySections});
assert.match(report, /^# Skill review format$/m);
assert.match(report, /^### Evidence\n\n2 of 2 checked Review Units;/m);
for (const heading of Object.keys(sections)) {
  assert.equal(report.split(`### ${heading}\n`).length - 1, 1, `${heading}: rendered exactly once`);
  assert(report.includes(sections[heading]));
}
assert.equal((report.match(/RF-1111111111111111/g)??[]).length,1,'no duplicate finding ledger');
const defaultReport = renderReviewSections(sections,{supplementarySections});
assert(!defaultReport.includes('Skill review format'));
assert(!defaultReport.includes('### Evidence'));
const unsafeTitle = renderReviewSections(sections,{
  skill:{body:'Use the heading "<script>alert(1)</script>" and an "Evidence" section.'},supplementarySections,
});
assert(!unsafeTitle.includes('<script>'));
assert.match(unsafeTitle,/^### Evidence$/m);
const unsupported = renderReviewSections(sections,{
  skill:{body:'Use a "Unverified tests" section and an "Evidence" section.'},supplementarySections,
});
assert(!unsupported.includes('### Unverified tests'));
assert.match(unsupported,/^### Evidence$/m);
const markdownSkill = renderReviewSections(sections,{
  skill:{body:'## Evidence'},supplementarySections,
});
assert.match(markdownSkill,/^### Evidence$/m);
console.log('review-output-skill: PASS');
