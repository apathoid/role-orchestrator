// Filesystem boundary for denied-path snapshots and restoration.
// On Linux, every parent is opened relative to an already pinned directory
// descriptor with O_DIRECTORY | O_NOFOLLOW. Mutations use /proc/self/fd/<fd>/
// so renaming or replacing an ancestor cannot redirect a write outside the
// opened repository tree. Do not fall back to check-then-use pathname writes.
import { constants } from 'node:fs';
import { open, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

export async function withWorkspaceEntry(repoRoot, relativePath, { createParents = false } = {}, fn) {
  if (process.platform !== 'linux') {
    throw Object.assign(new Error('Safe denied-path filesystem operations require Linux directory-fd support.'), { code: 'UNSUPPORTED_SAFE_FS_BOUNDARY' });
  }
  const components = relativePath.split('/');
  if (!components.length || components.some(part => !part || part === '.' || part === '..' || part.includes('\\') || part.includes('\0'))) {
    throw new Error(`Unsafe workspace-relative path: ${relativePath}`);
  }
  const handles = [];
  try {
    let handle = await open(resolve(repoRoot), DIRECTORY_FLAGS);
    handles.push(handle);
    for (const component of components.slice(0, -1)) {
      const next = `/proc/self/fd/${handle.fd}/${component}`;
      if (createParents) {
        try { await mkdir(next, { mode: 0o700 }); }
        catch (error) { if (error?.code !== 'EEXIST') throw error; }
      }
      // A symlink, including a dangling link, must never be traversed.
      handle = await open(next, DIRECTORY_FLAGS);
      handles.push(handle);
    }
    return await fn(`/proc/self/fd/${handle.fd}/${components.at(-1)}`);
  } finally {
    for (const handle of handles.reverse()) await handle.close();
  }
}
