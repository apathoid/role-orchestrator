import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { HostError, hostError, newRequestId, operationView } from './commands.js';

/** @import {Command} from './commands.js' */
/** @import {Operation} from '../core/operation.js' */

export const help = `Usage: role-orchestrator COMMAND [OPTIONS]

  run [TEXT]              Submit text or read it from stdin
  resume ID [TEXT]        Recover or continue an operation
  inspect ID              Show status, attempts and budget
  cancel ID               Cancel an operation
  diagnose                Check local configuration and launch paths
  acp                     Serve ACP v1 over stdio
  trace ID                Show redacted operation journal
  export-diagnostics ID   Write a redacted journal to --output PATH

Common: --config FILE, --format text|json, --help
Run: --cwd DIR, --profile ID, --skill ID (repeatable), --stdin, --request-id ID
Resume: --question ID, --stdin, --request-id ID
`;

const common = {
  config: { type: 'string' }, format: { type: 'string' }, help: { type: 'boolean', short: 'h' },
};
const continuation = { stdin: { type: 'boolean' }, 'request-id': { type: 'string' } };
const flags = {
  run: { ...continuation, cwd: { type: 'string' }, profile: { type: 'string' }, skill: { type: 'string', multiple: true } },
  resume: { ...continuation, question: { type: 'string' } },
  inspect: {}, cancel: {}, diagnose: {}, trace: {}, 'export-diagnostics': { output: { type: 'string' } },
};

/** @param {string[]} argv @param {string} cwd */
export function parseCli(argv, cwd) {
  const [action, ...args] = argv;
  if (!action || action === '--help' || action === '-h') return { kind: /** @type {const} */ ('help') };
  if (!Object.hasOwn(flags, action)) throw new HostError('INVALID_ARGUMENT', 'Unknown command: ' + action);
  const commandName = /** @type {Command['action']} */ (action);
  const { values: parsedValues, positionals } = parseArgs({
    args, allowPositionals: true,
    options: /** @type {import('node:util').ParseArgsConfig['options']} */ ({ ...common, ...flags[commandName] }),
  });
  const values = /** @type {Record<string, string | boolean | (string | boolean)[] | undefined>} */ (parsedValues);
  if (values.help) return { kind: /** @type {const} */ ('help') };
  const format = values.format ?? 'text';
  if (format !== 'text' && format !== 'json') throw new HostError('INVALID_ARGUMENT', 'Expected --format text or json');
  const needsId = commandName !== 'run' && commandName !== 'diagnose';
  const operationId = needsId ? positionals.shift() : undefined;
  if (needsId && !operationId?.trim()) throw new HostError('INVALID_ARGUMENT', 'An operation id is required');
  const acceptsText = commandName === 'run' || commandName === 'resume';
  if (positionals.length && (!acceptsText || values.stdin)) throw new HostError('INVALID_ARGUMENT', 'Unexpected positional arguments');
  const output = typeof values.output === 'string' && values.output ? resolve(cwd, values.output) : undefined;
  if (commandName === 'export-diagnostics' && !output) throw new HostError('INVALID_ARGUMENT', '--output is required');
  if (values['request-id'] === '' || values.question === '' || values.cwd === '') {
    throw new HostError('INVALID_ARGUMENT', 'Empty option value');
  }
  /** @type {Command} */
  const command = {
    action: commandName, operationId, requestId: typeof values['request-id'] === 'string' ? values['request-id'] : newRequestId(),
    text: positionals.length ? positionals.join(' ') : undefined,
    cwd: commandName === 'run' ? resolve(cwd, typeof values.cwd === 'string' ? values.cwd : '.') : undefined,
    questionId: typeof values.question === 'string' ? values.question : undefined,
  };
  return {
    kind: /** @type {const} */ ('command'), command, format, output,
    stdin: values.stdin === true || (commandName === 'run' && command.text === undefined),
    config: typeof values.config === 'string' ? resolve(cwd, values.config) : undefined,
    launch: {
      ...(typeof values.profile === 'string' && { controllerProfile: values.profile }),
      ...(Array.isArray(values.skill) && { preferredSkills: /** @type {string[]} */ (values.skill) }),
    },
  };
}

/** @typedef {Extract<ReturnType<typeof parseCli>, {kind: 'command'}>} CliInvocation */

/** @param {NodeJS.ReadableStream} input */
async function readInput(input) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of input) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 1_048_576) throw new HostError('INVALID_ARGUMENT', 'stdin exceeds 1 MiB');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * @param {string[]} args
 * @param {{cwd: string, stdin: NodeJS.ReadableStream, stdout: NodeJS.WritableStream, stderr: NodeJS.WritableStream}} io
 * @param {(invocation: CliInvocation) => Promise<unknown>} execute
 */
export async function runCli(args, io, execute) {
  try {
    const invocation = parseCli(args, io.cwd);
    if (invocation.kind === 'help') {
      io.stdout.write(help);
      return 0;
    }
    if (invocation.stdin) invocation.command.text = await readInput(io.stdin);
    if ((invocation.command.action === 'run' || invocation.command.text !== undefined) && !invocation.command.text?.trim()) {
      throw new HostError('INVALID_ARGUMENT', 'A nonempty request is required');
    }
    const result = await execute(invocation);
    if (invocation.output) {
      await writeFile(invocation.output, JSON.stringify(result, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      io.stdout.write(invocation.format === 'json' ? JSON.stringify({ output: invocation.output }) + '\n' : invocation.output + '\n');
      return 0;
    }
    if (result && typeof result === 'object' && 'attempts' in result) {
      const view = operationView(/** @type {Operation} */ (result));
      if (invocation.format === 'text' && ['run', 'resume'].includes(invocation.command.action)) {
        io.stdout.write((view.assessment?.answer ?? (view.waiting?.kind === 'question' ? view.waiting.question
          : view.waiting?.kind === 'technical' ? 'Waiting: ' + view.waiting.reason.code : view.status)) + '\n');
      } else io.stdout.write(JSON.stringify(view, null, invocation.format === 'text' ? 2 : undefined) + '\n');
    } else io.stdout.write(JSON.stringify(result, null, invocation.format === 'text' ? 2 : undefined) + '\n');
    return 0;
  } catch (error) {
    const issue = hostError(error);
    io.stderr.write(issue.code + ': ' + issue.message + (issue.path ? ' (' + issue.path + ')' : '') + '\n');
    return issue.code === 'INVALID_ARGUMENT' || issue.code.startsWith('ERR_PARSE_ARGS') ? 2 : 1;
  }
}
