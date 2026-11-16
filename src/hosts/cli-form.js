import { checkPattern } from './cli-pattern.js';
import { boundedText } from './presentation.js';
/** @import {PendingInteraction} from '../core/ports.js' */
/** @typedef {{key:string,shape:Record<string,unknown>,required:boolean,options?:{value:string,label:string,description?:string}[]}} FormField */
/** @typedef {{message:string,title?:string,description?:string,fields:FormField[]}} FormProjection */
/** @param {unknown} value @returns {Record<string,unknown>} */
const obj=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)?/** @type {Record<string,unknown>} */(value):{};
/** @param {unknown} value */
const str=value=>typeof value==='string'?value:undefined;
/** @param {unknown} value @param {number} [limit] */
const named=(value,limit=240)=>boundedText(String(value),limit).replace(/[\r\n\t]/g,' ');

/** ACP SDK 2.4.0 v1 restricted elicitation fields; unrecognized annotations are display-opaque.
 * @param {PendingInteraction} request @returns {FormProjection|undefined}
 */
export function projectForm(request){
  const payload=obj(request.payload),schema=obj(payload.requestedSchema);
  if(payload.mode!=='form'||(schema.type!==undefined&&schema.type!=='object')||
    !schema.properties||typeof schema.properties!=='object'||Array.isArray(schema.properties))return;
  const required=schema.required;
  if(required!=null&&(!Array.isArray(required)||required.some(x=>typeof x!=='string')))return;
  const props=obj(schema.properties),fields=[];
  if(Object.keys(props).length>128)return;
  if(required?.some(key=>!Object.hasOwn(props,key)))return;
  for(const [key,original] of Object.entries(props)){
    const shape=obj(original),type=shape.type;
    if(!['string','number','integer','boolean','array'].includes(String(type)))return;
    /** @type {FormField['options']} */
    let options;
    if(type==='string'){
      if(shape.oneOf!=null){
        if(!Array.isArray(shape.oneOf)||shape.oneOf.some(x=>!obj(x)||typeof obj(x).const!=='string'||typeof obj(x).title!=='string'))return;
        options=shape.oneOf.map(x=>{const o=obj(x);return {value:/** @type {string} */(o.const),
          label:/** @type {string} */(o.title),...(str(o.description)&&{description:str(o.description)})};});
      }else if(shape.enum!=null){
        if(!Array.isArray(shape.enum)||shape.enum.some(x=>typeof x!=='string'))return;
        options=shape.enum.map(value=>({value,label:value}));
      }
      // Even syntax compilation is deferred to the technical validation worker.
      // A valid but expensive provider expression must not execute on the main thread.
      if(shape.pattern!=null&&typeof shape.pattern!=='string')return;
      if(shape.format!=null&&!['email','uri','date','date-time'].includes(String(shape.format)))return;
      if(!validNonnegative(shape.minLength)||!validNonnegative(shape.maxLength))return;
    }else if(type==='array'){
      const items=obj(shape.items);
      if(items.anyOf!=null){
        if(!Array.isArray(items.anyOf)||items.anyOf.some(x=>typeof obj(x).const!=='string'||typeof obj(x).title!=='string'))return;
        options=items.anyOf.map(x=>{const o=obj(x);return {value:/** @type {string} */(o.const),
          label:/** @type {string} */(o.title),...(str(o.description)&&{description:str(o.description)})};});
      }else if(items.type==='string'&&Array.isArray(items.enum)&&items.enum.every(x=>typeof x==='string')){
        options=items.enum.map(value=>({value,label:value}));
      }else return;
      if(!validNonnegative(shape.minItems)||!validNonnegative(shape.maxItems))return;
    }else if(type==='number'||type==='integer'){
      if(!validNumber(shape.minimum)||!validNumber(shape.maximum))return;
    }
    if(options&&new Set(options.map(x=>x.value)).size!==options.length)return;
    fields.push({key,shape,required:Array.isArray(required)&&required.includes(key),...(options&&{options})});
  }
  return {message:str(payload.message)??'',title:str(schema.title),description:str(schema.description),fields};
}
/** @param {unknown} n */
const validNonnegative=n=>n==null||(typeof n==='number'&&Number.isSafeInteger(n)&&n>=0);
/** @param {unknown} n */
const validNumber=n=>n==null||(typeof n==='number'&&Number.isFinite(n));

/** The bound form draft is ephemeral; only original keys and typed values are retained. */
export function createFormDraft(/** @type {FormProjection} */ form){
  /** @type {Record<string,string|number|boolean|string[]>} */
  const content={};
  return {content,index:0};
}
/** @param {FormProjection} form @param {number} index */
export function renderFormField(form,index){
  const field=form.fields[index];
  if(!field)return 'No fields. Enter :submit to accept an empty response.';
  const shape=field.shape;
  const caption=str(shape.title)??str(shape.description)??field.key;
  const description=str(shape.description)&&str(shape.title)?'\n  '+boundedText(str(shape.description)??'',1000):'';
  const type=shape.type==='array'?'choose multiple':shape.type==='string'&&!field.options?'text':shape.type;
  const constraints=[
    typeof shape.minLength==='number'?'min '+shape.minLength+' characters':undefined,
    typeof shape.maxLength==='number'?'max '+shape.maxLength+' characters':undefined,
    typeof shape.minimum==='number'?'min '+shape.minimum:undefined,
    typeof shape.maximum==='number'?'max '+shape.maximum:undefined,
    typeof shape.minItems==='number'?'choose at least '+shape.minItems:undefined,
    typeof shape.maxItems==='number'?'choose at most '+shape.maxItems:undefined,
    typeof shape.pattern==='string'?'pattern '+named(shape.pattern,160):undefined,
    typeof shape.format==='string'?'format '+shape.format:undefined,
  ].filter(Boolean);
  const choices=field.options?.map((v,i)=>'\n    '+(i+1)+'. '+named(v.label)+
    (v.description?' — '+named(v.description,480):'')).join('')??'';
  return '\n  '+(index+1)+'/'+form.fields.length+'  '+boundedText(caption,1000)+' ('+type+
    (field.required?', required':', optional')+')'+description+
    (constraints.length?'\n  '+constraints.join(' · '):'')+
    (shape.default!==undefined&&shape.default!==null?'\n  Offered default (not applied): '+named(JSON.stringify(shape.default),240):'')+
    choices+
    (field.options?'\n  Enter a displayed number'+(shape.type==='array'?' list separated by commas':'')+'.':'\n  Enter the value as text.')+
    (!field.required?'\n  :skip omits this field.':'')+
    '\n  :back edits the preceding field; :decline or :cancel stops the form.';
}
/** @param {FormProjection} form @param {string} label */
export function renderFormIntro(form,label){
  return label+' · Native question'+(form.title?' · '+boundedText(form.title,240):'')+
    '\n'+(form.message?boundedText(form.message,2000):'')+
    (form.description?'\n'+boundedText(form.description,1000):'');
}
/** @param {string} input @param {FormField} field @returns {{ok:true,value:string|number|boolean|string[]}|{ok:false,error:string}} */
export function formValue(input,field){
  const shape=field.shape;
  /** @type {string|number|boolean|string[]} */
  let value;
  if(field.options){
    const source=shape.type==='array'?input.split(',').map(part=>part.trim()):[input.trim()];
    const selections=shape.type==='array'&&input===':empty'?[]:source;
    const selected=[];
    for(const part of selections){
      const n=/^[1-9]\d*$/.test(part)?Number(part):NaN;
      if(!Number.isSafeInteger(n)||n<1||n>field.options.length)return {ok:false,error:'choose a displayed option number'};
      selected.push(field.options[n-1].value);
    }
    if(new Set(selected).size!==selected.length)return {ok:false,error:'duplicate selection'};
    value=shape.type==='array'?selected:selected[0];
  }else if(shape.type==='string')value=input.startsWith('::')?input.slice(1):input;
  else if(shape.type==='boolean'){
    if(input!=='true'&&input!=='false')return {ok:false,error:'enter true or false'};
    value=input==='true';
  }else if(shape.type==='integer'||shape.type==='number'){
    if(!input.trim()||!Number.isFinite(Number(input)))return {ok:false,error:'enter a finite '+shape.type};
    value=Number(input);
    if(shape.type==='integer'&&!Number.isSafeInteger(value))return {ok:false,error:'enter a safe integer'};
  }else return {ok:false,error:'unsupported field'};
  const invalid=validateFormValue(value,field);
  return invalid?{ok:false,error:invalid}:{ok:true,value};
}
/** @param {unknown} value @param {FormField} field @returns {string|undefined} */
export function validateFormValue(value,field){
  const shape=field.shape,type=shape.type;
  if(type==='array'){
    if(!Array.isArray(value)||value.some(x=>typeof x!=='string'))return 'must be a list of strings';
    if(typeof shape.minItems==='number'&&value.length<shape.minItems)return 'select at least '+shape.minItems;
    if(typeof shape.maxItems==='number'&&value.length>shape.maxItems)return 'select at most '+shape.maxItems;
    if(new Set(value).size!==value.length)return 'duplicate selection';
    if(value.some(x=>!field.options?.some(y=>y.value===x)))return 'value not offered by the request';
  }else if(type==='string'){
    if(typeof value!=='string')return 'must be text';
    const length=[...value].length;
    if(typeof shape.minLength==='number'&&length<shape.minLength)return 'text is shorter than '+shape.minLength;
    if(typeof shape.maxLength==='number'&&length>shape.maxLength)return 'text exceeds '+shape.maxLength;
    if(field.options&&!field.options.some(x=>x.value===value))return 'value not offered by the request';
    if(typeof shape.format==='string'&&!validFormat(value,shape.format))return 'invalid '+shape.format;
  }else if(type==='number'||type==='integer'){
    if(typeof value!=='number'||!Number.isFinite(value)||(type==='integer'&&!Number.isSafeInteger(value)))return 'invalid '+type;
    if(typeof shape.minimum==='number'&&value<shape.minimum)return 'number below minimum '+shape.minimum;
    if(typeof shape.maximum==='number'&&value>shape.maximum)return 'number above maximum '+shape.maximum;
  }else if(type==='boolean'&&typeof value!=='boolean')return 'must be true or false';
}
/** @param {string} value @param {string} format */
function validFormat(value,format){
  if(format==='email')return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);
  if(format==='uri'){try{const url=new URL(value);return !!url.protocol;}catch{return false;}}
  if(format==='date'){
    if(!/^\d{4}-\d{2}-\d{2}$/u.test(value))return false;
    const [y,m,d]=value.split('-').map(Number);
    return m>=1&&m<=12&&d>=1&&d<=new Date(Date.UTC(y,m,0)).getUTCDate();
  }
  if(format==='date-time')return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)&&Number.isFinite(Date.parse(value));
  return false;
}
/** @param {FormProjection} form @param {Record<string,unknown>} content */
export function validateFormContent(form,content){
  const fieldNames=new Set(form.fields.map(x=>x.key));
  for(const name of Object.keys(content))if(!fieldNames.has(name))return 'unexpected field '+name;
  for(const field of form.fields){
    if(!Object.hasOwn(content,field.key)){
      if(field.required)return field.key+' is required';
      continue;
    }
    const error=validateFormValue(content[field.key],field);
    if(error)return field.key+': '+error;
  }
}


/** A fully completed validation is distinct from user mismatch and technical uncertainty.
 * @param {FormProjection} form @param {Record<string,unknown>} content @param {AbortSignal} [signal]
 * @returns {Promise<{kind:'valid'|'invalid'|'cancelled'|'unavailable',message?:string}>}
 */
export async function validateFormPatterns(form,content,signal){
  for(const field of form.fields){
    if(signal?.aborted)return {kind:'cancelled'};
    const pattern=field.shape.pattern;
    if(typeof pattern!=='string'||!Object.hasOwn(content,field.key))continue;
    const value=content[field.key];
    if(typeof value!=='string')return {kind:'invalid',message:field.key+': must be text'};
    const outcome=await checkPattern(pattern,value,signal);
    if(outcome==='match')continue;
    if(outcome==='mismatch')return {kind:'invalid',message:field.key+': text does not match required pattern'};
    if(outcome==='cancelled')return {kind:'cancelled'};
    return {kind:'unavailable',message:field.key+': '+({
      invalid_pattern:'provider pattern syntax is invalid',timeout:'pattern validation timed out',
      resource_limit:'pattern validation resource limit reached',
      unavailable:'pattern validation unavailable',
    }[outcome]??'pattern validation could not be confirmed')+
      '; no answer was sent'};
  }
  return {kind:'valid'};
}
