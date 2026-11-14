#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, isAbsolute, resolve } from 'node:path';
import { cliPermissions } from '../hosts/cli-permissions.js';
import { callControl, openControl, readDescriptor } from '../hosts/local-control.js';
import { runCli } from '../hosts/cli.js';
import { dispatchCommand, hostError, HostError } from '../hosts/commands.js';
import { cliConfiguration } from './cli-config.js';
import { openRuntime } from './runtime.js';

const cwd = process.cwd();

/**
 * A static launch-path hint, not a promise that spawn will succeed.
 * Relative commands (including relative PATH entries) may resolve in a
 * different workspace when an actual provider attempt is started.
 * @param {string} command
 * @returns {Promise<'executable' | 'unavailable' | 'cwd_dependent'>}
 */
async function executable(command) {
  if (!isAbsolute(command) && command.includes('/')) return 'cwd_dependent';
  const entries = isAbsolute(command) ? [] : (process.env.PATH ?? '').split(delimiter);
  const candidates = isAbsolute(command) ? [command]
    : entries.filter(dir => isAbsolute(dir)).map(dir => resolve(dir, command));
  for (const candidate of candidates) {
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, constants.X_OK);
      return 'executable';
    } catch { /* Not a currently executable regular file at this location. */ }
  }
  return entries.some(dir => !isAbsolute(dir)) ? 'cwd_dependent' : 'unavailable';
}

/** @param {string} directory */
async function diagnoseState(directory) {
  try {
    if (!(await stat(directory)).isDirectory()) return 'not_directory';
    await access(directory, constants.R_OK | constants.W_OK | constants.X_OK);
    return 'accessible';
  } catch (error) {
    return error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
      ? 'not_created' : 'unavailable';
  }
}

process.exitCode = process.argv[2] === 'acp' ? await (await import('./acp.js')).runAcpStdio(process.argv.slice(3))
  : await runCli(process.argv.slice(2), { cwd, stdin: process.stdin, stdout: process.stdout, stderr: process.stderr },
  async invocation => {
    const { path, configuration, configurationDirectory, stateDirectory, providers: configuredProviders } =
      await cliConfiguration(invocation.config);
    if (invocation.command.action === 'diagnose') {
      const providers = await Promise.all(Object.entries(configuredProviders).map(async ([providerId, provider]) => ({
        providerId, adapter: provider.adapter, launch: provider.launch
          ? await executable(provider.launch.command) : 'adapter_default',
      })));
      const state = await diagnoseState(stateDirectory);
      // diagnose is a static inspection: neither provider sessions nor probes
      // are started, and missing state directories remain untouched.
      return {
        configuration: path, stateDirectory, state,
        runtime: { node: process.version, platform: process.platform, architecture: process.arch },
        capabilities: { status: 'unknown', reason: 'not_negotiated_without_provider_session' },
        providers, sideEffects: 'none',
        launchProbe: 'static_file_type_and_permissions_only',
      };
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
      const startsWork = invocation.command.action === 'run' || invocation.command.action === 'resume';
      const discoveryDeadline = performance.now() + 5_000;
      for (;;) {
        const descriptor = await readDescriptor(stateDirectory);
        if (descriptor) {
          const result = await callControl(descriptor, configurationRef, invocation.command, onAccepted(id =>
            callControl(descriptor, configurationRef, {
              action: 'cancel', operationId: id, requestId: randomUUID(), cancellationSource: 'client',
            })), invocation.launch);
          if (result !== undefined) return result;
        }

        /** @type {Awaited<ReturnType<typeof openControl>> | undefined} */
        let owner;
        /** @type {Awaited<ReturnType<typeof openRuntime>> | undefined} */
        let runtime;
        /** @type {PromiseWithResolvers<Awaited<ReturnType<typeof openRuntime>>>} */
        const readiness = Promise.withResolvers();
        void readiness.promise.catch(() => {});
        try {
          runtime = await openRuntime({ configuration, configurationDirectory, stateDirectory,
            permissions: { handleRequest }, launch: invocation.launch,
          }, startsWork ? async () => {
            const startupDeadline = performance.now() + 30_000;
            owner = await openControl(stateDirectory, configurationRef, async (command, accepted) => {
              if (runtime) return dispatchCommand(runtime.api, command, accepted);
              const timer = new AbortController();
              try {
                const ready = await Promise.race([
                  readiness.promise,
                  delay(Math.max(0, startupDeadline - performance.now()), undefined, { ref: false, signal: timer.signal })
                    .then(() => { throw new HostError('CONTROL_STARTUP_TIMEOUT', 'The live owner has not finished initialization'); }),
                ]);
                return dispatchCommand(ready.api, command, accepted);
              } finally { timer.abort(); }
            }, invocation.launch).catch(error => {
              if (!['EPERM', 'EAFNOSUPPORT', 'ENOSYS'].includes(error?.code)) throw error;
              process.stderr.write('CONTROL_UNAVAILABLE: local socket transport unavailable; this process retains writer ownership\n');
              return undefined;
            });
          } : undefined);
          readiness.resolve(runtime);
          if (invocation.command.action === 'cancel') {
            return { operationId: invocation.command.operationId, status: 'no_live_execution' };
          }
          const api = runtime.api;
          return await dispatchCommand(api, invocation.command, onAccepted(id => api.cancel(id, 'client')));
        } catch (error) {
          readiness.reject(error);
          if (runtime || hostError(error).code !== 'STATE_STORE_IN_USE') throw error;
          if (stop.signal.aborted) throw new HostError('CANCELLED', 'Interrupted while waiting for the local owner');
          if (performance.now() >= discoveryDeadline) {
            throw new HostError('STATE_STORE_IN_USE', 'State store has a writer without a reachable CLI control endpoint');
          }
        } finally {
          try { await owner?.close(); } finally { await runtime?.close(); }
        }
        await delay(25);
      }
    } finally { process.removeListener('SIGINT', interrupt); }
  });
