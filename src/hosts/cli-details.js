import { terminalText } from './presentation.js';

/** Display-only bounded synchronous preview of decoded native JSON.
 * Fixed-key descriptors and bounded array indexing avoid V8's allocation for
 * enumerating all keys of very wide provider-controlled metadata objects.
 * This is deliberately a partial preview, not a replacement for native JSON
 * or a new limitation on provider actions/permissions. */
const maxChars=32000,maxNodes=512,maxDepth=24,maxString=12000,pageSize=2000;
/** Known technical fields of native form/permission JSON. This finite set is
 * a UI projection, never a native schema filter or authority. Unknown keys
 * may be omitted and are disclosed instead of being enumerated. */
const previewKeys=[
  'key','required','shape','resource','action','options','payload',
  'title','description','type','kind','details','locations','path','line','scope','id','label',
  'mode','message','requestedSchema','properties','value','const','oneOf','enum','anyOf','items',
  'minLength','maxLength','minimum','maximum','minItems','maxItems','pattern','format',
  'default','additionalProperties','annotations','metadata','name','text',
];
/** @param {string} text @param {number} limit */
function clip(text,limit){
  if(text.length<=limit)return text;
  const end=limit>0&&text.charCodeAt(limit-1)>=0xd800&&text.charCodeAt(limit-1)<=0xdbff?limit-1:limit;
  return text.slice(0,end);
}
/** @param {unknown} value */
export function boundedNativePreview(value){
  let length=0,nodes=0,omitted=false,partial=false;
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
      for(;i<current.length&&i<maxNodes&&length<maxChars&&nodes<maxNodes;i++){
        if(i)push(', ');
        try{
          const descriptor=Object.getOwnPropertyDescriptor(current,String(i));
          if(!descriptor){omitted=true;push('"[sparse entry not displayed]"');}
          else if('value' in descriptor)render(descriptor.value,depth+1);
          else{omitted=true;push('"[accessor not inspected]"');}
        }catch{omitted=true;push('"[metadata access unavailable]"');}
      }
      if(i<current.length){omitted=true;push(', "[additional entries not displayed]"');}
      push(']');return;
    }
    // We cannot establish exhaustiveness without an O(total keys)
    // enumeration. Restrict work to known native technical fields instead;
    // the caller explicitly discloses that other metadata may be omitted.
    partial=true;
    push('{');let added=0;
    for(const key of previewKeys){
      if(length>=maxChars||nodes>=maxNodes){omitted=true;break;}
      try{
        const descriptor=Object.getOwnPropertyDescriptor(current,key);
        if(!descriptor)continue;
        if(added++)push(', ');
        push(JSON.stringify(key)+': ');
        if('value' in descriptor)render(descriptor.value,depth+1);
        else{omitted=true;push('"[accessor not inspected]"');}
      }catch{
        omitted=true;
        if(added++)push(', ');
        push(JSON.stringify(key)+': "[metadata access unavailable]"');
      }
    }
    push('}');
  }
  render(value,0);
  return {text:terminalText(result.join('')),omitted,partial};
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
    (preview.partial?'\nOnly recognized native fields are previewed; other metadata may be omitted.':'')+
    (page<total?'\nUse :details '+(page+1)+' for the next page.':'');
}
