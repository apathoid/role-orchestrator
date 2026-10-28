// Provider-neutral per-invocation tool observations. Only numeric aggregates
// are exposed; tool IDs are transient and are never included in snapshots.
export const TOOL_KINDS = Object.freeze(['read','edit','delete','move','search','execute','think','fetch','switch_mode','other','unknown']);
const KINDS = new Set(TOOL_KINDS);
const TERMINAL = new Set(['completed','failed','cancelled']);
const MAX_TOOLS=2048, MAX_COUNT=100_000, MAX_CONTENT=50_000_000;
const bounded = (n,max=MAX_COUNT) => Math.min(max,Math.max(0,n));
const own = (o,k) => Object.prototype.hasOwnProperty.call(o,k);
const validSize = n => Number.isSafeInteger(n) && n>=0 && n<=MAX_CONTENT;

export function createToolMetricsAccumulator() {
  const tools=new Map();
  let events=0, updates=0, truncated=false, invalidEvents=0;
  function observe(event, now) {
    if (events===MAX_COUNT) truncated=true;
    events=bounded(events+1); updates=bounded(updates+1);
    if (!event || event.type!=='tool_observation' || typeof event.toolId!=='string' || !event.toolId || event.toolId.length>256 || !['upsert','append_content'].includes(event.operation) || !Number.isSafeInteger(now) || now<0) {
      invalidEvents=bounded(invalidEvents+1);return;
    }
    let row=tools.get(event.toolId);
    if (!row) {
      if (tools.size>=MAX_TOOLS) { truncated=true;return; }
      row={firstSeen:now,runningAt:null,terminalAt:null,kind:'unknown',kindSource:'unknown',status:null,
        chars:null,bytes:null,coverage:'none',contentSeen:false};
      tools.set(event.toolId,row);
    }
    if (own(event,'kind')) {
      if (event.kind===null) { row.kind='unknown';row.kindSource='unknown'; }
      else if (KINDS.has(event.kind) && (event.kindSource==='declared' || row.kindSource!=='declared')) {
        row.kind=event.kind;row.kindSource=event.kind==='unknown'?'unknown':event.kindSource==='inferred'?'inferred':'declared';
      }
    }
    if (own(event,'status')) {
      if (event.status===null) row.status=null;
      else if (typeof event.status==='string' && !TERMINAL.has(row.status)) {
        row.status=event.status;
        if (event.status==='in_progress' && row.runningAt===null) row.runningAt=now;
        if (TERMINAL.has(event.status) && row.terminalAt===null) row.terminalAt=now;
      }
    }
    const content=event.content;
    if (content && ['replace','append','clear'].includes(content.semantics)) {
      const known=validSize(content.textCharacters)&&validSize(content.textUtf8Bytes);
      const coverage=['complete','partial','unknown'].includes(content.coverage)?content.coverage:'unknown';
      row.contentSeen=true;
      if (content.semantics==='clear') {row.chars=0;row.bytes=0;row.coverage='complete';}
      else if (content.semantics==='replace') {
        row.chars=known?content.textCharacters:null;row.bytes=known?content.textUtf8Bytes:null;row.coverage=known?coverage:'unknown';
      } else if (row.chars!==null && known) {
        const chars=row.chars+content.textCharacters, bytes=row.bytes+content.textUtf8Bytes;
        row.chars=validSize(chars)?chars:null;row.bytes=validSize(bytes)?bytes:null;
        row.coverage=row.chars===null||row.coverage==='unknown'||coverage==='unknown'?'unknown':row.coverage==='partial'||coverage==='partial'?'partial':'complete';
      } else if (row.coverage==='none' && known) {row.chars=content.textCharacters;row.bytes=content.textUtf8Bytes;row.coverage=coverage;}
      else {row.chars=null;row.bytes=null;row.coverage='unknown';}
    }
  }
  function snapshot() {
    const categories=Object.fromEntries(TOOL_KINDS.map(k=>[k,0]));
    let completed=0,failed=0,cancelled=0,incomplete=0,lifecycleMs=0,runningMs=0,lifecycleCount=0,runningCount=0;
    let contentChars=0,contentBytes=0,contentKnown=true,contentObserved=0,contentPartial=0,contentUnknown=0,kindDeclared=0,kindInferred=0;
    for (const state of tools.values()) {
      categories[state.kind]++;
      if (state.kindSource==='declared') kindDeclared++;
      if (state.kindSource==='inferred') kindInferred++;
      if (state.status==='completed') completed++;
      else if (state.status==='failed') failed++;
      else if (state.status==='cancelled') cancelled++;
      else incomplete++;
      if (state.terminalAt!==null && state.terminalAt>state.firstSeen) {lifecycleMs+=state.terminalAt-state.firstSeen;lifecycleCount++;}
      if (state.terminalAt!==null && state.runningAt!==null && state.terminalAt>=state.runningAt) {runningMs+=state.terminalAt-state.runningAt;runningCount++;}
      if (state.contentSeen) {
        if (state.coverage==='partial') contentPartial++;
        if (state.coverage==='unknown') contentUnknown++;
        if (state.chars===null || state.bytes===null) contentKnown=false;
        else {contentChars+=state.chars;contentBytes+=state.bytes;contentObserved++;}
      }
    }
    return {
      version:2, calls:tools.size, events, updates, completed,failed,cancelled,incomplete,
      kinds:Object.fromEntries(Object.entries(categories).filter(([,n])=>n>0)),
      kindCoverage:{declared:kindDeclared,inferred:kindInferred,unknown:tools.size-kindDeclared-kindInferred},
      lifecycleMs:bounded(lifecycleMs,10_000_000),lifecycleCoverage:lifecycleCount,
      runningMs:bounded(runningMs,10_000_000),runningCoverage:runningCount,
      contentCharacters:contentKnown&&(contentObserved>0||tools.size===0)?bounded(contentChars,MAX_CONTENT):null,
      contentUtf8Bytes:contentKnown&&(contentObserved>0||tools.size===0)?bounded(contentBytes,MAX_CONTENT):null,
      contentCoverage:{observed:contentObserved,partial:contentPartial,unknown:contentUnknown,notObserved:[...tools.values()].filter(x=>!x.contentSeen).length},
      invalidEvents,truncated,
    };
  }
  return {observe,snapshot,counters:()=>({calls:tools.size,events,updates,truncated})};
}

// Compatibility with in-process/fake providers sending the older minimal
// event shape. Production ACP adapters always provide normalized observations.
export function legacyToolObservation(update) {
  if (!update || typeof update!=='object' || typeof update.toolCallId!=='string' || !update.toolCallId) return null;
  const result={type:'tool_observation',toolId:update.toolCallId,operation:'upsert'};
  const known=new Set(TOOL_KINDS);
  if (known.has(update.kind)) {result.kind=update.kind;result.kindSource='declared';}
  else if (typeof update.name==='string') {
    const inf = /^(read_file|open_file)$/i.test(update.name)?'read': /^(write_file|edit_file)$/i.test(update.name)?'edit':null;
    if (inf) {result.kind=inf;result.kindSource='inferred';}
  }
  if (typeof update.status==='string') result.status=update.status;
  return result;
}
