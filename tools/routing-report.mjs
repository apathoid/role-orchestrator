#!/usr/bin/env node
import {createExecutionObserver} from '../src/observability/execution-observer.mjs';
import {routingReport} from '../src/routing/reporting.mjs';
const args=process.argv.slice(2);let root=null,sessionId=null,runId=null,from=null,to=null;
for(let i=0;i<args.length;i+=2){if(!['--root','--session','--run','--from','--to'].includes(args[i])||!args[i+1]){
  console.error('Usage: npm run routing:report -- [--root path] [--session ID] [--run ID] [--from ISO] [--to ISO]');process.exit(2);}
  ({'--root':v=>root=v,'--session':v=>sessionId=v,'--run':v=>runId=v,'--from':v=>from=v,'--to':v=>to=v})[args[i]](args[i+1]);}
try {console.log(JSON.stringify(await routingReport({observer:createExecutionObserver(root?{root}:{}),sessionId,runId,from,to}),null,2));}
catch(e){console.error('Routing report unavailable:',e.message);process.exitCode=2;}
