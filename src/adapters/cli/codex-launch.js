import { launchEnvironment } from '../launch-environment.js';

/** @import {ProviderConfig} from '../../application/configuration/decode-config.js' */

/**
 * Prepare one headless Codex invocation from decoded trusted provider settings.
 * Only stdin contains the rendered prompt. The process owner consumes command,
 * args and options with spawn, writes stdin as UTF-8 and closes the pipe.
 *
 * @param {ProviderConfig} provider
 * @param {{model: string, cwd?: string, prompt: string}} invocation
 * @param {NodeJS.ProcessEnv} environment Trusted parent environment for this launch.
 */
export function prepareCodexLaunch(provider, { model, cwd, prompt }, environment) {
  const { launch, nativeSettings = {} } = provider;
  if (!launch) throw new TypeError('launch is required for Codex CLI');
  checkArgument(launch.command, 'launch.command');
  checkArgument(model, 'model');
  if (cwd !== undefined) checkArgument(cwd, 'cwd');

  const launcherArgs = launch.args ?? [];
  for (const [index, arg] of launcherArgs.entries()) {
    if (arg.includes('\0')) throw new TypeError(`launch.args[${index}] contains NUL`);
  }

  const nativeArgs = [];
  for (const [key, value] of Object.entries(nativeSettings)) {
    if (key !== 'profile') throw new TypeError(`Unknown Codex nativeSettings key: ${key}`);
    checkArgument(value, 'nativeSettings.profile');
    nativeArgs.push(`--profile=${value}`);
  }

  return {
    command: launch.command,
    args: [...launcherArgs, 'exec', '--json', '--skip-git-repo-check', `--model=${model}`, ...nativeArgs, '-'],
    options: {
      cwd,
      env: launchEnvironment(launch.env, environment),
      shell: /** @type {const} */ (false),
    },
    stdin: prompt,
    stdoutFormat: /** @type {const} */ ('jsonl'),
  };
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {asserts value is string}
 */
function checkArgument(value, field) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new TypeError(`${field} must be a nonblank string without NUL`);
  }
}
