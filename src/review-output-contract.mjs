// Deterministic Markdown layout: the model does not own the authoritative
// findings list. A skill can select a safe title, rearrange the known sections,
// and request additional *source-backed* sections. None of these operations
// changes the required report content or accepts generated findings.
const DEFAULT = Object.freeze(['Краткое резюме','Что хорошо','Замечания и проблемы','Рекомендации улучшений']);

export function reviewOutputHeadings(skill) {
  const body=typeof skill?.body==='string'?skill.body:'';
  // Only an unambiguous full set of the supported headings may alter order.
  // Other skill contracts continue to receive the complete safe default.
  const lines=[...body.matchAll(/^###\s+(.+?)\s*$/gm)].map(match=>match[1].trim());
  const identified=lines.filter(line=>DEFAULT.includes(line));
  return new Set(identified).size===DEFAULT.length ? [...new Set(identified)] : [...DEFAULT];
}

function safeTitle(body) {
  // Only an explicit title directive, not a documentation heading in SKILL.md,
  // may become the report title. Bound and normalize the literal text so that
  // it cannot inject Markdown sections or executable markup into the report.
  const candidate=body.match(/\buse\s+(?:the\s+)?(?:heading|title)\s+["“'«]([^"”'»\r\n]{1,100})["”'»]/iu)?.[1]?.trim();
  if (!candidate || /[<>`#\[\]{}\\]/u.test(candidate)) return null;
  return candidate;
}

function requestsSection(body, heading) {
  if (!body || !/^[\p{L}\d][\p{L}\d _-]{0,79}$/u.test(heading)) return false;
  const escaped=heading.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  // Supports 'an "Evidence" section' and an explicit Markdown section heading.
  // Arbitrary prose in the skill cannot introduce an unbacked report section.
  return new RegExp(`(?:\\b(?:an?|the)\\s+)?["“'«]?${escaped}["”'»]?\\s+section\\b|^#{2,3}\\s+${escaped}\\s*$`,'imu').test(body);
}

export function renderReviewSections(sections, {skill=null,supplementarySections={}}={}) {
  if (!sections || DEFAULT.some(key=>typeof sections[key]!=='string')) throw new Error('Incomplete review sections');
  const body=typeof skill?.body==='string'?skill.body:'';
  const title=safeTitle(body);
  const rendered=reviewOutputHeadings(skill).map(heading=>`### ${heading}\n\n${sections[heading]}`);
  for (const [heading,content] of Object.entries(supplementarySections)) {
    if (!DEFAULT.includes(heading) && typeof content==='string' && requestsSection(body,heading))
      rendered.push(`### ${heading}\n\n${content}`);
  }
  return [title?`# ${title}`:null,...rendered].filter(Boolean).join('\n\n');
}
