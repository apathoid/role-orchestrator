import { boundedText } from './presentation.js';

/** @import {ActivityEvent} from '../core/ports.js' */
/** @import {PresentationMode, PresentationTone} from './presentation.js' */
/** @typedef {{title?:string,kind?:string,command?:string,status?:string,location?:string,description?:string,sequence:number,rendered?:string}} ToolView */
/** @typedef {{text:string,tone:PresentationTone}} ToolLine */
const maxEntries=128,maxBytes=256*1024;
/** @param {unknown} value @returns {Record<string,unknown>} */
const object=value=>value&&typeof value==='object'&&!Array.isArray(value)?/** @type {Record<string,unknown>} */(value):{};
/** @param {unknown} value */
const field=value=>typeof value==='string'?boundedText(value,480).replace(/[\n\t]/g,' '):undefined;
/** @param {string|undefined} status */
const terminal=status=>['completed','failed','cancelled','canceled','unknown'].includes(status??'');
/** @param {ToolView} view */
function label(view){
  const title=view.title||view.kind||'Tool (earlier details unavailable)';
  const command=view.command&&view.command!==title?' · '+view.command:'';
  return title+command;
}
/** @param {ToolView} view @param {PresentationMode} mode @param {ActivityEvent} event @param {string} [note] @returns {ToolLine} */
function line(view,mode,event,note){
  const status=view.status,ok=status==='completed',failed=status==='failed';
  const mark=ok?'✓':failed?'✗':'◇';
  const text=(note?'! ':mark+' ')+label(view)+(status?' · '+status:'')+
    (mode!=='compact'&&view.location?' · '+view.location:'')+
    (mode!=='compact'&&view.description?' · '+view.description:'')+
    (note?' · '+note:'')+
    (mode==='debug'?' ['+[field(event.nativeKind),field(event.nativeId),'seq='+event.sequence].filter(Boolean).join(' ')+']':'');
  return {text,tone:note||failed?'error':ok?'success':'tool'};
}

/** CLI-only, bounded cache of supplied display fields. No execution state or raw payload retention. */
export function createCliTools(){
  /** @type {Map<string,{view:ToolView,bytes:number}>} */
  const entries=new Map();let bytes=0;
  /** @param {string} key */
  function remove(key){const old=entries.get(key);if(old){bytes-=old.bytes;entries.delete(key);}}
  /** @param {string} key @param {ToolView} view */
  function retain(key,view){
    remove(key);const size=Buffer.byteLength(key)+Buffer.byteLength(JSON.stringify(view));
    if(size>maxBytes)return;
    while(entries.size>=maxEntries||bytes+size>maxBytes){
      const first=entries.keys().next().value;if(first===undefined)break;remove(first);
    }
    entries.set(key,{view,bytes:size});bytes+=size;
  }
  return {
    clear(){entries.clear();bytes=0;},
    /** @param {ActivityEvent} event @param {PresentationMode} mode @returns {ToolLine|undefined} */
    accept(event,mode){
      const payload=object(event.payload),item=object(payload.item);
      const nativeId=event.nativeId;
      // Do not truncate an identity into another identity.
      const key=nativeId!==undefined?JSON.stringify([event.operationId,event.attemptId,nativeId]):undefined;
      const prior=key!==undefined?entries.get(key)?.view:undefined;
      /** @type {ToolView} */
      const view={...prior,sequence:event.sequence};
      /** @type {Record<'title'|'kind'|'command'|'status'|'description',unknown>} */
      const fields={title:payload.title,kind:payload.kind??item.type,command:payload.command??item.command,
        status:payload.status??item.status,description:payload.description};
      for(const name of /** @type {(keyof typeof fields)[]} */(Object.keys(fields))){
        const value=fields[name];if(value===null)delete view[name];else if(typeof value==='string')view[name]=field(value);
      }
      if(Array.isArray(payload.locations)){
        view.location=field(payload.locations.map(location=>{const loc=object(location);return typeof loc.path==='string'?loc.path+(typeof loc.line==='number'?':'+loc.line:''):'';}).filter(Boolean).join(', '));
      }
      if(prior&&event.sequence<prior.sequence)return line(view,mode,event,'out-of-order report');
      if(prior&&terminal(prior.status)&&view.status!==prior.status)return line(view,mode,event,'conflicting status report');
      const result=line(view,mode,event);
      const genericPending=view.status==='pending'&&!view.command&&!view.location&&
        (!view.title||view.title.toLowerCase()===view.kind?.toLowerCase()||
          ['shell','tool','execute','read','write','search','glob','edit'].includes(view.title.toLowerCase()));
      const duplicate=prior?.rendered===result.text;
      // Debug retains all actual delivered events; other modes omit exact no-op display updates.
      if(mode!=='debug'&&((mode==='compact'&&genericPending)||duplicate)){
        if(key!==undefined)retain(key,view);return;
      }
      view.rendered=result.text;
      if(key!==undefined)retain(key,view);
      return result;
    },
  };
}
