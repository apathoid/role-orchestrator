import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { decodeConfiguration } from '../application/configuration/decode-config.js';
import { HostError } from '../hosts/commands.js';

/** @param {string} [file] */
export function configurationPath(file) {
  return resolve(file ?? join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'role-orchestrator', 'config.json'));
}

/**
 * Resolve logical paths without following configuration symlinks. The explicit
 * override is independent of execution cwd and configuration contents.
 * @param {string} path @param {string} [override] @param {string} [configuredDirectory]
 */
export function cliStoreSelection(path, override, configuredDirectory) {
  if (override !== undefined) {
    if (!override) throw new HostError('INVALID_ARGUMENT', 'Empty --state-dir');
    return { stateDirectory: resolve(override), stateDirectorySource: 'cli_override' };
  }
  if (configuredDirectory !== undefined) {
    return { stateDirectory: resolve(dirname(path), configuredDirectory), stateDirectorySource: 'configuration' };
  }
  const root = resolve(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'role-orchestrator');
  if (path === configurationPath()) return { stateDirectory: root, stateDirectorySource: 'default_configuration' };
  const name = basename(path).replace(/[^A-Za-z0-9._-]/gu, '_').replace(/^\.+/u, '').slice(0, 48) || 'config';
  const identity = createHash('sha256').update(path).digest('hex');
  return { stateDirectory: join(root, 'configurations', name + '-' + identity), stateDirectorySource: 'configuration_path' };
}

/** Host-local compatibility only; never persisted as configurationRef.
 * @param {string} configuration @param {string} configurationDirectory */
export function executionControlRef(configuration, configurationDirectory) {
  return 'execution:' + createHash('sha256').update(JSON.stringify([configuration, resolve(configurationDirectory)])).digest('hex');
}

/** @param {string} [file] @param {string} [override] */
export async function cliConfiguration(file, override) {
  const path = configurationPath(file);
  if (override === '') throw new HostError('INVALID_ARGUMENT', 'Empty --state-dir');
  const configuration = await readFile(path, 'utf8').catch(() => {
    throw new HostError('CONFIGURATION_UNAVAILABLE', 'Cannot read configuration at ' + path);
  });
  const parsed = await decodeConfiguration(configuration);
  if (parsed.kind === 'rejected') throw new HostError(parsed.reason.code, parsed.reason.path + ' ' + parsed.reason.constraint);
  const configurationDirectory = dirname(path);
  return { path, configuration, configurationDirectory, ...cliStoreSelection(path, override, parsed.value.storage?.directory), providers: parsed.value.providers };
}
