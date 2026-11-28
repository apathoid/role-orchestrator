import { open, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { parseDocument } from 'yaml';

/** @typedef {{name:string,description:string,path:string,source:'project'|'global'}} AgentSkill */
const metadataBytes=32*1024;
const skillName=/^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/** Read only a bounded frontmatter prefix; do not execute or load skill bodies.
 * @param {string} path @param {AgentSkill['source']} source @returns {Promise<AgentSkill|undefined>}
 */
async function metadata(path,source) {
  try {
    const file=await open(path,constants.O_RDONLY|constants.O_NONBLOCK);
    try {
      if(!(await file.stat()).isFile())return;
      const bytes=Buffer.alloc(metadataBytes);
      const {bytesRead}=await file.read(bytes,0,bytes.length,0);
      const lines=bytes.subarray(0,bytesRead).toString('utf8').replace(/^\uFEFF/u,'').split(/\r?\n/u);
      if(lines[0]!=='---')return;
      const end=lines.findIndex((line,index)=>index>0&&line==='---');
      if(end<0)return;
      const doc=parseDocument(lines.slice(1,end).join('\n'),{uniqueKeys:true,strict:true,schema:'core'});
      if(doc.errors.length||doc.warnings.length)return;
      const data=doc.toJS({maxAliasCount:0});
      if(!data||typeof data!=='object'||typeof data.name!=='string'||!skillName.test(data.name)||data.name.length>64||
        typeof data.description!=='string'||!data.description.trim()||data.description.length>1024)return;
      return {name:data.name,description:data.description,path,source};
    }finally{await file.close();}
  }catch{return undefined;}
}

/** @param {string} root @param {AgentSkill['source']} source */
async function directory(root,source) {
  const entries=await readdir(root,{withFileTypes:true}).catch(()=>[]);
  const skills=[];
  for(const entry of entries)if(entry.isDirectory()||entry.isSymbolicLink()) {
    const value=await metadata(join(root,entry.name,'SKILL.md'),source);
    if(value)skills.push(value);
  }
  return skills;
}

/** Discovery is convenience, never a provider/skill admission inventory.
 * @param {string} cwd @param {string} [home]
 */
export async function discoverAgentSkills(cwd,home=homedir()) {
  const global=await directory(resolve(home,'.agents','skills'),'global');
  const project=await directory(resolve(cwd,'.agents','skills'),'project');
  /** @type {Map<string,AgentSkill>} */
  const commands=new Map();
  for(const list of [global,project]) {
    for(const name of new Set(list.map(item=>item.name))) {
      const matches=list.filter(item=>item.name===name);
      if(matches.length===1)commands.set(name,matches[0]);
      else commands.delete(name);
    }
  }
  return {commands:[...commands.values()].sort((a,b)=>a.name.localeCompare(b.name)),files:[...global,...project]};
}

/** Explicit shortcut name or exact discovered path, not arbitrary slash text.
 * @param {string} cwd @param {string} selection @param {string} [home]
 */
export async function selectAgentSkill(cwd,selection,home) {
  const {commands,files}=await discoverAgentSkills(cwd,home);
  if(isAbsolute(selection))return files.find(item=>item.path===selection);
  return commands.find(item=>item.name===selection);
}
