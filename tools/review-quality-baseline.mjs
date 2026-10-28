#!/usr/bin/env node
// Offline A/B identity manifest. Hashes only; never exports prompt, source,
// paths, credentials or user-provided text. This does not invoke any model.
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { captureRepoState } from '../src/repo.mjs';
const sha = text => createHash('sha256').update(text).digest('hex');
const digestFile = async p => p ? sha(await readFile(p)) : null;
const [repo, taskFile, configFile] = process.argv.slice(2);
if (!repo || process.argv.length > 5) {
  console.error('Usage: npm run review:quality-baseline -- <repoRoot> [task-file] [config-file]');
  process.exitCode=2;
} else {
  const root=await realpath(resolve(repo));
  const state=await captureRepoState(root);
  // Hash the exact content fingerprints captured by the existing repository
  // layer rather than relying on HEAD alone for dirty worktrees.
  const manifest={version:1,kind:'review_comparison_identity',repoKey:sha(root),
    snapshotDigest:sha(JSON.stringify({head:state.head,headRef:state.gitMetadata?.headRef,
      refsHash:state.gitMetadata?.refsHash,stagedHash:state.gitMetadata?.stagedHash,
      workspaceHashes:state.workspaceHashes})),
    taskDigest:await digestFile(taskFile),configDigest:await digestFile(configFile),
    sourceIdentity:'hashes_only',groundTruth:'requires_independent_adjudication',
    providerUsage:'not_collected'};
  process.stdout.write(JSON.stringify(manifest,null,2)+'\n');
}
