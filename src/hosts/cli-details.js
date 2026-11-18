import { terminalText } from './presentation.js';

/** Display-only, bounded synchronous preview of a native JSON-shaped value.
 * No whole-payload JSON.stringify, unbounded Object.entries, eager schema copy,
 * or setter/getter invocation. Omitted content is explicitly labeled, and
 * no reply/permission payload is changed. */
const maxChars=32000,maxNodes=512,maxDepth=24,maxString=12000,pageSize=2000;
/** @param {string} text @param {number} limit */
function clip(text,limit){
  if(text.length<=limit)return text;
  const end=limit>0&&text.charCodeAt(limit-1)>=0xd800&&text.charCodeAt(limit-1)<=0xdbff?limit-1:limit;
  return text.slice(0,end);
}
/** @param {unknown} value */
export function boundedNativePreview(value){
  let length=0,nodes=0,omitted=false;
  /** @type {string[]} */
  const result=[];
  /** @param {string} str */
  function push(str){
    if(length>=maxChars){omitted=true;return;}
    const fragment=clip(str,maxChars-length);
    result.push(fragment);length+=fragment.length;
    if(fragment.length!==str.length)omitted=true;
  }
  const seen=new WeakSet();
  /** @param {unknown} current @param {number} depth */
  function render(current,depth){
    if(++nodes>maxNodes||depth>maxDepth||length>=maxChars){
      omitted=true;push('"[nested detail omitted from preview]"');return;
    }
    if(current===null){push('null');return;}
    if(typeof current==='string'){
      const fragment=clip(current,maxString);
      if(fragment.length!==current.length)omitted=true;
      push(JSON.stringify(fragment));
      if(fragment.length!==current.length)push(' /* remaining string not displayed */');
      return;
    }
    if(typeof current==='number'||typeof current==='boolean'){push(JSON.stringify(current)??'null');return;}
    if(typeof current!=='object'){push('"[unsupported metadata type]"');omitted=true;return;}
    if(seen.has(current)){push('"[repeated object not displayed]"');omitted=true;return;}
    seen.add(current);
    if(Array.isArray(current)){
      push('[');let i=0;
      for(;i<current.length&&length<maxChars&&nodes<maxNodes;i++){
        if(i)push(', ');
        render(current[i],depth+1);
      }
      if(i<current.length){omitted=true;push(', "[additional entries not displayed]"');}
      push(']');return;
    }
    push('{');let i=0;
    // for-in visits only as many own keys as the bounded preview requires.
    // Reading own data descriptors avoids running provider-supplied getters.
    for(const key in current){
      if(!Object.hasOwn(current,key))continue;
      if(length>=maxChars||nodes>=maxNodes){omitted=true;break;}
      const descriptor=Object.getOwnPropertyDescriptor(current,key);
      if(!descriptor)continue;
      if(i++)push(', ');
      const rawKey=clip(key,512);
      if(rawKey.length!==key.length)omitted=true;
      push(JSON.stringify(rawKey)+': ');
      if('value' in descriptor)render(descriptor.value,depth+1);
      else{omitted=true;push('"[accessor not inspected]"');}
    }
    if(omitted&&i>=maxNodes)push(', "[additional properties not displayed]"');
    push('}');
  }
  render(value,0);
  return {text:terminalText(result.join('')),omitted};
}
/** @param {string} text @param {number} page */
function pageSlice(text,page){
  let start=(page-1)*pageSize,end=Math.min(page*pageSize,text.length);
  if(start>0&&text.charCodeAt(start)>=0xdc00&&text.charCodeAt(start)<=0xdfff&&
    text.charCodeAt(start-1)>=0xd800&&text.charCodeAt(start-1)<=0xdbff)start--;
  if(end<text.length&&text.charCodeAt(end-1)>=0xd800&&text.charCodeAt(end-1)<=0xdbff&&
    text.charCodeAt(end)>=0xdc00&&text.charCodeAt(end)<=0xdfff)end--;
  return text.slice(start,end);
}
/** @param {unknown} value @param {number} page @param {string} label */
export function nativeDetailsPage(value,page,label){
  if(!Number.isSafeInteger(page)||page<1||page>Math.ceil(maxChars/pageSize)+2)
    return 'Details page outside bounded preview. Native request remains unchanged.';
  const preview=boundedNativePreview(value);
  const total=Math.max(1,Math.ceil(preview.text.length/pageSize));
  if(page>total)return 'No further preview pages. Native request remains unchanged.';
  return label+' · '+(preview.omitted?'bounded preview':'current native data')+' · page '+page+'/'+total+
    '\n'+pageSlice(preview.text,page)+
    (preview.omitted?'\nSome native metadata is not displayed in the CLI preview; the original request is unchanged.':'')+
    (page<total?'\nUse :details '+(page+1)+' for the next page.':'');
}
