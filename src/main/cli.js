#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, isAbsolute, resolve } from 'node:path';
import { createCliInput } from '../hosts/cli-input.js';
import { pollAttachedInputs } from '../hosts/attached-input.js';
import { cliOwner } from '../hosts/cli-owner.js';
import { cliPresentation } from '../hosts/cli-presentation.js';
import { callControl, openControl, readDescriptor } from '../hosts/local-control.js';
import { runCli } from '../hosts/cli.js';
import { dispatchCommand, hostError, HostError } from '../hosts/commands.js';
import { cliConfiguration } from './cli-config.js';
import { controlStreams } from '../hosts/control-streams.js';
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
    const interactive = Boolean(process.stdin.isTTY && process.stderr.isTTY && !invocation.stdin);
    const input = createCliInput(process.stdin,process.stderr,interactive,interrupt);
    const clients = cliOwner(input);
    const mode = invocation.presentation ?? (interactive && invocation.format === 'text' && ['run','resume'].includes(invocation.command.action) ? 'compact' : undefined);
    const renderer = cliPresentation(mode,input.print);
    try {
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
          const cancel = onAccepted(id => callControl(descriptor, configurationRef, {
            action: 'cancel', operationId: id, requestId: randomUUID(), cancellationSource: 'client',
          }));
          const watch = new AbortController();
          /** @type {Promise<void> | undefined} */
          let polling;
          /** @param {string} id */
          const inspect = async id => /** @type {import('../core/operation.js').Operation} */ (await callControl(descriptor,configurationRef,{action:'inspect',operationId:id,requestId:randomUUID()},undefined,undefined,{signal:watch.signal}));
          try {
            const result = await callControl(descriptor, configurationRef, invocation.command, (id,key) => {
              cancel(id);
              if (!interactive || !key || polling) return;
              polling = pollAttachedInputs({operationId:id,ownerRequestId:invocation.command.requestId,answerKey:key,
                signal:AbortSignal.any([watch.signal,stop.signal]),ask:input.ask,print:input.print,
                call:(command,signal)=>callControl(descriptor,configurationRef,command,undefined,undefined,{signal})});
            }, invocation.launch, startsWork && (mode || interactive) ? {interactive,notice:mode ? notice=>renderer.notice(notice,inspect) : undefined} : undefined);
            if (result !== undefined) { renderer.finish(result); return result; }
          } finally { watch.abort(); await polling; }
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
            permissions: { handleRequest:clients.handlePermission }, interactions: { available:clients.available,handleRequest:clients.handleInteraction }, launch: invocation.launch,
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
            }, invocation.launch, { ...controlStreams(() => runtime?.api), pending:clients.pending,respond:clients.respond,
              ownerAccepted:(id,requestId,enabled)=>clients.accept(id,requestId,true,enabled),ownerDetached:clients.detach }).catch(error => {
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
          const cancel = onAccepted(id => api.cancel(id, 'client'));
          let detach = () => {};
          try {
            const result = await dispatchCommand(api, invocation.command,id=>{
              cancel(id);
              if (!startsWork) return;
              clients.accept(id,invocation.command.requestId,false,interactive);
              const streams = controlStreams(()=>api);
              const unsubscribe = mode ? streams.subscribe(id,notice=>renderer.notice(notice,api.inspect)) : ()=>{};
              detach = ()=>{unsubscribe();clients.detach(id,invocation.command.requestId);};
            });
            renderer.finish(result);
            return result;
          } finally { detach(); }
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
    } finally { renderer.close(); input.close(); process.removeListener('SIGINT', interrupt); }
  });
