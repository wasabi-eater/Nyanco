import {createInterface} from 'node:readline';
import {renderHighlight} from './syntax-highlight.mjs';

const colors={comment:90,string:32,escape:36,number:33,keyword:35,type:36,constructor:36,stack:95,operator:93,label:94};
export const highlight = source => renderHighlight(source, (kind,text) =>
  kind ? `\x1b[${colors[kind]}m${text}\x1b[0m` : text);

export function createReplInterface({input,output,color=Boolean(input.isTTY&&output.isTTY)&&!('NO_COLOR' in process.env)&&process.env.TERM!=='dumb'}) {
  const rl=createInterface({input,output,terminal:Boolean(input.isTTY&&output.isTTY)});
  if(!color||!rl.terminal)return rl;
  // Use readline's own display-width and cursor handling, with ANSI only at output.
  const write=rl._writeToOutput;
  let refreshing=false;
  rl._writeToOutput=function(text){
    if(refreshing){
      const prompt=this.getPrompt();
      return write.call(this,text===prompt+this.line?prompt+highlight(this.line):text);
    }
    if(this.line&&text&&!/[\x00-\x1f\x7f]/.test(text)){
      refreshing=true;try{this._refreshLine();}finally{refreshing=false;}
      return;
    }
    return write.call(this,text);
  };
  return rl;
}
