/** @import {CodexEnvelope} from './codex-output.js' */
/** @import {Outcome} from '../../core/contracts.js' */
/** @typedef {{line:number,event:CodexEnvelope}} Frame */
/** @param {unknown} value @returns {Record<string,unknown>|undefined} */
export const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? /** @type {Record<string,unknown>} */ (value) : undefined;
/** @param {unknown} value */
export const integer = value => typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;

/** Independent bounded execution facts; validate every frame, retain only
 * observation-bearing frames. A separate latest-message slot guarantees
 * result selection regardless of intermediate reasoning/tool volume.
 */
export function createCodexExecution() {
  // Each retained frame is a validated nonempty JSON envelope. Its wire
  // bytes also bound the number of objects (minimum envelope: 16 bytes).
  // Do not introduce a lower count ceiling than the historical raw capture.
  const maxEvidenceBytes=1024*1024;
  /** @type {Frame[]} */
  const evidence=[];
  let bytes=0, omitted=0, omittedDeclines=0;
  /** @type {number[]} */
  const firstOmitted=[];
  let sent=false, invalidSequence=false, toolCompletions=0;
  /** @type {string|undefined} */
  let threadId;
  /** @type {'turn.completed'|'turn.failed'|undefined} */
  let terminal;
  /** @type {Frame|undefined} */
  let message;
  /** @type {Frame|undefined} */
  let providerError;
  /** @type {Outcome['usage']} */
  const usage={inputTokens:null,outputTokens:null,cost:null};
  /** @param {Frame} frame @param {number} size */
  function retain(frame,size) {
    if(bytes+size<=maxEvidenceBytes) {
      evidence.push(frame); bytes+=size; return true;
    } else { if (firstOmitted.length<3) firstOmitted.push(frame.line); omitted++; return false; }
  }
  return {
    /** @param {number} line @param {CodexEnvelope} event @param {number} size */
    accept(line,event,size) {
      const frame={line,event};
      if(event.type==='thread.started'&&typeof event.thread_id==='string') threadId=event.thread_id.slice(0,256);
      if(event.type==='turn.started') { if(sent) invalidSequence=true; sent=true; }
      else if(event.type==='turn.completed'||event.type==='turn.failed') {
        if(terminal)invalidSequence=true;
        terminal=event.type;sent=true;
        if(event.type==='turn.completed') {
          const tokens=record(event.usage), input=integer(tokens?.input_tokens), output=integer(tokens?.output_tokens);
          if(input!==undefined&&input>=0)usage.inputTokens=input;
          if(output!==undefined&&output>=0)usage.outputTokens=output;
        }
      }
      if(event.type==='error'||event.type==='turn.failed') { providerError=frame;retain(frame,size); }
      if(event.type!=='item.completed')return;
      const item=record(event.item);
      if(terminal||typeof item?.id!=='string'||!item.id.trim()||typeof item.type!=='string') {
        invalidSequence=true;return;
      }
      if(item.type==='command_execution'||item.type==='file_change'||item.type==='mcp_tool_call'||item.type==='web_search'||item.type==='collab_tool_call') toolCompletions++;
      if(item.type==='agent_message') {
        if(typeof item.text!=='string'){invalidSequence=true;return;}
        message=frame;retain(frame,size);
      } else if(item.type==='command_execution'||(item.type==='error'&&typeof item.message==='string')) {
        if(!retain(frame,size)&&item.type==='command_execution'&&item.status==='declined') omittedDeclines++;
      }
    },
    finish() {
      const frames=[...evidence];
      const recovered=new Set();
      for(const extra of [message,providerError])if(extra&&!frames.includes(extra)){frames.push(extra);recovered.add(extra.line);}
      frames.sort((a,b)=>a.line-b.line);
      return {frames,sent,terminal,invalidSequence,usage,message,threadId,toolCompletions,omitted:omitted-recovered.size,
        firstOmittedLine:firstOmitted.find(line=>!recovered.has(line))??0,retainedBytes:bytes,omittedDeclines};
    }
  };
}
