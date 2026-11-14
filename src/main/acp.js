import { Console } from 'node:console';
import { resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import { ndJsonStream } from '@agentclientprotocol/sdk';
import { createAcpRelay } from '../hosts/acp-relay.js';
import { serveAcp } from '../hosts/acp.js';
import { dispatchCommand, hostError, HostError } from '../hosts/commands.js';
import { openControl } from '../hosts/local-control.js';
import { cliConfiguration } from './cli-config.js';
import { openRuntime } from './runtime.js';

/** @param {string[]} args */
export async function runAcpStdio(args) {
  try {
    const { values } = parseArgs({ args, options: { config: { type: 'string' }, help: { type: 'boolean' }, 'relay-client-tools': { type: 'boolean' } } });
    if (values.help) {
      process.stdout.write('Usage: role-orchestrator acp [--config FILE] [--relay-client-tools]\n');
      return 0;
    }
    // In this executable mode stdout is reserved for protocol frames.
    globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });
    const options = await cliConfiguration(values.config && resolve(values.config));
    /** @type {ReturnType<typeof serveAcp> | undefined} */
    let host;
    const relay = createAcpRelay(id => host?.route(id));
    const runtime = await openRuntime({
      ...options, permissions: { handleRequest: relay.handleRequest },
      acp: values['relay-client-tools'] ? relay : undefined,
    });
    /** @type {Awaited<ReturnType<typeof openControl>> | undefined} */
    let owner;
    /** @type {Promise<void> | undefined} */
    let stopping;
    function shutdown() {
      return stopping ??= (async () => {
        try { await owner?.close(); } finally { await runtime.close(); }
      })();
    }
    try {
      owner = await openControl(runtime.directory, runtime.configurationRef, command => {
        if (command.action === 'run' || command.action === 'resume') {
          throw new HostError('CONTROL_ACP_SESSION_REQUIRED', 'Use the owning ACP session to submit or continue work');
        }
        return dispatchCommand(runtime.api, command);
      }).catch(error => {
        if (!['EPERM', 'EAFNOSUPPORT', 'ENOSYS'].includes(error?.code)) throw error;
        return undefined;
      });
      host = serveAcp(runtime.api, runtime.directory,
        ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin), { maxMessageBytes: 1024 * 1024 }));
      const { connection } = host;
      const interrupt = () => {
        connection.close();
        void shutdown().catch(() => {});
      };
      process.once('SIGINT', interrupt);
      process.once('SIGTERM', interrupt);
      try {
        await connection.closed;
        await host.drain();
      } finally {
        process.removeListener('SIGINT', interrupt);
        process.removeListener('SIGTERM', interrupt);
      }
    } finally { await shutdown(); }
    return 0;
  } catch (error) {
    const issue = hostError(error);
    process.stderr.write(issue.code + ': ' + issue.message + '\n');
    return 1;
  }
}
