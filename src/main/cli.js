#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, isAbsolute, resolve } from 'node:path';
import { cliPermissions } from '../hosts/cli-permissions.js';
import { callControl, openControl, readDescriptor } from '../hosts/local-control.js';
import { runCli } from '../hosts/cli.js';
import { dispatchCommand, HostError } from '../hosts/commands.js';
import { cliConfiguration } from './cli-config.js';
import { openRuntime } from './runtime.js';

const cwd = process.cwd();

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

process.exitCode = process.argv[2] === 'acp' ? await (await import('./acp.js')).runAcpStdio(process.argv.slice(3))
  : await runCli(process.argv.slice(2), { cwd, stdin: process.stdin, stdout: process.stdout, stderr: process.stderr },
  async invocation => {
    const { path, configuration, configurationDirectory, stateDirectory, providers: configuredProviders } =
      await cliConfiguration(invocation.config);
    if (invocation.command.action === 'diagnose') {
      const providers = await Promise.all(Object.entries(configuredProviders).map(async ([providerId, provider]) => ({
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
      const configurationRef = 'config:' + createHash('sha256').update(configuration).digest('hex');
      /** @param {(id: string) => Promise<unknown>} cancel */
      const onAccepted = cancel => /** @param {string} id */ id => {
        const cancelForeground = () => { void cancel(id).catch(() => {}); };
        if (stop.signal.aborted) cancelForeground();
        else stop.signal.addEventListener('abort', cancelForeground, { once: true });
      };
      for (let retries = 0; ; retries++) {
        const descriptor = await readDescriptor(stateDirectory);
        if (descriptor) {
          if (Object.keys(invocation.launch).length) {
            throw new HostError('CONTROL_LAUNCH_UNAVAILABLE', 'Launch overrides require a new live owner');
          }
          const result = await callControl(descriptor, configurationRef, invocation.command, onAccepted(id =>
            callControl(descriptor, configurationRef, { action: 'cancel', operationId: id, requestId: randomUUID() })));
          if (result !== undefined) return result;
        }

        const runtime = await openRuntime({ configuration, configurationDirectory, stateDirectory,
          permissions: { handleRequest }, project: { cwd: invocation.command.cwd }, launch: invocation.launch })
          .catch(error => {
            if (error?.code === 'STATE_STORE_IN_USE' && retries < 40) return undefined;
            throw error;
          });
        if (!runtime) { await delay(25); continue; }
        try {
          if (invocation.command.action === 'cancel') {
            return { operationId: invocation.command.operationId, status: 'no_live_execution' };
          }
          if (invocation.command.action !== 'run' && invocation.command.action !== 'resume') {
            return await dispatchCommand(runtime.api, invocation.command);
          }
          const owner = await openControl(stateDirectory, configurationRef, (command, accepted) =>
            dispatchCommand(runtime.api, command, accepted)).catch(error => {
            if (!['EPERM', 'EAFNOSUPPORT', 'ENOSYS'].includes(error?.code)) throw error;
            process.stderr.write('CONTROL_UNAVAILABLE: local socket transport unavailable; this process retains writer ownership\n');
            return undefined;
          });
          try {
            return await dispatchCommand(runtime.api, invocation.command, onAccepted(id => runtime.api.cancel(id, 'client')));
          } finally { await owner?.close(); }
        } finally { await runtime.close(); }
      }
    } finally { process.removeListener('SIGINT', interrupt); }
  });
