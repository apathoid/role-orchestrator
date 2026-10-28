// Reuse is explicitly operator-opted-in, scoped to one mandatory verification
// attempt, and never applies to mandatory final diff or diagnostic policies.
// A positive result is not proof of deterministic behavior; cacheable:true is
// a trusted HOST assertion of hermeticity, not a model suggestion.
import { createHash } from 'node:crypto';
import { captureRepoState, execFileSafe } from '../repo.mjs';
import { witnessVerificationInputs } from '../verification-inputs.mjs';
const digest = input => createHash('sha256').update(JSON.stringify(input)).digest('hex');
const snapshotKey = s => digest([s.head,s.workspaceHashes,s.gitMetadata?.headRef,
  s.gitMetadata?.refsHash,s.gitMetadata?.stagedHash,s.gitMetadata?.localConfigHash]);
export function createVerificationAttemptCache(root, { closures = {}, policies = {} } = {}) {
  const results=new Map();
  async function witness(command) {
    const name=command.join(' '), declaration=closures[name];
    if (declaration?.cacheable !== true || declaration.complete !== true ||
        !Array.isArray(declaration.paths) || declaration.paths.length === 0 ||
        Object.hasOwn(policies,name) || name === 'git diff --check') return null;
    const inputs=await witnessVerificationInputs(root,declaration);
    if (inputs.kind !== 'paths' || inputs.completeness !== 'complete') return null;
    // Tool identity must be witnessed. Do not cache when --version is missing
    // or non-standard; never assume a binary is unchanged from its name.
    const program=command[0];
    let version;
    try {
      const result=await execFileSafe(program,['--version'],{cwd:root,allowFailure:true,timeoutMs:2500,
        maxResultChars:2000});
      if (result.code!==0 || result.truncated) return null;
      version=digest([result.stdout,result.stderr,process.execPath,process.version]);
    } catch { return null; }
    let snapshot;
    try { snapshot=snapshotKey(await captureRepoState(root)); } catch { return null; }
    return digest({ command,inputs,version,snapshot,ci:'1',path:process.env.PATH??'',
      // The manifest is host-owned and included in the key, not just a path list.
      declaration, policy:'unconfigured' });
  }
  return {
    async lookup(command) {
      const key=await witness(command), previous=key ? results.get(command.join(' ')) : null;
      if (!key || !previous || previous.key!==key) return {hit:false,key,reason:!key?'unsafe_or_incomplete_inputs':
        !previous?'no_prior_result':'input_or_environment_changed'};
      return {hit:true,reason:'same_attempt_witnessed_pass',result:{...previous.result,
        cache:{hit:true,scope:'attempt',reason:'same_attempt_witnessed_pass'}}};
    },
    async remember(command,result,beforeKey) {
      if (!beforeKey || result?.status!=='PASS' || result?.inputsStable!==true || result?.timedOut || result?.signal) return false;
      const key=await witness(command);
      if (!key || key!==beforeKey) return false;
      results.set(command.join(' '),{key,result});return true;
    },
  };
}
