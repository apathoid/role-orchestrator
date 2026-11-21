import { boundedText } from './presentation.js';
/** @import {PresentationTone} from './presentation.js' */
/** @import {PendingPermission} from '../application/configuration/permissions.js' */
/** @import {PendingInteraction} from '../core/ports.js' */
/** @import {FormProjection} from './cli-form.js' */

/** @typedef {{text:string,tone?:PresentationTone}} Part */
/** @param {string} value @param {number} [limit] */
const short=(value,limit=1000)=>{
  // Clip *before* sanitizing the provider string to keep display work
  // bounded, but never leave the high half of an emoji at the boundary.
  const boundary=Math.min(value.length,limit);
  let end=boundary>0&&boundary<value.length&&
    value.charCodeAt(boundary-1)>=0xd800&&value.charCodeAt(boundary-1)<=0xdbff
    ?boundary-1:boundary;
  // A combining mark immediately after the boundary belongs to its base.
  // Move back to the base (within this already bounded display prefix) rather
  // than silently showing an unaccented character. This is not full Unicode
  // grapheme segmentation, and does not scan the original long string.
  const mark=/\p{M}/u;
  const next=end<value.length?value.codePointAt(end):undefined;
  if(next!==undefined&&mark.test(String.fromCodePoint(next))){
    while(end>0){
      end--;
      if(end>0&&value.charCodeAt(end)>=0xdc00&&value.charCodeAt(end)<=0xdfff&&
        value.charCodeAt(end-1)>=0xd800&&value.charCodeAt(end-1)<=0xdbff)end--;
      const code=value.codePointAt(end);
      if(code===undefined||!mark.test(String.fromCodePoint(code)))break;
    }
  }
  const safe=boundedText(value.slice(0,end),limit);
  return safe+(value.length>end?'… [display truncated] (more in :details)':'');
};
/** @param {Part[]} parts @param {string} text @param {PresentationTone} [tone] */
const add=(parts,text,tone='neutral')=>{if(text)parts.push({text,tone});};
/** @param {unknown} value @param {number} [limit] */
const named=(value,limit=240)=>short(String(value),limit).replace(/[\r\n\t]/g,' ');

/** Display-only structured ACP form projection; the native schema and draft
 * remain the only sources for validation/answer values.
 * @param {FormProjection} form @param {string} label @param {string} source
 * @param {PresentationTone} sourceTone @returns {Part[]} */
export function formIntroView(form,label,source,sourceTone){
  /** @type {Part[]} */
  const parts=[];
  add(parts,'? ','accent');add(parts,short(source,200),sourceTone);
  add(parts,' · '+label+' · Native question'+(form.title?' · '+short(form.title,240):''),'accent');
  if(form.message)add(parts,'\n'+short(form.message,2000));
  if(form.description)add(parts,'\n'+short(form.description,1000));
  return parts;
}

/** @param {FormProjection} form @param {number} index @param {number} [offset] @returns {Part[]} */
export function formFieldView(form,index,offset=0){
  /** @type {Part[]} */
  const parts=[];
  const field=form.fields[index];
  if(!field){add(parts,'No fields. Enter :submit to accept an empty response.','muted');return parts;}
  const shape=field.shape,caption=typeof shape.title==='string'?shape.title:
    typeof shape.description==='string'?shape.description:field.key;
  const type=shape.type==='array'?'choose multiple':shape.type==='string'&&!field.options?'text':String(shape.type);
  add(parts,'\n  '+(index+1)+'/'+form.fields.length+'  ','muted');
  add(parts,short(caption,1000),'bold');
  add(parts,' ('+type+(field.required?', required':', optional')+')','muted');
  if(typeof shape.description==='string'&&typeof shape.title==='string')add(parts,'\n  '+short(shape.description,1000));
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
  if(constraints.length)add(parts,'\n  '+constraints.join(' · '),'muted');
  if(shape.default!==undefined&&shape.default!==null){
    // Known default is only offered, never applied to the draft.
    const scalar=typeof shape.default==='string'||typeof shape.default==='number'||typeof shape.default==='boolean';
    add(parts,'\n  Offered default (not applied): '+(scalar?named(JSON.stringify(shape.default),240):'[complex value; :details]'),'muted');
  }
  const size=20,total=field.options?.length??0;
  const from=Math.min(Math.max(0,offset),Math.max(0,total-1));
  for(let i=from;i<Math.min(from+size,total);i++){
    const option=field.options?.[i];
    if(!option)continue;
    add(parts,'\n    '+(i+1)+'. ','accent');add(parts,named(option.label));
    if(option.description)add(parts,' — '+named(option.description,480),'muted');
  }
  if(total>size)add(parts,'\n  Showing '+(from+1)+'–'+Math.min(total,from+size)+' of '+total+
    ' choices. Enter :choices N to view starting at choice N.','muted');
  add(parts,field.options?'\n  Enter a displayed number'+(shape.type==='array'?' list separated by commas':'')+'.':
    '\n  Enter the value as text.','muted');
  if(!field.required)add(parts,'\n  :skip omits this field.','muted');
  add(parts,'\n  :back edits the preceding field; :decline or :cancel stops the form.','muted');
  return parts;
}

/** @param {PendingPermission} request @param {string} label @param {string} source
 * @param {PresentationTone} sourceTone @returns {Part[]} */
export function permissionIntroView(request,label,source,sourceTone){
  /** @type {Part[]} */
  const parts=[];
  add(parts,label+' · ','accent');add(parts,short(source,200),sourceTone);
  add(parts,' · Permission requested','accent');
  add(parts,'\n  Resource: '+short(request.resource,1000));
  const action=request.action;
  if(action){
    for(const field of [action.title,action.kind,action.details]){
      if(typeof field==='string'&&field)add(parts,'\n  '+short(field,1000));
    }
    const locations=action.locations??[];
    for(const loc of locations.slice(0,20))add(parts,'\n  '+short(loc.path,1000)+
      (loc.line!==undefined?':'+loc.line:''));
    if(locations.length>20)add(parts,'\n  Additional locations in :details.','muted');
  }
  return parts;
}

/** @param {PendingPermission} request @param {number} [offset] @returns {Part[]} */
export function permissionChoicesView(request,offset=0){
  /** @type {Part[]} */
  const parts=[];
  const count=request.options.length,start=Math.min(Math.max(0,offset),Math.max(0,count-1));
  for(let i=start;i<Math.min(start+20,count);i++){
    const option=request.options[i];
    add(parts,'\n  '+(i+1)+'. ','accent');
    add(parts,named(option.label??option.kind));
    add(parts,' [id='+named(option.id)+']'+(option.scope?' · '+named(option.scope):''),'muted');
  }
  if(count>20)add(parts,'\n  Showing '+(start+1)+'–'+Math.min(start+20,count)+' of '+count+
    ' options. Use :choices N to view starting at position N.','muted');
  add(parts,'\nSelect a displayed number or id:<exact option ID>. :cancel cancels this request. :details shows native metadata.','muted');
  return parts;
}
