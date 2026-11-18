import { projectForm, createFormDraft, formValue, validateFormContent, validateFormPatterns } from './cli-form.js';
import { formIntroView, formFieldView, permissionIntroView, permissionChoicesView } from './cli-input-view.js';
import { nativeDetailsPage } from './cli-details.js';
import { createInterface, clearLine, cursorTo } from 'node:readline';
import { terminalText, createTerminalSanitizer, boundedText } from './presentation.js';
import { terminalColor, styleText } from './cli-styling.js';

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

/** Display-only choice visibility for one rendered page; does not change native
 * option identities, broker authorization, or ACP replies.
 * @param {number} position One-based native option position
 * @param {number} offset Zero-based first displayed position */
const visibleChoice=(position,offset)=>Number.isSafeInteger(position)&&position>offset&&position<=offset+20;

/** Single terminal input owner; labels select existing pending requests, not grants.
 * @param {NodeJS.ReadableStream} input @param {NodeJS.WritableStream} output
 * @param {boolean} interactive @param {() => void} interrupt */
export function createCliInput(input, output, interactive, interrupt) {
  /** @typedef {{entry:PendingInput,finish:(result:InputResult)=>void,epoch:number,
   * form?:ReturnType<typeof projectForm>,draft?:ReturnType<typeof createFormDraft>,
   * signal:AbortSignal,validating?:boolean,validationAbort?:AbortController,
   * shownPermissionOffset?:number,shownFormOffset?:number}} PendingLine
   * @type {Map<string,PendingLine>} */
  const pending = new Map();
  /** Known invocation identity from the existing presentation facts, when delivered.
   * @type {(attemptId:string)=>string|undefined}
   */
  let sourceResolver=()=>undefined;
  /** @type {(attemptId:string)=>PresentationTone|undefined} */
  let sourceToneResolver=()=>undefined;
  /** @param {PendingInput} entry */
  const sourceFor=entry=>sourceResolver(entry.request.attemptId)??
    ('profile '+boundedText(entry.request.profileId,80)+' · role not recorded');
  /** @param {PendingInput} entry */
  const toneFor=entry=>sourceToneResolver(entry.request.attemptId)??'neutral';
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
  const color=terminalColor(output);
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
  function style(safe,tone) { return styleText(safe,tone,color); }
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
  /** Each trusted style is applied only after its untrusted text is sanitized.
   * @param {string | readonly {text:string,tone?:PresentationTone}[]} text @param {PresentationTone} [tone] */
  function print(text,tone) {
    const prefix=openLine?'\n':'';
    openLine=false;chunkSource=undefined;atLineStart=true;
    const parts=typeof text==='string'?[{text,tone}]:text;
    return write(prefix+parts.map(part=>style(terminalText(part.text),part.tone)).join('')+'\n');
  }
  /** Local messages do not own a delivery receipt. Never recursively
   * report an output failure to the same failed stream.
   * @param {string} text @param {PresentationTone} [tone]
   */
  function report(text,tone) { return print(text,tone).catch(()=>{}); }
  /** @param {{header:string,headerTone?:PresentationTone,sourceHeaderLength?:number}} fragment */
  function styledChunkHeader(fragment){
    if(fragment.sourceHeaderLength===undefined)return style(terminalText(fragment.header),fragment.headerTone??'thinking');
    const boundary=fragment.sourceHeaderLength;
    return style(terminalText(fragment.header.slice(0,boundary)),fragment.headerTone??'muted')+
      style(terminalText(fragment.header.slice(boundary)),'muted');
  }
  /** @param {{source:string,header:string,text:string,indent?:string,headerTone?:PresentationTone,sourceHeaderLength?:number}} fragment */
  function printChunk(fragment) {
    // Readline owns its current input line. Use a technical line boundary
    // while editing instead of overwriting or buffering a native chunk.
    const changed=chunkSource!==fragment.source;
    const body=sanitizerFor(fragment.source).push(fragment.text);
    if(!fragment.indent){
      if(rl){chunkSource=fragment.source;return write(styledChunkHeader(fragment)+body+'\n');}
      const text=(changed?(openLine?'\n':'')+styledChunkHeader(fragment):'')+body;
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
    const header=boundary?(openLine?'\n':'')+styledChunkHeader(fragment):'';
    const text=header+style(decorated,'thinking')+(rl&&!decorated.endsWith('\n')?'\n':'');
    chunkSource=fragment.source;
    openLine=!rl&&!atLineStart;
    return write(text);
  }
  /** Native schema projections are styled by original structured fields,
   * never by searching the already formatted text for semantic keywords.
   * @param {PendingInput} entry @param {string} label
   * @returns {{text:string,tone?:PresentationTone}[]} */
  function initialView(entry,label){
    const source=sourceFor(entry),tone=toneFor(entry);
    if(entry.kind==='permission')return [
      ...permissionIntroView(entry.request,label,source,tone),
      ...permissionChoicesView(entry.request),
    ];
    const form=projectForm(entry.request);
    return form?[...formIntroView(form,label,source,tone),...formFieldView(form,0)]:
      [{text:label+' · '+source+' · Native interaction unavailable',tone:'error'}];
  }
  /** Bounded diagnostic preview of the current form field or native
   * permission metadata. It does not claim to be the complete raw request.
   * @param {PendingLine} state @param {number} page */
  function requestDetails(state,page) {
    const field=state.draft&&state.form?.fields[state.draft.index];
    const value=state.entry.kind==='permission'
      ? {resource:state.entry.request.resource,action:state.entry.request.action,
        options:state.entry.request.options}
      : field?{key:field.key,required:field.required,shape:field.shape}
        : {payload:state.entry.request.payload};
    const label=state.entry.kind==='permission'?'Native permission details':
      field?'Current native field details':'Native request details';
    return nativeDetailsPage(value,page,label);
  }
  /** @param {string} label @param {PendingLine} state */
  function nextForm(label,state){
    const form=state.form,draft=state.draft;
    if(!form||!draft)return;
    if(draft.index<form.fields.length){
      state.shownFormOffset=0;
      void print(formFieldView(form,draft.index)).catch(()=>{});
      return;
    }
    const issue=validateFormContent(form,draft.content);
    if(issue){void report('Invalid form '+label+': '+issue,'error');draft.index=0;return;}
    state.finish({kind:'answered',payload:{action:'accept',content:{...draft.content}}});
  }
  /** @param {string} label @param {PendingLine} state @param {Record<string,unknown>} content @param {()=>void} finish */
  function confirmPatterns(label,state,content,finish){
    if(!state.form)return;
    const validation=new AbortController();
    state.validationAbort=validation;
    state.validating=true;
    void validateFormPatterns(state.form,content,validation.signal).then(result=>{
      if(pending.get(label)!==state||state.validationAbort!==validation||validation.signal.aborted)return;
      state.validationAbort=undefined;
      state.validating=false;
      if(result.kind==='valid')finish();
      else if(result.kind!=='cancelled')void report('Validation '+label+': '+(result.message??'Pattern validation unavailable; no answer sent.'),'error');
      prompt();
    }).catch(()=>{
      if(pending.get(label)===state&&state.validationAbort===validation&&!validation.signal.aborted){
        state.validationAbort=undefined;
        state.validating=false;
        void report('Validation '+label+': pattern validation unavailable; no answer sent.','error');prompt();
      }
    });
  }
  function prompt() {
    if (pending.size) {
      try {
        const singles=[...pending.entries()];
        const field=singles.length===1?singles[0][1].draft?.index:undefined;
        const plain='Reply (' + singles.map(([key])=>key).join(', ') + ')' +
          (field!==undefined?' field '+(field+1):'') + ': ';
        rl?.setPrompt(style(plain,'prompt'));
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
      // Terminal control commands outrank a pending technical validation.
      // The trusted request/line-origin check above still applies.
      if(state.form&&(raw===':cancel'||raw===':decline')){
        state.finish({kind:'answered',payload:{action:raw.slice(1)}});
        prompt();return;
      }
      if(state.validating){
        void report('Validation is still pending for '+label+'. No response has been sent.');
        prompt();return;
      }
      if(raw===':details'||/^:details [1-9]\d*$/.test(raw)){
        const page=raw===':details'?1:Number(raw.slice(9));
        void report(requestDetails(state,page),'muted');prompt();return;
      }
      if(state.entry.kind==='permission'){
        if(raw.startsWith(':choices ')){
          const position=raw.slice(9);
          const n=/^[1-9]\d*$/.test(position)?Number(position):NaN;
          if(!Number.isSafeInteger(n)||n>state.entry.request.options.length){
            void report('Invalid choice position for '+label+'. Use :choices N with an offered position.','error');
          }else {
            // The page is considered displayed only after this terminal
            // Writable has acknowledged it. A pasted ":choices N\nN" cannot
            // approve a still-unrendered broad-scope option.
            void print(permissionChoicesView(state.entry.request,n-1)).then(()=>{
              if(pending.get(label??'')===state)state.shownPermissionOffset=n-1;
            }).catch(()=>{});
          }
        }else{
          const numbered=/^(?:option )?([1-9]\d*)$/.exec(raw);
          const position=numbered?Number(numbered[1]):NaN;
          // Explicit id:<exact ID> remains a deliberate exact-ID selection;
          // only numeric positions imply that the CLI showed their terms.
          if(Number.isSafeInteger(position)&&position<=state.entry.request.options.length&&
             !visibleChoice(position,state.shownPermissionOffset??0)){
            void report('Option '+position+' has not been displayed for '+label+
              '. Use :choices '+position+' to inspect its label and scope before selecting.','error');
          }else{
            const result=parsePermission(state.entry,raw);
            if(result)state.finish(result);
            else void report('Invalid option for '+label+': enter a displayed position or id:<exact option ID>.','error');
          }
        }
      }else if(state.form&&state.draft){
        const {form,draft}=state;
        if(raw.startsWith(':choices ')){
          const position=raw.slice(9);
          const field=form.fields[draft.index];
          const num=/^[1-9]\d*$/.test(position)?Number(position):NaN;
          if(!field?.options||!Number.isSafeInteger(num)||num<1||num>field.options.length){
            void report('Invalid choice page: enter :choices N for an offered choice position.');
          }else {
            const shownIndex=draft.index;
            void print(formFieldView(form,shownIndex,num-1)).then(()=>{
              if(pending.get(label??'')===state&&state.draft?.index===shownIndex)
                state.shownFormOffset=num-1;
            }).catch(()=>{});
          }
        }else if(raw===':back'){
          draft.index=Math.max(0,draft.index-1);
          state.shownFormOffset=0;
          void print(formFieldView(form,draft.index)).catch(()=>{});
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
            else confirmPatterns(label??'',state,content,()=>state.finish({kind:'answered',payload:{action:'accept',content}}));
          }catch{void report('Form invalid: expected a JSON object after :json.');}
        }else{
          const field=form.fields[draft.index];
          if(!field){void report('No field selected; enter :submit.');}
          else {
            const values=field.options?
              (field.shape.type==='array'&&raw===':empty'?[]:
                field.shape.type==='array'?raw.split(',').map(x=>x.trim()):[raw.trim()]):[];
            const available=field.options?.length??0;
            const hidden=values.map(x=>/^[1-9]\d*$/.test(x)?Number(x):NaN).find(
              n=>Number.isSafeInteger(n)&&n<=available&&
                !visibleChoice(n,state.shownFormOffset??0));
            if(hidden!==undefined){
              void report('Choice '+hidden+' has not been displayed for '+label+
                '. Use :choices '+hidden+' to inspect it before selecting.','error');
              prompt();return;
            }
            const parsed=formValue(raw,field);
            if(!parsed.ok)void report('Invalid '+label+' field '+(field.shape.title??field.key)+': '+parsed.error);
            else if(typeof field.shape.pattern==='string'){
              const check=Object.create(null);
              check[field.key]=parsed.value;
              confirmPatterns(label??'',state,check,()=>{
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
        const state=pending.get(label);
        if(!state)return;
        pending.delete(label);
        // A resolved/cancelled request must not retain a regex worker or
        // accept its late result, regardless of the external AbortSignal.
        state.validationAbort?.abort();
        state.validationAbort=undefined;
        signal.removeEventListener('abort', abort);
        resolve(result); stopReader();
      };
      const abort = () => finish({kind:'cancelled'});
      const form=entry.kind==='input'?projectForm(entry.request):undefined;
      pending.set(label,{entry,finish,epoch:++epoch,signal,
        ...(entry.kind==='permission'?{shownPermissionOffset:0}:{shownFormOffset:0}),
        ...(form&&{form,draft:createFormDraft(form)})});
      signal.addEventListener('abort',abort,{once:true});
      if (signal.aborted) { abort(); return; }
      void print(initialView(entry,label)).catch(()=>{});
      prompt();
    });
  }
  return { ask, print, printChunk, report,
    /** @param {(attemptId:string)=>string|undefined} resolve */ 
    setSourceResolver(resolve){sourceResolver=resolve;},
    /** @param {(attemptId:string)=>PresentationTone|undefined} resolve */
    setSourceToneResolver(resolve){sourceToneResolver=resolve;},
    resetPresentation(){sanitizers.clear();chunkSource=undefined;atLineStart=true;}, close() {
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
