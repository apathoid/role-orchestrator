#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, isAbsolute, resolve } from 'node:path';
import { cliPermissions } from '../hosts/cli-permissions.js';
import { callControl, openControl, readDescriptor } from '../hosts/local-control.js';
import { runCli } from '../hosts/cli.js';
import { dispatchCommand, hostError, HostError } from '../hosts/commands.js';
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
      // diagnose is a static inspection: neither provider sessions nor probes
      // are started, and missing state directories remain untouched.
      return {
        configuration: path, stateDirectory, state,
        runtime: { node: process.version, platform: process.platform, architecture: process.arch },
        capabilities: { status: 'unknown', reason: 'not_negotiated_without_provider_session' },
        providers, sideEffects: 'none',
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
