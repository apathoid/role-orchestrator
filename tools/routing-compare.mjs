#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {compareSemanticEvaluations} from '../src/routing/regression.mjs';
const [a,b,criteria]=process.argv.slice(2);
if(!a||!b){console.error('Usage: npm run routing:compare -- baseline.json current.json [criteria.json]');process.exit(2);}
try {const result=compareSemanticEvaluations(JSON.parse(await readFile(a,'utf8')),
  JSON.parse(await readFile(b,'utf8')),criteria?JSON.parse(await readFile(criteria,'utf8')):{});
  console.log(JSON.stringify(result,null,2));if(result.status!=='PASS')process.exitCode=result.status==='FAIL'?1:3;
}catch(e){console.error('Evaluation comparison unavailable:',e.message);process.exitCode=2;}
