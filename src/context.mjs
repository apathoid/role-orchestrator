import { readdir, stat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isWithin, readScopedText } from './instruction-files.mjs';

const MAX_INSTRUCTION_CONTEXT = 160_000;
const MAX_DOCUMENT_CHARS = 40_000;
const MAX_DISCOVERED_RULES = 64;

async function readOptional(path, root) {
  return readScopedText(path, root, { maxChars: MAX_DOCUMENT_CHARS });
}

function parseFrontmatter(text, fallbackName) {
  const result = { name: fallbackName, description: '', argumentHint: null, orchestratorMode: null, orchestratorDelegation: null };
  if (!text.startsWith('---\n')) return result;
  const end = text.indexOf('\n---', 4);
  if (end < 0) return result;
  const frontmatter = text.slice(4, end).split('\n');
  for (const line of frontmatter) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    const value = match[2].trim().replace(/^['"]|['"]$/g, '');
    if (key === 'name' && value) result.name = value;
    else if (key === 'description') result.description = value;
    else if (key === 'argument-hint' || key === 'argumentHint') result.argumentHint = value || null;
    else if (key === 'orchestrator-mode' && ['investigate', 'review'].includes(value)) result.orchestratorMode = value;
    else if (key === 'orchestrator-delegation' && ['allowed','restricted','forbidden'].includes(value)) result.orchestratorDelegation = value;
  }
  return result;
}

async function discoverSkillsIn(root, scope, boundaryRoot) {
  const skills = new Map();
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) {
    if (error?.code === 'ENOENT') return skills;
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name, 'SKILL.md');
    const body = await readOptional(path, boundaryRoot);
    if (body === null) continue;
    const meta = parseFrontmatter(body, entry.name);
    if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(meta.name)) continue;
    skills.set(meta.name, { ...meta, body, path, scope });
  }
  return skills;
}

export async function discoverSkills(repoRoot, { home = homedir() } = {}) {
  const globalRoot = join(home, '.agents', 'skills');
  const projectRoot = join(repoRoot, '.agents', 'skills');
  const globalSkills = await discoverSkillsIn(globalRoot, 'global', join(home, '.agents'));
  const projectSkills = await discoverSkillsIn(projectRoot, 'project', resolve(repoRoot));
  // Project-local skills intentionally override global skills with the same name.
  return new Map([...globalSkills, ...projectSkills]);
}

// Only canonical, provider-independent instructions are loaded implicitly.
// More specific rules appear later, so the model can resolve conflicts with
// provenance. Security/permissions are enforced by code, not by these files.
export async function loadInstructionContext(repoRoot, { home = homedir(), scopePaths = [] } = {}) {
  const projectRoot = resolve(repoRoot);
  const globalRoot = join(home, '.agents');
  const projectAgents = join(projectRoot, '.agents');
  const ordered = [
    { scope: 'global-orchestrator', path: join(globalRoot, 'role-orchestrator', 'ORCHESTRATOR.md'), root: globalRoot },
    { scope: 'global', path: join(globalRoot, 'AGENTS.md'), root: globalRoot },
    { scope: 'project-orchestrator', path: join(projectAgents, 'role-orchestrator', 'ORCHESTRATOR.md'), root: projectRoot },
    { scope: 'project', path: join(projectRoot, 'AGENTS.md'), root: projectRoot },
  ];
  const nested = new Set();
  for (const selected of scopePaths) {
    const absolute = resolve(projectRoot, selected);
    if (!isWithin(projectRoot, absolute)) throw new Error(`Instruction scope escapes project root: ${selected}`);
    // A directory may not exist yet (new code), but scope resolution must not
    // let symlinks escape the checkout. readScopedText enforces that for files.
    let dir = absolute;
    try { if (!(await stat(absolute)).isDirectory()) dir = dirname(absolute); }
    catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      if (!selected.endsWith('/')) dir = dirname(absolute);
    }
    while (dir !== projectRoot && isWithin(projectRoot, dir)) {
      nested.add(dir);
      dir = dirname(dir);
    }
  }
  for (const dir of [...nested].sort((a, b) => a.split(sep).length - b.split(sep).length || a.localeCompare(b))) {
    ordered.push({ scope: 'nested', path: join(dir, 'AGENTS.md'), root: projectRoot });
  }

  const instructions = [];
  const seen = new Set();
  const loadOne = async ({ scope, path, root }) => {
    const body = await readOptional(path, root);
    if (!body?.trim()) return;
    const key = await realpath(path);
    if (seen.has(key)) return;
    seen.add(key);
    instructions.push({ scope, path: relative(scope.startsWith('global') ? globalRoot : projectRoot, path), body: body.trim(), absolutePath: key });
    if (instructions.reduce((size, doc) => size + doc.body.length, 0) > MAX_INSTRUCTION_CONTEXT) {
      throw new Error(`Instruction context exceeds ${MAX_INSTRUCTION_CONTEXT} characters. Refine the scoped rules; no instructions were silently discarded.`);
    }
  };
  // Link only explicit Markdown references into .agents; a linked document
  // belongs to its referring instruction's precedence layer.
  const referencePattern = /\[[^\]]+\]\(([^)]+\.md)\)|`([^`\n]+\.md)`/giu;
  for (const doc of ordered) {
    const count = instructions.length;
    await loadOne(doc);
    if (instructions.length === count) continue;
    const source = instructions.at(-1);
    for (const match of source.body.matchAll(referencePattern)) {
      const reference = (match[1] ?? match[2]).trim();
      if (!reference || /^[a-z]+:/iu.test(reference) || reference.includes('#') || reference.includes('?')) continue;
      let target;
      if (reference.startsWith('.agents/')) target = resolve(projectRoot, reference);
      else if (reference.startsWith('~/.agents/')) target = resolve(home, reference.slice(2));
      else if (!isAbsolute(reference)) target = resolve(dirname(source.absolutePath), reference);
      else continue;
      const ruleRoot = isWithin(projectAgents, target) ? projectAgents : isWithin(globalRoot, target) ? globalRoot : null;
      if (!ruleRoot || target.split(sep).includes('skills') || target.endsWith(`${sep}ORCHESTRATOR.md`)) continue;
      await loadOne({ scope: `${source.scope}-reference`, path: target, root: ruleRoot });
    }
  }
  return instructions;
}

async function discoverAdditionalRules(repoRoot) {
  const base = join(repoRoot, '.agents');
  const candidates = [];
  async function walk(directory, depth) {
    if (depth > 2 || candidates.length >= MAX_DISCOVERED_RULES) return;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error?.code === 'ENOENT') return; throw error; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink() || ['role-orchestrator', 'skills'].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path, depth + 1);
      if (entry.isFile() && /\.md$/iu.test(entry.name)) {
        candidates.push(relative(repoRoot, path));
      }
      if (candidates.length >= MAX_DISCOVERED_RULES) break;
    }
  }
  await walk(base, 0);
  return candidates;
}

export async function loadInvocationContext(repoRoot, { skillName = null, scopePaths = [], home = homedir() } = {}) {
  const instructions = await loadInstructionContext(repoRoot, { home, scopePaths });
  const availableRules = await discoverAdditionalRules(repoRoot);
  const skills = await discoverSkills(repoRoot, { home });
  let skill = null;
  if (skillName) {
    skill = skills.get(skillName) ?? null;
    if (!skill) throw new Error(`Unknown skill '${skillName}'.`);
  }
  return { instructions, skills, skill, availableRules };
}

export function formatInstructionContext({ instructions = [], skill = null, availableRules = [] } = {}) {
  const blocks = [];
  if (instructions.length) {
    blocks.push('PERSISTENT USER/PROJECT INSTRUCTIONS (ordered from general to specific; later applicable instructions take precedence. Project AGENTS.md takes precedence over ORCHESTRATOR.md. These are not authorization to bypass security policies, permissions, or user constraints):\n' + instructions.map((item) =>
      `--- ${item.scope}: ${item.path} ---\n${item.body}`
    ).join('\n\n'));
  }
  blocks.push('INSTRUCTION SCOPE: Before editing or reviewing files in a new repository subtree, check for applicable nested AGENTS.md files along that subtree. Instructions from the initial working directory do not automatically cover unrelated directories. Treat optional .agents documents as discoverable task material until you inspect and establish applicability.');
  if (availableRules.length) {
    blocks.push(`OPTIONAL PROJECT RULES (discovery only; not automatically authoritative; inspect relevant documents before use):\n${availableRules.join('\n')}`);
  }
  if (skill) {
    blocks.push(`ACTIVE SKILL (${skill.scope}): ${skill.name}\nSource: ${skill.path}\n${skill.body}`);
  }
  return blocks.join('\n\n');
}

function emptyInvocation(task, command = null) {
  return { task, modeOverride: null, skillName: null, reviewTarget: null, command };
}

function skillInvocation(name, args, source, originalRequest) {
  return { kind: 'explicit', name, source, arguments: args, originalRequest };
}
function skillCommand(name, args, source, originalRequest) {
  return { task: args || `Execute the ${name} skill for the current project.`,
    modeOverride: null, skillName: name, reviewTarget: null, command: 'skill',
    skillInvocation: skillInvocation(name, args, source, originalRequest) };
}
function parseSkillCommandArgs(args, skills, originalRequest) {
  const match = args.match(/^([a-z0-9][a-z0-9-]*)(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  const name = match[1].toLowerCase();
  if (!skills?.has(name)) return { ...emptyInvocation(originalRequest, 'skill'),
    error: `SKILL_NOT_FOUND: '${name}'. Run /skills to list available skills.` };
  return skillCommand(name, (match[2] ?? '').trim(), 'slash', originalRequest);
}
// Non-command text is interpreted only by the existing LLM Router.
// This compatibility export accepts protocol data, never natural language.
export function inferReviewTarget(command) {
  return command && typeof command === 'object' && command.type === 'commit' ? command : null;
}

export function parseSlashInvocation(text, skills) {
  const trimmed = text.trim();
  const match = trimmed.match(/^\/([a-z0-9][a-z0-9-]*)(?:\s+([\s\S]*))?$/i);
  if (!match) return emptyInvocation(trimmed);
  const command = match[1].toLowerCase();
  const args = (match[2] ?? '').trim();
  if (command === 'review-resume') return { task: `/review-resume${args ? ` ${args}` : ''}`,
    modeOverride: 'review', skillName: null, reviewTarget: null, command };
  if (command === 'review-reconcile') return { task: `/review-reconcile ${args}`,
    modeOverride: 'review', skillName: null, reviewTarget: null, command };
  if (command === 'review') return { task: args || 'Review the current project code.', modeOverride: 'review', skillName: null, reviewTarget: null, command };
  if (command === 'review-commit') {
    const target = args.match(/^([^\s]+)(?:\s+([\s\S]*))?$/);
    if (!target) return { task: 'Review the requested commit.', modeOverride: 'review', skillName: null, reviewTarget: null, command, error: 'Usage: /review-commit <revision> [review focus]' };
    const revision = target[1];
    const focus = (target[2] ?? '').trim();
    return {
      task: focus || 'Review the selected commit for correctness, regressions, and meaningful test coverage.',
      modeOverride: 'review',
      skillName: null,
      reviewTarget: { type: 'commit', revision },
      command,
    };
  }
  if (command === 'change') return { task: args || 'Implement the requested change.', modeOverride: 'change', skillName: null, reviewTarget: null, command };
  if (command === 'investigate') return { task: args || 'Investigate the current project and report findings.', modeOverride: 'investigate', skillName: null, reviewTarget: null, command };
  if (command === 'skill') {
    const parsed = parseSkillCommandArgs(args, skills, trimmed);
    return parsed ?? { ...emptyInvocation(trimmed, command), error: 'Usage: /skill <skill-name> [task]. Run /skills to list available skills.' };
  }
  if (skills?.has(command)) return { ...skillCommand(command, args, 'slash', trimmed), command };
  return { ...emptyInvocation(trimmed, command), error: `UNKNOWN_COMMAND: /${command}. Run /skills to list available skills.` };
}
