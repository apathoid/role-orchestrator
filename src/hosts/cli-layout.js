/** Decorative indentation for *human terminal output only*. It changes no
 * source text, native payload, ACP wire, persisted answer or machine stream.
 * Width is advisory: terminal wrapping belongs to the terminal, not Host.
 * @param {object} output */
export function terminalMarginColumns(output) {
  if(!('isTTY' in output)||output.isTTY!==true)return 0;
  const width='columns' in output?output.columns:undefined;
  if(typeof width!=='number'||!Number.isFinite(width)||width<=0)return 1;
  return width>=60?2:width>=30?1:0;
}

/** Incremental terminal-only line indentation. ANSI SGR emitted by our own
 * renderer has zero display width. Do not parse/provider-propagate controls;
 * the callers already use existing terminal sanitization and trusted styles.
 * @returns {{format:(text:string,columns:number)=>string}} */
export function createTerminalMargin() {
  let lineStart=true;
  return {
    format(text,columns){
      if(!text)return text;
      const margin=' '.repeat(Math.min(2,Math.max(0,columns)));
      let result='',from=0;
      for(;;){
        const end=text.indexOf('\n',from);
        const segment=text.slice(from,end<0?text.length:end);
        // Trusted ANSI styling can precede (or straddle) a text fragment.
        // Only truly empty/SGR-only fragments are not a display line yet.
        const displayed=segment.replace(/\x1b\[[0-9;]*m/g,'');
        if(lineStart&&displayed.length&&margin)result+=margin;
        result+=segment;
        if(displayed.length)lineStart=false;
        if(end<0)break;
        result+='\n';lineStart=true;from=end+1;
      }
      return result;
    },
  };
}
