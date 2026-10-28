// Bounded, read-only static hints for grouping changed source files. These are
// scheduling hints, not verification evidence or a complete language parser.
import { posix } from 'node:path';
import { readScopedText } from './instruction-files.mjs';
import { execFileSafe } from './repo.mjs';

const SOURCE = /\.(?:[cm]?[jt]sx?|css|scss|sass|less)$/i;
const MAX_FILES = 256;
const MAX_CHARS = 64_000;
const EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs', '.cts', '.cjs', '.json', '.css', '.scss', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'];
const SPECIFIERS = [
  /\b(?:import|export)\s+(?:[\s\S]{0,160}?\s+from\s*)?["'](\.{1,2}\/[^"'\s]+)["']/g,
  /\brequire\s*\(\s*["'](\.{1,2}\/[^"'\s]+)["']\s*\)/g,
  /\bimport\s*\(\s*["'](\.{1,2}\/[^"'\s]+)["']\s*\)/g,
  /@import\s+["'](\.{1,2}\/[^"'\s]+)["']/g,
];

function sourceRevision(scope) {
  if (scope.selector === 'worktree' || scope.selector === 'commits-by-key') return null;
  if (scope.selector === 'commit') return scope.revisions?.[0] ?? null;
  return scope.revisions?.[1] ?? null;
}

export async function inspectReviewRelationships(root, scope, { signal } = {}) {
  if (!scope?.available || !Array.isArray(scope.paths)) return [];
  // Without a reliable snapshot, no guessed imports. Scope is already filtered
  // against the active security policy before this function is called.
  const revision = sourceRevision(scope);
  if (scope.selector !== 'worktree' && !revision) return [];
  if (scope.paths.length > MAX_FILES) return [];
  const paths = new Set(scope.paths.map((entry) => entry.path));
  const hints = [];
  for (const entry of scope.paths) {
    if (signal?.aborted) throw signal.reason ?? new Error('Review cancelled');
    if (entry.status === 'D' || !SOURCE.test(entry.path)) continue;
    let content;
    try {
      if (revision) {
        const result = await execFileSafe('git', ['show', `${revision}:${entry.path}`], {
          cwd: root, signal, env: { GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1' },
          timeoutMs: 5000, maxCaptureChars: MAX_CHARS + 1, maxResultChars: MAX_CHARS + 1,
        });
        content = result.stdout;
      } else {
        content = await readScopedText(posix.join(root, entry.path), root, { maxChars: MAX_CHARS });
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      continue; // Missing/binary/oversized: leave relationship unknown.
    }
    if (typeof content !== 'string' || content.length > MAX_CHARS || content.includes('\0')) continue;
    const imports = new Set();
    for (const pattern of SPECIFIERS) {
      pattern.lastIndex = 0;
      for (const match of content.matchAll(pattern)) {
        const base = posix.normalize(posix.join(posix.dirname(entry.path), match[1]));
        if (base === '..' || base.startsWith('../') || base.startsWith('/')) continue;
        const target = EXTENSIONS.map((ext) => `${base}${ext}`).find((candidate) => candidate !== entry.path && paths.has(candidate));
        if (target) imports.add(target);
      }
    }
    for (const target of [...imports].sort()) hints.push({ from: entry.path, to: target, relation: 'import' });
  }
  return hints;
}
