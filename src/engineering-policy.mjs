import { readFile } from 'node:fs/promises';

const DOCS = {
  kernel: new URL('../policy/engineering/kernel.md', import.meta.url),
  decisionProcess: new URL('../policy/engineering/decision-process.md', import.meta.url),
  planningCheckpoint: new URL('../policy/engineering/planning-checkpoint.md', import.meta.url),
  implementationCheckpoints: new URL('../policy/engineering/implementation-checkpoints.md', import.meta.url),
  reviewCheckpoint: new URL('../policy/engineering/review-checkpoint.md', import.meta.url),
  finalValidationCheckpoint: new URL('../policy/engineering/final-validation-checkpoint.md', import.meta.url),
  reviewRubric: new URL('../policy/engineering/review-rubric.md', import.meta.url),
  hardInvariants: new URL('../policy/engineering/hard-invariants.md', import.meta.url),
};

let cachedDocs = null;

async function loadDocs() {
  if (!cachedDocs) {
    cachedDocs = Promise.all(Object.entries(DOCS).map(async ([key, url]) => [key, (await readFile(url, 'utf8')).trim()]))
      .then((entries) => Object.fromEntries(entries));
  }
  return cachedDocs;
}

function section(title, body) {
  return `## ${title}\n\n${body}`;
}

export async function engineeringContextForRole(role) {
  if (!['planner', 'coder', 'reviewer', 'finalValidator'].includes(role)) return '';
  const docs = await loadDocs();
  if (role === 'planner') {
    return [
      section('Engineering Core — always-on kernel', docs.kernel),
      section('Engineering decision process', docs.decisionProcess),
      'Apply the project/user instructions and active skill as repository-specific overlays. The engineering core supplies the decision model; project context supplies the concrete architecture and conventions.',
    ].join('\n\n');
  }
  if (role === 'coder') {
    return [
      section('Engineering Core — always-on kernel', docs.kernel),
      'Use any supplied ENGINEERING FRAME as a grounded application of the core to this task. Re-check repository evidence if the frame is stale, incomplete, or contradicted by the current workspace.',
    ].join('\n\n');
  }
  if (role === 'reviewer') {
    return [
      section('Engineering Core — always-on kernel', docs.kernel),
      section('Engineering review rubric', docs.reviewRubric),
      'Use any supplied ENGINEERING FRAME as context, not as authority. Review the actual current repository independently and distinguish concrete defects from valid alternative designs.',
    ].join('\n\n');
  }
  if (role === 'finalValidator') {
    return section('Engineering hard invariants', docs.hardInvariants);
  }
  return '';
}

export async function engineeringCheckpointForRole(role) {
  if (!['planner', 'coder', 'reviewer', 'finalValidator'].includes(role)) return '';
  const docs = await loadDocs();
  if (role === 'planner') return docs.planningCheckpoint;
  if (role === 'coder') return docs.implementationCheckpoints;
  if (role === 'reviewer') return docs.reviewCheckpoint;
  return docs.finalValidationCheckpoint;
}

export function engineeringFrameText(plan) {
  const frame = plan?.engineeringFrame;
  return frame && typeof frame === 'object'
    ? JSON.stringify(frame, null, 2)
    : '(not produced: this workflow did not have a structured non-trivial planner frame)';
}
