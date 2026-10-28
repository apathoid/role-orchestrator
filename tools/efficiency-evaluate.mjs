#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { evaluateQuality, compareQuality } from '../src/evaluation/efficiency-quality.mjs';
const [a,b]=process.argv.slice(2);
if (!a) { console.error('Usage: node tools/efficiency-evaluate.mjs baseline.json [candidate.json]'); process.exitCode=2; }
else try {
  const read=async p=>evaluateQuality(JSON.parse(await readFile(p,'utf8')));
  const baseline=await read(a);
  const candidate=b ? await read(b) : null;
  console.log(JSON.stringify({ baseline, ...(candidate ? { candidate, comparison:compareQuality(baseline,candidate) } : {}) },null,2));
} catch (e) { console.error(`Evaluation failed: ${e.message}`); process.exitCode=1; }
