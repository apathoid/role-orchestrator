// Canonical, conservative repository-relative paths for task-scope authorization
// and post-write auditing. This is validation, not filesystem confinement.
export function canonicalTaskPath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 240 &&
    !value.startsWith('/') && !value.includes('\\') &&
    !/[\x00-\x1f\x7f]/.test(value) &&
    /^[\p{L}\p{N}_.+@/-]+$/u.test(value) &&
    value.split('/').every(part => part !== '' && part !== '.' &&
      part !== '..' && part.toLowerCase() !== '.git' &&
      !part.endsWith('.') &&
      !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part));
}
