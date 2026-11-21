import { terminalText } from './presentation.js';
import { styleText } from './cli-styling.js';
/** @import {ColorCapability} from './cli-styling.js' */

const maxStyledAnswer=256*1024;
const maxStyledLine=16*1024;
const maxMarkupDelimiters=256;
const maxInlineDepth=8;

/** Safe, bounded subset of Markdown for authoritative *human TTY* display.
 * No HTML/OSC8 interpretation, network, scripts or semantic inference.
 * Unhandled and malformed constructs remain visible as text.
 * @param {string} line @param {ColorCapability} color @param {number} [depth]
 */
function inline(line,color,depth=0){
  if(depth>=maxInlineDepth)return line;
  let out='',at=0;
  while(at<line.length){
    const ch=line[at];
    if(ch==='\\'&&at+1<line.length){out+=line.slice(at,at+2);at+=2;continue;}
    if(ch==='\x60'){
      let ticks=1;while(line[at+ticks]==='\x60')ticks++;
      const marker='\x60'.repeat(ticks),end=line.indexOf(marker,at+ticks);
      if(end>=0){out+=styleText(line.slice(at+ticks,end),'code',color);at=end+ticks;continue;}
    }
    if(ch==='['&&at>0&&line[at-1]==='!'){out+=ch;at++;continue;}
    if(ch==='['){
      const end=line.indexOf(']',at+1);
      if(end>at+1&&line[end+1]==='('){
        let nesting=1,close=end+2;
        for(;close<line.length&&nesting>0;close++){
          if(line[close]==='(')nesting++;
          else if(line[close]===')')nesting--;
          if(nesting>4)break;
        }
        if(nesting===0){
          const href=line.slice(end+2,close-1);
          // Display the exact URL as inert text; no terminal hyperlink escapes.
          out+=styleText(inline(line.slice(at+1,end),color,depth+1),'link',color)+
            styleText(' ('+href+')','muted',color);
          at=close;continue;
        }
      }
    }
    // Plain identifiers (foo_bar, a*b, 2*3) are not formatting requests.
    // Avoid erasing punctuation from ordinary model-authored text.
    if(ch==='_'||ch==='*'){
      const left=line[at-1]??'',right=line[at+1]??'';
      if(/[\p{L}\p{N}]/u.test(left)&&/[\p{L}\p{N}]/u.test(right)){
        out+=ch;at++;continue;
      }
    }
    // Unsupported strikethrough stays literal rather than being presented as bold.
    const markers=ch==='*'?['**','*']:ch==='_'?['__','_']:[];
    let matched=false;
    for(const marker of markers){
      if(!line.startsWith(marker,at))continue;
      const end=line.indexOf(marker,at+marker.length);
      if(end<=at+marker.length)continue;
      const inner=line.slice(at+marker.length,end);
      if(!inner.trim())continue;
      const kind=marker==='*'||marker==='_'?'italic':'bold';
      out+=styleText(inline(inner,color,depth+1),kind,color);
      at=end+marker.length;matched=true;break;
    }
    if(matched)continue;
    out+=ch;at++;
  }
  return out;
}

/** Terminal style is not persisted: state/ACP/redirected stdout remain original.
 * @param {string} answer @param {ColorCapability} color */
export function renderMarkdownAnswer(answer,color) {
  const safe=terminalText(answer);
  if(color==='none'||safe.length>maxStyledAnswer)return safe;
  // Failed delimiter lookups can otherwise become quadratic on adversarial or
  // simply malformed model output. Fall back *without losing any content*.
  const lines=safe.split('\n');
  if(lines.some(line=>line.length>maxStyledLine))return safe;
  let tokens=0;
  for(const ch of safe){
    if(ch==='['||ch==='*'||ch==='_'||ch==='~'||ch==='\x60'){
      if(++tokens>maxMarkupDelimiters)return safe;
    }
  }
  let fence;
  let result='';
  for(let i=0;i<lines.length;i++){
    const line=lines[i];
    if(i)result+='\n';
    const open=/^ {0,3}(\x60{3,}|~{3,})([^\n]*)$/.exec(line);
    if(fence){
      if(open&&open[1][0]===fence.marker&&open[1].length>=fence.length){
        result+=styleText(line,'muted',color);fence=undefined;
      }else result+=styleText(line,'code',color);
      continue;
    }
    if(open){
      fence={marker:open[1][0],length:open[1].length};
      result+=styleText(line,'muted',color);continue;
    }
    const heading=/^ {0,3}(#{1,6})[ \t]+(.+?)\s*#*\s*$/.exec(line);
    if(heading){result+=styleText(inline(heading[2],color),'heading',color);continue;}
    if(/^ {0,3}(?:-{3,}|\*{3,}|_{3,})[ \t]*$/.test(line)){
      result+=styleText(line,'muted',color);continue;
    }
    const quote=/^(\s*>[ \t]?)(.*)$/.exec(line);
    if(quote){result+=styleText(quote[1],'muted',color)+inline(quote[2],color);continue;}
    const list=/^(\s*(?:[-+*]|\d+[.)])[ \t]+)(.*)$/.exec(line);
    if(list){result+=styleText(list[1],'accent',color)+inline(list[2],color);continue;}
    result+=inline(line,color);
  }
  return result;
}
