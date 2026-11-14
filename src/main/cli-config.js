import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { decodeConfiguration } from '../application/configuration/decode-config.js';
import { HostError } from '../hosts/commands.js';

/** @param {string} [file] */
export async function cliConfiguration(file) {
  const path = file ?? join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'role-orchestrator', 'config.json');
  const configuration = await readFile(path, 'utf8').catch(() => {
    throw new HostError('CONFIGURATION_UNAVAILABLE', 'Cannot read configuration at ' + path);
  });
  const parsed = await decodeConfiguration(configuration);
  if (parsed.kind === 'rejected') throw new HostError(parsed.reason.code, parsed.reason.path + ' ' + parsed.reason.constraint);
  const configurationDirectory = dirname(path);
  const defaultState = join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'role-orchestrator');
  const stateDirectory = resolve(configurationDirectory, parsed.value.storage?.directory ?? defaultState);
  return { path, configuration, configurationDirectory, stateDirectory, providers: parsed.value.providers };
}
