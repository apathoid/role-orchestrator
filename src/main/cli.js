#!/usr/bin/env node
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { decodeConfiguration } from '../application/configuration/decode-config.js';
import { cliPermissions } from '../hosts/cli-permissions.js';
import { runCli } from '../hosts/cli.js';
import { dispatchCommand, HostError } from '../hosts/commands.js';
import { openRuntime } from './runtime.js';

const cwd = process.cwd();
const defaultConfig = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'role-orchestrator', 'config.json');
const defaultState = join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'role-orchestrator');

/** @param {string} command @param {string} workdir */
async function executable(command, workdir) {
  const candidates = isAbsolute(command) || command.includes('/')
    ? [resolve(workdir, command)] : (process.env.PATH ?? '').split(delimiter).map(dir => resolve(workdir, dir, command));
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return true; }
    catch { /* Try the next PATH entry. */ }
  }
  return false;
}

process.exitCode = await runCli(process.argv.slice(2), { cwd, stdin: process.stdin, stdout: process.stdout, stderr: process.stderr },
  async invocation => {
    const path = invocation.config ?? defaultConfig;
    const configuration = await readFile(path, 'utf8').catch(() => {
      throw new HostError('CONFIGURATION_UNAVAILABLE', 'Cannot read configuration at ' + path);
    });
    const parsed = await decodeConfiguration(configuration);
    if (parsed.kind === 'rejected') throw new HostError(parsed.reason.code, parsed.reason.path + ' ' + parsed.reason.constraint);
    const configurationDirectory = dirname(path);
    const stateDirectory = resolve(configurationDirectory, parsed.value.storage?.directory ?? defaultState);
    if (invocation.command.action === 'diagnose') {
      const providers = await Promise.all(Object.entries(parsed.value.providers).map(async ([providerId, provider]) => ({
        providerId, adapter: provider.adapter, launch: provider.launch
          ? (await executable(provider.launch.command, cwd) ? 'executable' : 'unavailable') : 'adapter_default',
      })));
      const state = await access(stateDirectory, constants.R_OK | constants.W_OK).then(() => 'accessible', error =>
        error.code === 'ENOENT' ? 'not_created' : 'unavailable');
      return { configuration: path, stateDirectory, state, providers };
    }
    const stop = new AbortController();
    const interrupt = () => stop.abort();
    process.on('SIGINT', interrupt);
    try {
      const handleRequest = cliPermissions(process.stdin, process.stderr,
        Boolean(process.stdin.isTTY && process.stderr.isTTY && !invocation.stdin), interrupt);
      const runtime = await openRuntime({ configuration, configurationDirectory, stateDirectory,
        permissions: { handleRequest }, project: { cwd: invocation.command.cwd }, launch: invocation.launch });
      try {
        return await dispatchCommand(runtime.api, invocation.command, operationId => {
          const cancel = () => { void runtime.api.cancel(operationId, 'client').catch(() => {}); };
          stop.signal.addEventListener('abort', cancel, { once: true });
          if (stop.signal.aborted) cancel();
        });
      } finally { await runtime.close(); }
    } finally { process.removeListener('SIGINT', interrupt); }
  });
