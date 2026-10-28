// Shared, host-independent boundaries for instruction/configuration reads.
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export function isWithin(root, candidate) {
  const subpath = relative(root, candidate);
  return subpath === '' || (subpath !== '..' && !subpath.startsWith(`..${sep}`) && !isAbsolute(subpath));
}

export async function readScopedText(file, root, { maxChars = 80_000 } = {}) {
  const resolvedRoot = resolve(root);
  const target = resolve(file);
  if (!isWithin(resolvedRoot, target)) throw new Error(`Instruction/config path escapes its permitted scope: ${file}`);
  let actualRoot, actualFile;
  try {
    [actualRoot, actualFile] = await Promise.all([realpath(resolvedRoot), realpath(target)]);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (!isWithin(actualRoot, actualFile)) throw new Error(`Instruction/config symlink escapes its permitted scope: ${file}`);
  const meta = await stat(target);
  if (!meta.isFile()) throw new Error(`Expected a regular file: ${file}`);
  if (meta.size > maxChars * 4) throw new Error(`Instruction/config file is too large: ${file}`);
  const value = await readFile(target, 'utf8');
  if (value.length > maxChars) throw new Error(`Instruction/config file exceeds the ${maxChars}-character limit: ${file}`);
  return value;
}
