/** Terminal-only presentation policy. Source identity never grants authority. */
/** @import {ExecutionFact} from '../application/execution-facts.js' */
/** @import {PresentationTone} from './presentation.js' */
/** @typedef {'none'|'16'|'256'|'truecolor'} ColorCapability */

/** @type {Record<string, [string, number, string]>} */
const colors = {
  controller: ['86;182;255',117,'1;34'],
  'worker-0': ['185;160;245',141,'1;35'],
  'worker-1': ['127;206;160',114,'1;32'],
  'worker-2': ['111;203;212',80,'1;36'],
  'worker-3': ['227;169;231',182,'1;35'],
  'worker-4': ['214;197;130',180,'1;33'],
  'worker-5': ['196;169;240',177,'1;35'],
  accent: ['241;188;101',215,'1;33'],
  muted: ['147;154;165',246,'2;37'],
  heading: ['210;221;241',189,'1;37'],
  code: ['168;208;177',151,'32'],
  link: ['111;203;212',80,'4;36'],
  error: ['246;136;137',210,'1;31'],
  success: ['127;206;160',114,'32'],
  tool: ['111;203;212',80,'36'],
};

/** @param {NodeJS.WritableStream} output @param {NodeJS.ProcessEnv} [env] @returns {ColorCapability} */
export function terminalColor(output,env=process.env) {
  if(!('isTTY' in output) || !output.isTTY || env.NO_COLOR!==undefined || env.TERM==='dumb')return 'none';
  if(/truecolor|24bit/i.test(env.COLORTERM??''))return 'truecolor';
  if(/256color/i.test(env.TERM??''))return '256';
  return '16';
}

/** Choose a stable palette entry from a *trusted* roleId; no known Worker names. 
 * @param {ExecutionFact} fact @returns {PresentationTone} */
export function sourceTone(fact) {
  if(fact.invocationKind==='controller')return 'controller';
  if(typeof fact.roleId!=='string'||!fact.roleId)return 'neutral';
  let hash=2166136261;
  for(const ch of fact.roleId)hash=Math.imul(hash^(ch.codePointAt(0)??0),16777619)>>>0;
  return /** @type {PresentationTone} */ ('worker-'+(hash%6));
}

/** Input must already be terminal-sanitized. Only trusted styles create ANSI.
 * @param {string} safe @param {PresentationTone|undefined} tone @param {ColorCapability} capability */
export function styleText(safe,tone,capability) {
  if(!safe||capability==='none'||!tone||tone==='neutral')return safe;
  // Retain the established generic CLI indicator tones across color modes.
  // Only trusted source/accent identities consume the capability palette.
  if(tone==='header')return '\x1b[1;36m'+safe+'\x1b[0m';
  if(tone==='success')return '\x1b[32m'+safe+'\x1b[0m';
  if(tone==='error')return '\x1b[1;31m'+safe+'\x1b[0m';
  if(tone==='finding')return '\x1b[1;33m'+safe+'\x1b[0m';
  if(tone==='thinking'||tone==='italic')return '\x1b[2;3m'+safe+'\x1b[0m';
  if(tone==='bold')return '\x1b[1m'+safe+'\x1b[0m';
  if(tone==='header')tone='heading';
  if(tone==='finding'||tone==='prompt')tone='accent';
  const color=colors[tone];
  if(!color)return safe;
  const prefix=capability==='truecolor'?'38;2;'+color[0]:capability==='256'?'38;5;'+color[1]:color[2];
  return '\x1b['+prefix+'m'+safe+'\x1b[0m';
}
