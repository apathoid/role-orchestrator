import { Console } from 'node:console';
import { resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import { ndJsonStream } from '@agentclientprotocol/sdk';
import { createAcpRelay } from '../hosts/acp-relay.js';
import { serveAcp } from '../hosts/acp.js';
import { hostError } from '../hosts/commands.js';
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
    host = serveAcp(runtime.api, runtime.directory,
      ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin), { maxMessageBytes: 1024 * 1024 }));
    const { connection } = host;
    let interrupted = false;
    const interrupt = () => { interrupted = true; connection.close(); };
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', interrupt);
    try { await connection.closed; }
    finally {
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', interrupt);
      if (!interrupted) await host.drain();
      try { await runtime.close(); } finally { await host.drain(); }
    }
    return 0;
  } catch (error) {
    const issue = hostError(error);
    process.stderr.write(issue.code + ': ' + issue.message + '\n');
    return 1;
  }
}
