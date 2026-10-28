import { profileProviderPrompt } from '../efficiency/profiling.mjs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSafe } from '../repo.mjs';
import { parseStructuredStateOrText } from '../structured-output.mjs';
import { projectName } from '../project.mjs';
import { buildTaskPlanProgressContract } from '../task-plan-progress.mjs';
import { codexCliCapabilities } from './capabilities.mjs';
import { assertSupportedSandboxMode } from './provider.mjs';
import { minimalChildEnv } from './process-env.mjs';

function tomlString(value) {
  return JSON.stringify(String(value));
}

function parseVersion(text) {
  const m = String(text).match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? m.slice(1).map(Number) : null;
}

function versionAtLeast(actual, required) {
  const a = parseVersion(actual); const r = parseVersion(required);
  if (!a || !r) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] > r[i]) return true;
    if (a[i] < r[i]) return false;
  }
  return true;
}


function humanizeAgentMessage(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return '';
    for (const key of ['commentary', 'summary', 'reason', 'goal', 'final', 'message']) {
      if (typeof parsed[key] === 'string' && parsed[key].trim()) return parsed[key].trim();
    }
    return '';
  } catch {
    return raw;
  }
}

export class CodexCliProvider {
  constructor(name, config) {
    this.name = name;
    this.config = config;
    this.binary = config.binary ?? 'codex';
    this.preflightDone = false;
  }

  capabilities() { return codexCliCapabilities(); }

  childEnv() {
    return minimalChildEnv({ allow: this.config.envAllowlist ?? [] });
  }

  async preflight() {
    if (this.preflightDone) return;
    const version = await execFileSafe(this.binary, ['--version'], { timeoutMs: 15_000, inheritEnv: false, env: this.childEnv(), killProcessGroup: true });
    if (this.config.minVersion && !versionAtLeast(version.stdout || version.stderr, this.config.minVersion)) {
      throw new Error(`${this.name}: Codex CLI ${this.config.minVersion}+ is required; got ${version.stdout || version.stderr}`);
    }

    if (this.config.auth === 'chatgpt') {
      const status = await execFileSafe(this.binary, ['login', 'status'], { timeoutMs: 15_000, allowFailure: true, inheritEnv: false, env: this.childEnv(), killProcessGroup: true });
      const text = `${status.stdout}\n${status.stderr}`;
      if (status.code !== 0) {
        throw new Error(`${this.name}: Codex is not logged in. Run: codex login`);
      }
      if (/api\s*key/i.test(text) && !/chatgpt/i.test(text)) {
        throw new Error(`${this.name}: Codex is authenticated with an API key, not ChatGPT. Run 'codex logout', then 'codex login'.`);
      }
      if (!/chatgpt/i.test(text)) {
        throw new Error(`${this.name}: could not positively verify ChatGPT authentication from 'codex login status'. Refusing to risk API billing. Status was:\n${text.trim()}`);
      }
    }
    this.preflightDone = true;
  }

  async invoke({ profileName, profile, role, prompt, schemaKind, schema, cwd, sandboxMode = 'read-only', signal, onProgress, taskPlan = null }) {
    assertSupportedSandboxMode(sandboxMode, this.name);
    await this.preflight();
    const temp = await mkdtemp(join(tmpdir(), `${projectName}-codex-`));
    const schemaPath = join(temp, 'schema.json');
    const outputPath = join(temp, 'output.json');
    if (schemaKind && schema) await writeFile(schemaPath, JSON.stringify(schema, null, 2));

    // `--ask-for-approval` is a Codex *global* flag. Current Codex CLI
    // rejects it when it appears after the `exec` subcommand, so keep global
    // flags before `exec` and exec-specific/propagated flags after it.
    const args = [
      '--ask-for-approval', 'never',
      'exec', '--ephemeral', '--ignore-user-config', '--color', 'never', '--json',
      '--sandbox', sandboxMode,
      '--model', profile.model,
      '--output-last-message', outputPath,
    ];

    const schemaMode = profile.outputSchemaMode ?? this.config.outputSchemaMode ?? 'native';
    if (schemaKind && schema && schemaMode === 'native') args.push('--output-schema', schemaPath);

    // Keep an ACP-compatible host Plan widget synchronized with the task plan.
    // Current Codex releases can have update_plan disabled by default, so enable
    // it explicitly only for roles that receive an orchestrator task plan.
    if (Array.isArray(taskPlan) && taskPlan.length > 0) {
      args.push('-c', 'tools.update_plan.enabled=true');
    }

    // Fail closed for subscription-backed providers: even if the user's global
    // Codex config changes later, this invocation may only use ChatGPT auth.
    // This prevents an accidental fallback to API-key billing.
    if (this.config.auth === 'chatgpt') {
      args.push('-c', 'forced_login_method="chatgpt"');
    }

    if (profile.reasoningEffort) args.push('-c', `model_reasoning_effort=${tomlString(profile.reasoningEffort)}`);
    if (profile.verbosity) args.push('-c', `model_verbosity=${tomlString(profile.verbosity)}`);

    // Ask Codex for user-visible reasoning *summaries*. We intentionally do not
    // enable raw chain-of-thought. `codex exec --json` surfaces completed
    // reasoning-summary items that can be exposed as semantic reasoning events.
    const reasoningSummary = profile.reasoningSummary ?? this.config.reasoningSummary ?? 'auto';
    if (reasoningSummary && reasoningSummary !== 'none') {
      args.push('-c', `model_reasoning_summary=${tomlString(reasoningSummary)}`);
      args.push('-c', 'show_raw_agent_reasoning=false');
    }

    if (profile.fastMode === true) {
      args.push('-c', 'service_tier="fast"');
      args.push('-c', 'features.fast_mode=true');
    } else if (profile.fastMode === false) {
      args.push('-c', 'service_tier="default"');
    }

    const mp = this.config.modelProvider;
    if (mp) {
      args.push('-c', `model_provider=${tomlString(mp.id)}`);
      args.push('-c', `model_providers.${mp.id}.name=${tomlString(mp.name ?? mp.id)}`);
      args.push('-c', `model_providers.${mp.id}.base_url=${tomlString(mp.baseURL)}`);
      args.push('-c', `model_providers.${mp.id}.wire_api="responses"`);
      args.push('-c', `model_providers.${mp.id}.requires_openai_auth=false`);
    }

    const taskPlanContract = buildTaskPlanProgressContract(taskPlan, {
      mechanism: 'update_plan/native todo-list mechanism',
    });
    const strictPrompt = schemaKind && schema
      ? `${prompt}${taskPlanContract}\n\nOUTPUT CONTRACT:\nReturn ONLY one JSON object matching this JSON Schema exactly. No markdown fences or prose outside JSON.\n${JSON.stringify(schema)}`
      : `${prompt}${taskPlanContract}\n\nUSER-FACING RESPONSE:\nChoose the clearest natural Markdown presentation yourself. Use fenced code blocks or a fenced unified diff when useful. Do not serialize the response as orchestration JSON unless the user asked for JSON.`;
    const started = Date.now();
    let progressQueue = Promise.resolve();
    let turnUsage = null;
    const reasoningTextById = new Map();
    const agentMessageTextById = new Map();
    let pendingAgentMessage = null;
    const queueProgress = (event) => {
      if (!onProgress) return;
      progressQueue = progressQueue.then(() => onProgress(event)).catch(() => {});
    };
    queueProgress({ type: 'prompt_profile', profile: profileProviderPrompt(strictPrompt, 0) });
    const forwardReasoningSummary = (item) => {
      if (item?.type !== 'reasoning' || typeof item.text !== 'string') return;
      const text = item.text;
      if (!text.trim()) return;
      const id = item.id ?? '__reasoning__';
      const previous = reasoningTextById.get(id) ?? '';
      if (text === previous) return;

      // `codex exec --json` may emit `item.updated` with the full accumulated
      // reasoning summary. Forward only the newly-added suffix so hosts can
      // render the summary progressively without duplicating earlier text.
      const delta = previous && text.startsWith(previous) ? text.slice(previous.length) : text;
      reasoningTextById.set(id, text);
      if (delta) queueProgress({ type: 'reasoning', text: delta });
    };
    const flushPendingAgentMessage = () => {
      if (!pendingAgentMessage) return;
      const text = humanizeAgentMessage(pendingAgentMessage.text);
      pendingAgentMessage = null;
      if (text) queueProgress({ type: 'commentary', text });
    };
    const trackAgentMessage = (item) => {
      if (item?.type !== 'agent_message' || typeof item.text !== 'string') return;
      const id = item.id ?? '__agent_message__';
      const previous = agentMessageTextById.get(id) ?? '';
      if (item.text === previous) return;
      agentMessageTextById.set(id, item.text);

      // `codex exec --json` currently drops the app-server `phase` field that
      // distinguishes commentary from the final answer. Keep the newest agent
      // message buffered. Once another message/tool item follows it, the older
      // one is provably intermediate and can be surfaced. The final buffered
      // message is intentionally discarded at turn.completed so the structured
      // JSON result never leaks into the UI as commentary.
      if (pendingAgentMessage && pendingAgentMessage.id !== id) flushPendingAgentMessage();
      pendingAgentMessage = { id, text: item.text };
    };
    const handleJsonLine = (line) => {
      if (!line?.trim()) return;
      let event;
      try { event = JSON.parse(line); } catch { return; }
      if ((event?.type === 'item.updated' || event?.type === 'item.completed') && event.item?.type === 'reasoning') {
        forwardReasoningSummary(event.item);
      }
      if ((event?.type === 'item.started' || event?.type === 'item.updated' || event?.type === 'item.completed') && event.item?.type === 'todo_list' && Array.isArray(event.item.items)) {
        queueProgress({
          type: 'plan_update',
          items: event.item.items.map((item) => ({
            text: typeof item?.text === 'string' ? item.text : '',
            completed: item?.completed === true,
            ...(typeof item?.status === 'string' ? { status: item.status } : {}),
          })),
        });
      }
      if ((event?.type === 'item.updated' || event?.type === 'item.completed') && event.item?.type === 'agent_message') {
        trackAgentMessage(event.item);
      } else if ((event?.type === 'item.started' || event?.type === 'item.updated' || event?.type === 'item.completed') && event.item && event.item.type !== 'reasoning' && event.item.type !== 'todo_list') {
        // A tool/file/search/etc. item following an assistant message proves
        // that message was interim commentary. We do not forward the tool
        // event itself; it is only a safe boundary for flushing commentary.
        flushPendingAgentMessage();
      }
      if (event?.type === 'turn.completed') {
        // The last agent_message of a turn is the final answer. It is consumed
        // from --output-last-message below and must not be displayed as progress.
        pendingAgentMessage = null;
      }
      if (event?.type === 'turn.completed' && event.usage) {
        // Incomplete provider usage must remain unknown, not turn into a
        // fabricated zero. Token accounting drives efficiency comparisons.
        const observed = (key) => {
          const value = event.usage[key];
          return Number.isSafeInteger(value) && value >= 0 ? value : null;
        };
        const inputTokens = observed('input_tokens');
        const outputTokens = observed('output_tokens');
        const cachedInputTokens = observed('cached_input_tokens');
        const cacheWriteInputTokens = observed('cache_write_input_tokens');
        const reasoningOutputTokens = observed('reasoning_output_tokens');
        turnUsage = {
          inputTokens,
          outputTokens,
          cachedInputTokens,
          cacheWriteInputTokens,
          reasoningOutputTokens,
          totalTokens: inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null,
        };
        queueProgress({ type: 'usage', usage: turnUsage, contextWindow: profile.contextWindow ?? null });
      }
    };
    try {
      const result = await execFileSafe(this.binary, [...args, '-'], {
        cwd,
        input: strictPrompt,
        // CLI streaming does not expose the nested ACP session-update channel used
        // by the activity watchdog, but it should still honor the new absolute
        // deadline name when profiles/providers are moved between adapters.
        timeoutMs: profile.turnDeadlineMs ?? this.config.turnDeadlineMs ?? profile.timeoutMs ?? this.config.timeoutMs ?? 900_000,
        allowFailure: true,
        // Do not reveal the source checkout path or orchestrator control values
        // to model-spawned shell commands. ChatGPT-auth providers also do not
        // need API credentials in the child environment.
        signal,
        inheritEnv: false,
        env: this.childEnv(),
        killProcessGroup: true,
        onStdoutLine: handleJsonLine,
      });
      await progressQueue;
      if (result.code !== 0) {
        throw new Error(`${this.name}/${profileName}/${role}: codex exec failed (${result.code}).\n${result.stderr || result.stdout}`);
      }
      const raw = (await readFile(outputPath, 'utf8')).trim();
      const interpreted = schemaKind
        ? parseStructuredStateOrText({ finalText: raw, unphasedText: '' }, schemaKind)
        : { format: 'text', text: raw, rawText: raw, source: 'native-final-answer', parseError: null };
      return {
        output: interpreted.format === 'structured' ? interpreted.data : interpreted.text,
        meta: {
          elapsedMs: Date.now() - started,
          stdout: result.stdout,
          stderr: result.stderr,
          usage: turnUsage,
          structuredOutput: {
            format: interpreted.format,
            source: interpreted.source,
            parseError: interpreted.parseError,
            rawText: interpreted.rawText,
            diagnostics: interpreted.diagnostics ?? null,
            providerCompletionStatus: 'process_exited_successfully',
          },
        },
      };
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }
}
