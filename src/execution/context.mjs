import { createHash } from 'node:crypto';
const digest = v => createHash('sha256').update(v).digest('hex').slice(0,16);
// Metadata-only manifest. Never copies instruction bodies, paths or user text
// into telemetry. The compiler remains observational until equivalent scopes
// have passed evaluation; silent truncation of policy/skill text is forbidden.
export function compileRoleContextManifest({ role, sections = [] } = {}) {
  const seen = new Set();
  let totalCharacters = 0, duplicateCharacters = 0;
  const parts = sections.filter(x => typeof x === 'string' && x).map(section => {
    totalCharacters += section.length;
    const checksum = digest(section);
    if (seen.has(checksum)) duplicateCharacters += section.length;
    seen.add(checksum);
    return { digest:checksum, characters:section.length };
  });
  return { version:1, role, totalCharacters, duplicateCharacters, sectionCount:parts.length,
    sections:parts, completeness:'no_silent_omissions' };
}
