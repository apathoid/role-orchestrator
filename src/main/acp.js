import { Console } from 'node:console';
import { Readable, Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import { ndJsonStream } from '@agentclientprotocol/sdk';
import { createAcpRelay } from '../hosts/acp-relay.js';
import { serveAcp } from '../hosts/acp.js';
import { dispatchCommand, hostError, HostError } from '../hosts/commands.js';
import { openControl } from '../hosts/local-control.js';
import { cliConfiguration, executionControlRef } from './cli-config.js';
import { controlStreams } from '../hosts/control-streams.js';
import { userContentFrameBytes, maximumUserContentMaxBytes } from '../application/user-content.js';
import { renderOrderedTurn } from '../adapters/acp/input.js';
import { openRuntime } from './runtime.js';

/** @param {string[]} args */
export async function runAcpStdio(args) {
  try {
    const { values } = parseArgs({ args, options: { config: { type: 'string' }, 'state-dir': { type: 'string' }, help: { type: 'boolean' }, presentation: { type: 'string' }, 'progress-display': { type: 'string' }, 'relay-client-tools': { type: 'boolean' }, 'relay-client-extension': { type: 'string', multiple: true } } });
    if (values.help) {
      process.stdout.write('Usage: role-orchestrator acp [--config FILE] [--state-dir DIR] [--relay-client-tools] [--relay-client-extension METHOD] [--presentation compact|detailed|debug] [--progress-display inline|notices]\n');
      return 0;
    }
    const mode = values.presentation ?? 'compact';
    if (mode !== 'compact' && mode !== 'detailed' && mode !== 'debug') throw new HostError('INVALID_ARGUMENT','Expected --presentation compact, detailed or debug');
    const progressDisplay=values['progress-display']??'inline';
    if(progressDisplay!=='inline'&&progressDisplay!=='notices')throw new HostError('INVALID_ARGUMENT','Expected --progress-display inline or notices');
    // In this executable mode stdout is reserved for protocol frames.
    globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });
    const options = await cliConfiguration(values.config, values['state-dir']);
    /** @type {ReturnType<typeof serveAcp> | undefined} */
    let host;
    const relay = createAcpRelay(id => host?.route(id), values['relay-client-extension']);
    const runtime = await openRuntime({
      ...options, permissions: { handleRequest: relay.handleRequest },
      interactions: { available: relay.supportsInput, handleRequest: relay.handleInteraction },
      acp: {
        ...(values['relay-client-tools'] && { bridge: relay.bridge, bridgeCapabilities: relay.bridgeCapabilities }),
        ...(values['relay-client-extension']?.length && { extensionRelay: relay.extensionRelay }),
      },
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
      owner = await openControl(runtime.directory, executionControlRef(options.configuration, options.configurationDirectory), command => {
        if (command.action === 'run' || command.action === 'resume') {
          throw new HostError('CONTROL_ACP_SESSION_REQUIRED', 'Use the owning ACP session to submit or continue work');
        }
        return dispatchCommand(runtime.api, command);
      }, undefined, controlStreams(() => runtime.api)).catch(error => {
        if (!['EPERM', 'EAFNOSUPPORT', 'ENOSYS'].includes(error?.code)) throw error;
        return undefined;
      });
      // A frame must reach request identity/admission before the current
      // decoded input limit can apply. Retain the former highest supported
      // receive ceiling independently of the configured admission budget.
      // This is a finite wire limit, not a universal JSON expansion bound.
      host = serveAcp(runtime.api, runtime.directory,
        ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin), { maxMessageBytes: userContentFrameBytes(maximumUserContentMaxBytes) }), mode, progressDisplay,
        (operationId,turn,signal,onOmitted)=>renderOrderedTurn(turn,ref=>runtime.api.readUserPayload(operationId,ref),undefined,signal,onOmitted),await runtime.api.inputCapabilities());
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
