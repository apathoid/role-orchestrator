import { boundedText } from './presentation.js';
/** @import {ActivityEvent} from '../core/ports.js' */
/** @import {PresentationMode, PresentationTone} from './presentation.js' */
/** @typedef {{title?:string,kind?:string,command?:string,status?:string,location?:string,description?:string,
 * completionReported?:boolean,sequence:number,alias?:number,shownDetail?:string,rendered?:string}} ToolView */
/** @typedef {{text:string,tone:PresentationTone}} ToolLine */
const maxEntries=128,maxBytes=256*1024;
/** @param {unknown} value @returns {Record<string,unknown>} */
const obj=value=>value&&typeof value==='object'&&!Array.isArray(value)?/** @type {Record<string,unknown>} */(value):{};
/** @param {unknown} value */
const field=value=>typeof value==='string'?boundedText(value,480).replace(/[\n\t]/g,' '):undefined;
/** @param {string|undefined} status */
const terminal=status=>['completed','failed','cancelled','canceled','unknown'].includes(status??'');
/** @param {ToolView} view @param {PresentationMode} mode */
function detail(view,mode){
  const title=view.title||view.kind||'Tool (earlier details unavailable)';
  const command=view.command&&view.command!==title?' · '+view.command:'';
  return title+command+(mode!=='compact'&&view.location?' · '+view.location:'')+
    (mode!=='compact'&&view.description?' · '+view.description:'');
}
/** Presentation cache with local monotonic aliases; no tool state or trusted identity is written. */
export function createCliTools(){
  /** @type {Map<string,{view:ToolView,bytes:number}>} */
  const entries=new Map();let bytes=0,nextAlias=0;
  /** @param {string} key */
  function remove(key){const old=entries.get(key);if(old){bytes-=old.bytes;entries.delete(key);}}
  /** @param {string} key @param {ToolView} view */
  function retain(key,view){
    remove(key);
    const size=Buffer.byteLength(key)+Buffer.byteLength(JSON.stringify(view));
    if(size>maxBytes)return;
    while(entries.size>=maxEntries||bytes+size>maxBytes){
      const first=entries.keys().next().value;if(first===undefined)break;remove(first);
    }
    entries.set(key,{view,bytes:size});bytes+=size;
  }
  return {
    // Clearing does not reuse aliases within this live terminal session.
    clear(){entries.clear();bytes=0;},
    /** @param {ActivityEvent} event @param {PresentationMode} mode @returns {ToolLine|undefined} */
    accept(event,mode){
      const payload=obj(event.payload),item=obj(payload.item);
      const nativeId=event.nativeId;
      const key=typeof nativeId==='string'?JSON.stringify([event.operationId,event.attemptId,nativeId]):undefined;
      const prior=key!==undefined?entries.get(key)?.view:undefined;
      /** @type {ToolView} */
      const view={...prior,sequence:event.sequence};
      if(key!==undefined&&!prior)view.alias=++nextAlias;
      const fields={title:payload.title,kind:payload.kind??item.type,command:payload.command??item.command,
        status:payload.status??item.status,description:payload.description};
      for(const name of /** @type {(keyof typeof fields)[]} */(Object.keys(fields))){
        const value=fields[name];
        // Sparse/null optional ACP fields mean no new value, as in provider mapping.
        if(typeof value==='string')view[name]=field(value);
      }
      if(Array.isArray(payload.locations)){
        view.location=field(payload.locations.map(location=>{
          const loc=obj(location);return typeof loc.path==='string'?loc.path+(typeof loc.line==='number'?':'+loc.line:''):'';
        }).filter(Boolean).join(', '));
      }
      if(event.nativeKind==='item.completed'&&typeof fields.status!=='string')view.completionReported=true;
      else if(typeof fields.status==='string')delete view.completionReported;
      const outOfOrder=!!prior&&event.sequence<prior.sequence;
      const conflict=!!prior&&((terminal(prior.status)&&view.status!==prior.status)||
        (prior.completionReported&&typeof fields.status==='string'&&!terminal(view.status)));
      const content=detail(view,mode),changed=content!==prior?.shownDetail;
      const status=view.completionReported?'item completion reported (status not supplied'+
        (view.status?'; last status='+view.status:'')+')':view.status;
      const mark=view.status==='completed'&&!view.completionReported?'✓':view.status==='failed'&&!view.completionReported?'✗':'◇';
      const alias=view.alias!==undefined?'[T'+view.alias+']':'';
      const header=mode==='debug'||changed||!prior?.rendered?content:'';
      const fallback=!header&&view.alias===undefined?content:'';
      const body=alias?(alias+(header||fallback?' '+(header||fallback):'')):(header||fallback);
      const text=(outOfOrder||conflict?'! ':mark+' ')+body+
        (status?' · '+status:'')+(outOfOrder?' · out-of-order report':conflict?' · conflicting status report':'')+
        (mode==='debug'?' ['+[field(event.nativeKind),field(event.nativeId),'seq='+event.sequence].filter(Boolean).join(' ')+']':'');
      /** @type {PresentationTone} */
      const tone=outOfOrder||conflict||mark==='✗'?'error':mark==='✓'?'success':'tool';
      if(outOfOrder||conflict)return {text,tone};
      const genericPending=view.status==='pending'&&!view.command&&!view.location&&
        (!view.title||view.title.toLowerCase()===view.kind?.toLowerCase()||
          ['shell','tool','execute','read','write','search','glob','edit'].includes(view.title.toLowerCase()));
      const duplicate=mode!=='debug'&&!!prior&&prior.status===view.status&&
        prior.completionReported===view.completionReported&&content===prior.shownDetail;
      // Since alias is stable, a status-only line doesn't need repeated detail.
      const suppressed=mode!=='debug'&&((mode==='compact'&&genericPending&&key!==undefined)||duplicate);
      if(!suppressed){view.shownDetail=content;view.rendered=text;}
      if(key!==undefined)retain(key,view);
      return suppressed?undefined:{text,tone};
    },
  };
}
