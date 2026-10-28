import { readFile } from 'node:fs/promises';

const packageJsonUrl = new URL('../package.json', import.meta.url);
const packageJson = JSON.parse(await readFile(packageJsonUrl, 'utf8'));

if (typeof packageJson.name !== 'string' || !packageJson.name.trim()) {
  throw new Error('package.json must define a non-empty name.');
}

export const projectName = packageJson.name.trim();
