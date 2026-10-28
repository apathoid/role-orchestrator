#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { evaluateBenchmarkSuite } from '../src/evaluation/benchmark-suite.mjs';
const file=process.argv[2];
if (!file) { console.error('Usage: node tools/efficiency-benchmark.mjs suite.json'); process.exitCode=2; }
else try {
  const result=evaluateBenchmarkSuite(JSON.parse(await readFile(file,'utf8')));
  console.log(JSON.stringify(result,null,2));
  if (result.status==='rejected') process.exitCode=1;
  else if (result.status==='insufficient_evidence') process.exitCode=3;
} catch(error) { console.error(`Invalid benchmark: ${error.message}`);process.exitCode=2; }
