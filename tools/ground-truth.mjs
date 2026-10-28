#!/usr/bin/env node
// Opt-in local capture only. Never reads diagnostic traces for prompt text.
import {readFile,open,lstat,mkdir} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {constants} from 'node:fs';
import {groundTruthDigest,validateGroundTruthCase} from '../src/routing/ground-truth.mjs';
const [action,...rest]=process.argv.slice(2);
const opts={};
for(let i=0;i<rest.length;i++){
  const option=rest[i];
  if(!option.startsWith('--')||Object.hasOwn(opts,option)){console.error('Invalid option');process.exit(2);}
  if(['--consent-reviewed','--confirm-label'].includes(option)){opts[option]=true;continue;}
  if(!rest[i+1]){console.error('Missing option value');process.exit(2);}
  opts[option]=rest[++i];
}
const safeId=id=>typeof id==='string'&&/^[a-z0-9][a-z0-9_-]{0,79}$/.test(id);
async function safeRead(file){const target=resolve(file);
  let current=dirname(target);while(true){const st=await lstat(current);
    if(!st.isDirectory()||st.isSymbolicLink())throw new Error('Unsafe input directory');
    if(current===dirname(current))break;current=dirname(current);}
  const info=await lstat(target);
  if(!info.isFile()||info.isSymbolicLink()||info.size>100_000)throw new Error('Unsafe input file');
  const handle=await open(target,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{return await handle.readFile('utf8');}finally{await handle.close();}}
async function save(file,data){const target=resolve(file);const parent=dirname(target);
  // Refuse symlink parents even for an explicitly supplied path.
  let current=parent;while(true){const st=await lstat(current);
    if(!st.isDirectory()||st.isSymbolicLink())throw new Error('Unsafe output directory');
    if(current===dirname(current))break;current=dirname(current);}
  const handle=await open(target,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{await handle.writeFile(`${JSON.stringify(data,null,2)}\n`,'utf8');await handle.sync();}finally{await handle.close();}}
try {
  if(action==='candidate'){
    if(!opts['--consent-reviewed']||!opts['--task-file']||!opts['--out']||!safeId(opts['--id']))
      throw new Error('Usage: candidate --id ID --task-file SCRUBBED_TASK.txt --out NEW_CASE.json --consent-reviewed');
    const task=await safeRead(opts['--task-file']);
    const captureFields={'--session-id':'sessionId','--run-id':'runId','--invocation-id':'invocationId',
      '--config-digest':'routerConfigurationDigest','--provider':'provider','--model':'model','--preset':'rolePreset'};
    const capture=Object.fromEntries(Object.entries(captureFields).filter(([flag])=>opts[flag]!==undefined)
      .map(([flag,key])=>[key,opts[flag]]));
    if(Object.keys(capture).length){
      if(!capture.sessionId||!capture.runId)throw new Error('Both session and run IDs required for capture');
      capture.eventSchemaVersion=1;capture.typedTaskVersion=1;
    }
    const record=validateGroundTruthCase({schemaVersion:1,id:opts['--id'],task,taskDigest:groundTruthDigest(task),
      ...(Object.keys(capture).length?{capture}:{}),
      labelStatus:'unlabeled',expected:null,recordedAt:new Date().toISOString()});
    await save(opts['--out'],record);
    console.log('Unlabeled candidate saved locally; verify its sensitive content before labeling.');
  }else if(action==='label'){
    if(!opts['--confirm-label']||!opts['--candidate']||!opts['--expected-file']||!opts['--out'])
      throw new Error('Usage: label --candidate CASE.json --expected-file EXPECTED.json --out NEW_CONFIRMED.json --confirm-label');
    const original=JSON.parse(await safeRead(opts['--candidate']));
    if(original.labelStatus!=='unlabeled')throw new Error('Expected an unlabeled candidate');
    const expected=JSON.parse(await safeRead(opts['--expected-file']));
    const now=new Date().toISOString();
    const labeled=validateGroundTruthCase({...original,labelStatus:'confirmed',expected,
      provenance:{method:'manual_review',confirmedBy:'user',confirmedAt:now}});
    await save(opts['--out'],labeled);
    console.log('Manually confirmed case saved locally; CI inclusion is never automatic.');
  }else throw new Error('Usage: candidate | label');
}catch(error){console.error('Ground truth operation failed:',error.message);process.exitCode=2;}
