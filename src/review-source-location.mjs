// Source coordinates are data. Only the presentation boundary generates links;
// no source URL is trusted from a model, and no editor-specific API enters core.
import { realpath, stat } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const maxLine=10_000_000;
const validLine = v => Number.isSafeInteger(v) && v >= 1 && v <= maxLine;
const inside = (root, path) => {const r=relative(root,path);return r==='' || (r!=='..' && !r.startsWith(`..${sep}`) && !isAbsolute(r));};
const escapeLabel = str => String(str).replace(/[\\\[\]<>\r\n]/g, '_').slice(0,180);

/** Resolve one location inside the repository; gracefully fall back to plain text. */
export async function resolveReviewSourceLocation(issue, repoRoot, {sourceKind='worktree'}={}) {
  const source = typeof issue?.path==='string' ? issue.path : null;
  if (!source || source.length>2048 || /[\r\n\0]/.test(source) || !repoRoot || isAbsolute(source)) return null;
  const explicit=issue?.startLine;
  const legacy=typeof issue.message==='string' ? issue.message.match(/^(?:строк(?:а|и|е|у)|lines?)\s+(\d+)(?:\s*[-–]\s*(\d+))?\s*:/iu) : null;
  const line=validLine(explicit) ? explicit : legacy && validLine(Number(legacy[1])) ? Number(legacy[1]) : null;
  const end=validLine(issue.endLine) && line && issue.endLine>=line ? issue.endLine :
    legacy && line && validLine(Number(legacy[2])) && Number(legacy[2])>=line ? Number(legacy[2]) : null;
  const location={path:source,startLine:line,endLine:end,sourceKind};
  // Historical commit coordinates cannot be assumed to match a live worktree.
  if (sourceKind!=='worktree' || issue?.sourceRevision) return {...location,label:escapeLabel(`${source}${line?`:${line}`:''}`),url:null};
  try {
    const root=await realpath(repoRoot), candidate=resolve(root,source);
    if (!inside(root,candidate)) return {...location,label:escapeLabel(source),url:null};
    const target=await realpath(candidate); // rejects dangling and escaping symlinks
    if (!inside(root,target) || !(await stat(target)).isFile()) return {...location,label:escapeLabel(source),url:null};
    const url=pathToFileURL(target);if(line)url.hash=`L${line}`;
    return {...location,label:escapeLabel(`${source}${line?`:${line}${end&&end!==line?`–${end}`:''}`:''}`),
      url:url.href.replaceAll('(','%28').replaceAll(')','%29')};
  } catch {return {...location,label:escapeLabel(source),url:null};}
}
export function formatReviewSourceLocation(location) {
  if (!location) return '';
  // URI encoding is owned by URL; Markdown label cannot control the target.
  return location.url ? `[${location.label}](${location.url})` : `\`${location.label.replaceAll('`','_')}\``;
}
export async function resolveReviewFindingLocations(ledger,repoRoot,options={}) {
  const results=new Map();
  for (const row of ledger ?? []) results.set(row.findingId,await resolveReviewSourceLocation(row.issue,repoRoot,options));
  return results;
}
