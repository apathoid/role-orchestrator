import { projectForm, createFormDraft, renderFormIntro, renderFormField, formValue, validateFormContent, validateFormPatterns } from './cli-form.js';
import { createInterface, clearLine, cursorTo } from 'node:readline';
import { terminalText, createTerminalSanitizer, boundedText } from './presentation.js';

/** @import {PresentationTone} from './presentation.js' */
/** @import {PendingPermission, PermissionHandler} from '../application/configuration/permissions.js' */
/** @import {PendingInteraction, InteractionResult} from '../core/ports.js' */
/** @typedef {{kind:'permission', request: PendingPermission} | {kind:'input', request: PendingInteraction}} PendingInput */
/** @typedef {{kind:'answered', payload: unknown} | {kind:'cancelled' | 'unavailable'}} InputResult */

/** @param {unknown} value @returns {Record<string, unknown>} */
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : {};

/** Actual SDK 2.4.0 ACP v1 restricted form. No arbitrary JSON Schema or custom wire assumptions.
 * @param {PendingInteraction} request */
export function supportedForm(request){return projectForm(request)!==undefined;}

/** @param {PendingInput} entry @param {string} line @returns {InputResult|undefined} */
function parsePermission(entry,line){
  if(entry.kind!=='permission')return;
  if(line===':cancel')return {kind:'cancelled'};
  const numbered=/^(?:option )?([1-9]\d*)$/.exec(line);
  const option=numbered?entry.request.options[Number(numbered[1])-1]:
    line.startsWith('id:')?entry.request.options.find(value=>value.id===line.slice(3)):undefined;
  return option&&{kind:'answered',payload:{optionId:option.id}};
}

/** Display only the actual request/options, with explicit numeric selection.
 * @param {PendingInput} entry @param {string} label
 */
function inputBlock(entry,label){
  const header=label+' ['+boundedText(entry.request.profileId,80)+'] ';
  if(entry.kind==='permission'){
    const request=entry.request,action=request.action;
    const detail=action?[action.title,action.kind,action.details,...(action.locations??[]).map(l=>l.path+(l.line!==undefined?':'+l.line:''))].filter(Boolean).join('\n  '):'';
    return header+'Permission requested\n  Resource: '+boundedText(request.resource)+
      (detail?'\n  '+boundedText(detail):'')+'\n'+request.options.map((option,i)=>
        '  '+(i+1)+'. '+(option.label??option.kind)+' [id='+option.id+']'+
        (option.scope?' · '+option.scope:'')).join('\n')+
      '\nSelect a displayed number or id:<exact option ID>. :cancel cancels this request.';
  }
  const form=projectForm(entry.request);
  return form?renderFormIntro(form,label)+renderFormField(form,0):header+'Native interaction unavailable';

}

/** Single terminal input owner; labels select existing pending requests, not grants.
 * @param {NodeJS.ReadableStream} input @param {NodeJS.WritableStream} output
 * @param {boolean} interactive @param {() => void} interrupt */
export function createCliInput(input, output, interactive, interrupt) {
  /** @typedef {{entry:PendingInput,finish:(result:InputResult)=>void,epoch:number,
   * form?:ReturnType<typeof projectForm>,draft?:ReturnType<typeof createFormDraft>,
   * signal:AbortSignal,validating?:boolean}} PendingLine
   * @type {Map<string,PendingLine>} */
  const pending = new Map();
  // Local, monotonic aliases and creation epochs are only terminal display identity.
  // They never replace the trusted request/attempt/owner correlation.
  let aliasSequence=0,epoch=0;
  /** @type {{epoch:number,target:string|undefined}|undefined} */
  let lineOrigin;
  /** @type {{epoch:number,target:string|undefined}[]} */
  const enteredLines=[];
  let previousCR=false;
  /** @param {Buffer|string} chunk */
  function capture(chunk){
    const data=Buffer.isBuffer(chunk)?chunk.toString('utf8'):String(chunk);
    for(const ch of data){
      if(ch==='\n'&&previousCR){previousCR=false;continue;}
      previousCR=ch==='\r';
      if(ch==='\r'||ch==='\n'){
        if(enteredLines.length>=128)enteredLines.shift();
        // An empty Enter still belongs to the only visibly active request at
        // the physical input event. Concurrent requests require an alias.
        const unique=pending.size===1?pending.keys().next().value:undefined;
        enteredLines.push(lineOrigin??{epoch,target:unique});
        lineOrigin=undefined;
      }else if(!lineOrigin){
        lineOrigin={epoch,target:pending.size===1?pending.keys().next().value:undefined};
      }
    }
  }
  /** @type {import('node:readline').Interface | undefined} */
  let rl;
  let eof = false;
  /** @type {Error | undefined} */
  let outputFailure;
  /** @type {Set<(error?:Error)=>void>} */
  const writes = new Set();
  /** @param {unknown} [error] */
  function broken(error) {
    outputFailure ??= error instanceof Error ? error : new Error('CLI presentation output unavailable');
    for (const settle of writes) settle(outputFailure);
    // No actionable prompt can be confirmed on a failed terminal. Do not
    // fabricate an approval or keep a user waiting for invisible input.
    for (const value of [...pending.values()]) value.finish({kind:'unavailable'});
  }
  output.on('error',broken);
  output.once('close',broken);
  function unavailable() {
    return !!outputFailure || !output.writable ||
      ('destroyed' in output && output.destroyed) || ('writableEnded' in output && output.writableEnded);
  }
  /** @type {string|undefined} */
  let chunkSource;
  let openLine=false;
  let atLineStart=true;
  const color=Boolean('isTTY' in output&&output.isTTY&&process.env.NO_COLOR===undefined&&process.env.TERM!=='dumb');
  /** @type {Map<string,ReturnType<typeof createTerminalSanitizer>>} */
  const sanitizers=new Map();
  /** @param {string} source */
  function sanitizerFor(source){
    let sanitizer=sanitizers.get(source);
    if(!sanitizer){
      if(sanitizers.size>=128){const first=sanitizers.keys().next().value;if(first!==undefined)sanitizers.delete(first);}
      sanitizer=createTerminalSanitizer();sanitizers.set(source,sanitizer);
    }
    return sanitizer;
  }
  /** @param {string} safe @param {PresentationTone} [tone] */
  function style(safe,tone) {
    if(!color||!tone||tone==='neutral')return safe;
    const code={header:'1;36',thinking:'2;3',tool:'36',finding:'1;33',error:'1;31',success:'32'}[tone];
    return '\x1b['+code+'m'+safe+'\x1b[0m';
  }
  /** A fulfilled callback confirms only the Writable boundary, not a human
   * reading the text. Delivery owns its existing bounded finish deadline.
   * @param {string} text @returns {Promise<void>}
   */
  function write(text) {
    if (unavailable()) {
      broken();
      return Promise.reject(outputFailure);
    }
    return new Promise((resolve,reject) => {
      /** @param {Error} [error] */
      const settle = error => {
        if (!writes.delete(settle)) return;
        if (error) reject(error);
        else resolve();
      };
      writes.add(settle);
      try {
        if (rl && interactive && 'isTTY' in output && output.isTTY) { clearLine(output, 0); cursorTo(output, 0); }
        output.write(text, error => { if (error) broken(error); else settle(); });
        if (rl) rl.prompt(true);
      } catch (error) { broken(error); }
    });
  }
  /** @param {string} text @param {PresentationTone} [tone] */
  function print(text,tone) {
    const prefix=openLine?'\n':'';
    openLine=false;chunkSource=undefined;atLineStart=true;
    return write(prefix+style(terminalText(text),tone)+'\n');
  }
  /** Local messages do not own a delivery receipt. Never recursively
   * report an output failure to the same failed stream.
   * @param {string} text
   */
  function report(text) { return print(text).catch(()=>{}); }
  /** @param {{source:string,header:string,text:string,indent?:string}} fragment */
  function printChunk(fragment) {
    // Readline owns its current input line. Use a technical line boundary
    // while editing instead of overwriting or buffering a native chunk.
    const changed=chunkSource!==fragment.source;
    const body=sanitizerFor(fragment.source).push(fragment.text);
    if(!fragment.indent){
      if(rl){chunkSource=fragment.source;return write(style(terminalText(fragment.header),'thinking')+body+'\n');}
      const text=(changed?(openLine?'\n':'')+style(terminalText(fragment.header),'thinking'):'')+body;
      chunkSource=fragment.source;
      if(text)openLine=!text.endsWith('\n');
      return write(text);
    }
    if(!body)return Promise.resolve();
    // A readline redraw creates a physical line boundary per write, not a new
    // semantic/source Thinking block. Only a real source change gets a header.
    const boundary=changed;
    if(boundary)atLineStart=true;
    let physicalStart=atLineStart||!!rl;
    let decorated='';
    for(const ch of body){
      if(physicalStart&&ch!=='\n')decorated+=fragment.indent;
      decorated+=ch;
      atLineStart=ch==='\n';
      physicalStart=ch==='\n';
    }
    const header=boundary?(openLine?'\n':'')+style(terminalText(fragment.header),'thinking'):'';
    const text=header+style(decorated,'thinking')+(rl&&!decorated.endsWith('\n')?'\n':'');
    chunkSource=fragment.source;
    openLine=!rl&&!atLineStart;
    return write(text);
  }
  /** @param {string} label @param {PendingLine} state */
  function nextForm(label,state){
    const form=state.form,draft=state.draft;
    if(!form||!draft)return;
    if(draft.index<form.fields.length){
      void print(renderFormField(form,draft.index),'header').catch(()=>{});
      return;
    }
    const issue=validateFormContent(form,draft.content);
    if(issue){void report('Invalid form: '+issue);draft.index=0;return;}
    state.finish({kind:'answered',payload:{action:'accept',content:{...draft.content}}});
  }
  /** @param {string} label @param {PendingLine} state @param {Record<string,unknown>} content @param {()=>void} finish */
  function confirmPatterns(label,state,content,finish){
    if(!state.form)return;
    state.validating=true;
    void validateFormPatterns(state.form,content,state.signal).then(result=>{
      if(pending.get(label)!==state||state.signal.aborted)return;
      state.validating=false;
      if(result.kind==='valid')finish();
      else if(result.kind!=='cancelled')void report(result.message??'Pattern validation unavailable; no answer sent.');
      prompt();
    }).catch(()=>{
      if(pending.get(label)===state&&!state.signal.aborted){
        state.validating=false;void report('Pattern validation unavailable; no answer sent.');prompt();
      }
    });
  }
  function prompt() {
    if (pending.size) {
      try {
        const singles=[...pending.entries()];
        const field=singles.length===1?singles[0][1].draft?.index:undefined;
        rl?.setPrompt('Reply (' + singles.map(([key])=>key).join(', ') + ')' + (field!==undefined?' field '+(field+1):'') + ': ');
        rl?.prompt();
      } catch(error) { broken(error); }
    }
  }
  function stopReader() {
    if(pending.size||!rl)return;
    const reader=rl;rl=undefined;chunkSource=undefined;
    input.removeListener('data',capture);
    enteredLines.length=0;lineOrigin=undefined;previousCR=false;
    reader.close();
  }
  function open() {
    if (rl) return;
    input.prependListener('data',capture);
    const reader = createInterface({input, output, terminal: Boolean('isTTY' in output && output.isTTY)});
    rl = reader;
    reader.on('line', line => {
      const origin=enteredLines.shift()??lineOrigin??{epoch:-1,target:undefined};
      lineOrigin=undefined;
      const explicit=/^(#\d+)\s+([\s\S]*)$/.exec(line);
      const label=explicit?explicit[1]:origin.target;
      const state=label?pending.get(label):undefined;
      if(!state||state.epoch>origin.epoch||(origin.target&&origin.target!==label)){
        void report('This input does not belong to an active request. Use the displayed request alias.');
        prompt();return;
      }
      const raw=explicit?explicit[2]:line;
      if(state.validating){
        void report('Validation is still pending for '+label+'. No response has been sent.');
        prompt();return;
      }
      if(state.entry.kind==='permission'){
        const result=parsePermission(state.entry,raw);
        if(result)state.finish(result);
        else void report('Invalid option for '+label+': enter a displayed position or id:<exact option ID>.');
      }else if(state.form&&state.draft){
        const {form,draft}=state;
        if(raw===':cancel'||raw===':decline'){
          state.finish({kind:'answered',payload:{action:raw.slice(1)}});
        }else if(raw.startsWith(':choices ')){
          const position=raw.slice(9);
          const field=form.fields[draft.index];
          const num=/^[1-9]\d*$/.test(position)?Number(position):NaN;
          if(!field?.options||!Number.isSafeInteger(num)||num<1||num>field.options.length){
            void report('Invalid choice page: enter :choices N for an offered choice position.');
          }else void print(renderFormField(form,draft.index,num-1),'header').catch(()=>{});
        }else if(raw===':back'){
          draft.index=Math.max(0,draft.index-1);
          void print(renderFormField(form,draft.index),'header').catch(()=>{});
        }else if(raw===':skip'){
          const field=form.fields[draft.index];
          if(field?.required)void report('Required field '+label+': cannot skip.');
          else if(field){delete draft.content[field.key];draft.index++;nextForm(label??'',state);}
          else void report('Use :submit to accept an empty form.');
        }else if(raw===':submit'&&form.fields.length===0){
          state.finish({kind:'answered',payload:{action:'accept',content:{}}});
        }else if(raw.startsWith(':json ')){
          try{
            const content=JSON.parse(raw.slice(6));
            const issue=content&&typeof content==='object'&&!Array.isArray(content)?
              validateFormContent(form,content):'expected an object';
            if(issue)void report('Form invalid: '+issue);
            else confirmPatterns(label,state,content,()=>state.finish({kind:'answered',payload:{action:'accept',content}}));
          }catch{void report('Form invalid: expected a JSON object after :json.');}
        }else{
          const field=form.fields[draft.index];
          if(!field){void report('No field selected; enter :submit.');}
          else {
            const parsed=formValue(raw,field);
            if(!parsed.ok)void report('Invalid '+label+' field '+(field.shape.title??field.key)+': '+parsed.error);
            else if(typeof field.shape.pattern==='string'){
              const check=Object.create(null);
              check[field.key]=parsed.value;
              confirmPatterns(label,state,check,()=>{
                draft.content[field.key]=parsed.value;draft.index++;nextForm(label??'',state);
              });
            }else{draft.content[field.key]=parsed.value;draft.index++;nextForm(label??'',state);}
          }
        }
      }
      prompt();
    });
    reader.once('close', () => {
      if (rl !== reader) return;
      rl = undefined; eof = true;
      input.removeListener('data',capture);enteredLines.length=0;lineOrigin=undefined;
      for (const entry of [...pending.values()]) entry.finish({kind:'unavailable'});
    });
    reader.on('SIGINT', () => {
      interrupt();
      for (const entry of [...pending.values()]) entry.finish({kind:'cancelled'});
    });
  }
  /** @param {PendingInput} entry @param {AbortSignal} signal @returns {Promise<InputResult>} */
  async function ask(entry, signal) {
    if (signal.aborted) return {kind:'cancelled'};
    if (!interactive || eof || unavailable() || (entry.kind === 'input' && !supportedForm(entry.request))) {
      void report(entry.kind === 'permission' ? 'Permission unavailable for ' + JSON.stringify(entry.request.resource) : 'Interaction unavailable: unsupported form or input');
      return {kind:'unavailable'};
    }
    if([...pending.values()].some(state=>state.entry.request.requestId===entry.request.requestId))return {kind:'unavailable'};
    const label='#'+ ++aliasSequence;
    if(openLine){void write('\n').catch(()=>{});openLine=false;chunkSource=undefined;}
    if(unavailable()) return {kind:'unavailable'};
    try { open(); } catch(error) { broken(error); return {kind:'unavailable'}; }
    return new Promise(resolve => {
      /** @param {InputResult} result */
      const finish = result => {
        if (!pending.delete(label)) return;
        signal.removeEventListener('abort', abort);
        resolve(result); stopReader();
      };
      const abort = () => finish({kind:'cancelled'});
      const form=entry.kind==='input'?projectForm(entry.request):undefined;
      pending.set(label,{entry,finish,epoch:++epoch,signal,...(form&&{form,draft:createFormDraft(form)})});
      signal.addEventListener('abort',abort,{once:true});
      if (signal.aborted) { abort(); return; }
      void print(inputBlock(entry,label),'header').catch(()=>{});
      prompt();
    });
  }
  return { ask, print, printChunk, report, resetPresentation(){sanitizers.clear();chunkSource=undefined;atLineStart=true;}, close() {
    for (const entry of [...pending.values()]) entry.finish({kind:'unavailable'});
    stopReader();
    sanitizers.clear();
    if(openLine){void write('\n').catch(()=>{});openLine=false;chunkSource=undefined;}
    // Leave the error guard on this terminal stream through outstanding writes;
    // the CLI process owns its lifetime, not the presentation consumer.
  }};
}

/** @param {InputResult} result @returns {Awaited<ReturnType<PermissionHandler>>} */
export function permissionResult(result) {
  if (result.kind === 'answered') {
    const option = object(result.payload).optionId;
    return typeof option === 'string' ? {kind:'selected',option} : {kind:'invalid'};
  }
  return {kind:result.kind};
}
/** @param {InputResult} result @returns {InteractionResult} */
export function interactionResult(result) { return result; }
