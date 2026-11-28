import { createHash } from 'node:crypto';

/** @import {Operation} from '../core/operation.js' */
/** @import {ContentSegment} from '../core/contracts.js' */
/** @import {UserAttachment,OrderedTurn} from '../core/ports.js' */
export const defaultUserContentMaxBytes=16*1024*1024;
export const maximumUserContentMaxBytes=64*1024*1024;
/** @param {number} bytes */
export const userContentFrameBytes=bytes=>Math.ceil(bytes/3)*4+2*1024*1024;
/** @typedef {{ref:string,size:number,originalSize:number,truncated:false}} PayloadRef */
/** @typedef {{kind:'accepted',input:unknown,payloads:{bytes:Uint8Array,reference:PayloadRef}[]}|{kind:'rejected',path:string,reason:string}} Prepared */
/** @param {unknown} v @returns {v is Record<string,unknown>} */
const object=v=>!!v&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
/** @param {unknown} input @param {number} [maxBytes] @returns {Prepared} */
export function prepareUserContent(input,maxBytes=defaultUserContentMaxBytes){
  if(!object(input)||input.content===undefined)return {kind:'accepted',input,payloads:[]};
  /** @param {string} path @param {string} reason @returns {Prepared} */
  const reject=(path,reason)=>({kind:'rejected',path,reason});
  if(typeof input.requestId!=='string'||!Array.isArray(input.content)||!input.content.length)return reject('$.content','Expected ordered content and request id');
  if(input.text!==undefined||Array.isArray(input.attachments)&&input.attachments.length)return reject('$.content','Use either ordered content or legacy text/attachments');
  /** @type {ContentSegment[]} */ const content=[];
  /** @type {{bytes:Uint8Array,reference:PayloadRef}[]} */ const payloads=[];
  let text='',total=0;
  for(const [index,block] of input.content.entries()){
    const path='$.content['+index+']';
    if(!object(block))return reject(path,'Expected content object');
    const allowed=block.kind==='text'?['kind','text','metadata']:['kind','data','encoding','mediaType','uri','metadata'];
    if(Object.keys(block).some(key=>!allowed.includes(key)))return reject(path,'Unknown content field');
    const metadata=block.metadata;
    if(metadata!==undefined){
      try {total+=Buffer.byteLength(JSON.stringify(metadata));}catch{return reject(path+'.metadata','Expected JSON metadata');}
    }
    if(block.kind==='text'){
      if(typeof block.text!=='string')return reject(path+'.text','Expected text');
      const start=text.length;text+=block.text;total+=Buffer.byteLength(block.text);
      content.push({kind:'text',start,end:text.length,metadata});
    }else{
      const kind=block.kind;
      if(kind!=='image'&&kind!=='audio'&&kind!=='resource'&&kind!=='link')return reject(path+'.kind','Unsupported content kind');
      const uri=typeof block.uri==='string'&&block.uri?block.uri:undefined;
      const mediaType=typeof block.mediaType==='string'&&block.mediaType?block.mediaType:kind==='link'||kind==='resource'?'application/octet-stream':undefined;
      if(!mediaType||(kind==='resource'||kind==='link')&&!uri)return reject(path,'Missing MIME or resource URI');
      total+=Buffer.byteLength(mediaType)+Buffer.byteLength(uri??'');
      if(kind==='image'&&!mediaType.startsWith('image/')||kind==='audio'&&!mediaType.startsWith('audio/'))return reject(path+'.mediaType','MIME does not match content kind');
      /** @type {PayloadRef|undefined} */ let payload;
      /** @type {'utf8'|'binary'|undefined} */ let encoding;
      if(kind==='link'){
        if(block.data!==undefined||block.encoding!==undefined)return reject(path,'Reference must not include embedded data');
      }else{
        if(typeof block.data!=='string'||(block.encoding!=='utf8'&&block.encoding!=='binary'))return reject(path,'Expected embedded data and encoding');
        encoding=block.encoding;
        if(kind!=='resource'&&encoding!=='binary')return reject(path,'Image/audio require binary encoding');
        if(encoding==='binary'&&block.data.length>Math.ceil(maxBytes/3)*4)return reject(path+'.data','Oversized base64');
        const bytes=Buffer.from(block.data,encoding==='binary'?'base64':'utf8');
        if(encoding==='binary'&&bytes.toString('base64')!==block.data)return reject(path+'.data','Invalid base64');
        total+=bytes.length;
        payload={ref:'sha256:'+createHash('sha256').update(bytes).digest('hex'),size:bytes.length,originalSize:bytes.length,truncated:false};
        payloads.push({bytes,reference:payload});
      }
      const ref='user-content:'+createHash('sha256').update(JSON.stringify([input.requestId,index])).digest('hex');
      content.push({kind,ref,mediaType,uri,payload,encoding,metadata});
    }
    if(total>maxBytes)return reject(path,'User content exceeds '+maxBytes+' decoded bytes');
  }
  return {kind:'accepted',input:{...input,...('schemaVersion' in input&&{attachments:[]}),text,content},payloads};
}
/** @param {Operation} operation @returns {OrderedTurn[]} */
export function orderedTurns(operation){
  return [operation.request,...operation.events.flatMap(event=>event.kind==='operation.continued'?[event.input]:[])].flatMap(turn=>turn.content?[{requestId:turn.requestId,text:turn.text,content:turn.content}]:[]);
}
/** @param {Operation} operation @returns {UserAttachment[]} */
export function userAttachments(operation){
  return [...operation.request.attachments,...orderedTurns(operation).flatMap(turn=>turn.content.filter(item=>item.kind!=='text'))];
}

/** Project ordered historical turns using the existing Controller history selection,
 * not a new semantic selection mechanism. Reserve the latest accepted input first.
 * @param {readonly OrderedTurn[]} turns @param {string} latestId
 * @param {ReadonlySet<string>} represented @param {number} limit @param {boolean} supported
 */
export function projectOrderedTurns(turns,latestId,represented,limit,supported){
  /** @type {{requestId:string,refs:string[],reason:string}[]} */ const omitted=[];
  /** @type {OrderedTurn[]} */ const selected=[];
  let remaining=limit;
  for(const turn of [...turns].reverse()){
    const required=turn.requestId===latestId;
    const refs=turn.content.flatMap(item=>item.kind==='text'?[]:[item.ref]);
    const bytes=Buffer.byteLength(turn.text)+turn.content.reduce((total,item)=>total+
      (item.kind==='text'?0:(item.payload?.size??0)+Buffer.byteLength(item.mediaType)+Buffer.byteLength(item.uri??''))+Buffer.byteLength(JSON.stringify(item.metadata??null)),0);
    const reason=!supported?'adapter_unsupported':!required&&!represented.has(turn.requestId)?'not_projected':
      !required&&bytes>remaining?'input_budget':undefined;
    if(reason){omitted.push({requestId:turn.requestId,refs,reason});continue;}
    selected.unshift({...turn,required});
    remaining-=bytes;
  }
  return {selected,omitted};
}
