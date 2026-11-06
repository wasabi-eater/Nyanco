const keywords=new Set('import as pub open data class instance effect type deriving where case otherwise handle mask borrow mut with below do end'.split(' '));
const types=new Set('int float byte char string bool vector stream range option result dict deque heap set mutref continuation'.split(' '));

// Tolerant of unfinished input; always preserve the original text exactly.
export function renderHighlight(source, paint) {
  let i=0;
  function code(stop=false) {
    let out='';
    while(i<source.length){
      const rest=source.slice(i),c=source[i];
      if(stop&&c==='}'){i++;return out+paint('operator','}');}
      if(rest.startsWith('--')){const end=source.indexOf('\n',i),n=end<0?source.length:end;out+=paint('comment',source.slice(i,n));i=n;continue;}
      const char=rest.match(/^'(?:[^'\\\r\n]|\\(?:[nrt0'"\\]|u\{[0-9a-fA-F]+\}))'/u);
      if(char){out+=paint('string',char[0]);i+=char[0].length;continue;}
      if(c==='"'){out+=string();continue;}
      if(/^\\[ \t]*(?:\r?\n|$)/.test(rest)){out+=paint('escape',c);i++;continue;}
      if(c==='{'){out+=paint('operator',c);i++;out+=code(true);continue;}
      const match=rest.match(/^(?:@[a-zA-Z_][a-zA-Z0-9_]*|\$+\d*|_+\d*(?![a-zA-Z0-9_'])|'[a-z][a-zA-Z0-9_']*|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[a-zA-Z_][a-zA-Z0-9_']*|\.<<\.|\.>>\.|\.&\.|\.\|\.|\.\.=|\.\.|=>|->>|->|<<-|<-|::|==|\/=|<=|>=|\+\+|\?\?<-|\?\?=|\?\?|&&|\|\||[~?:|!+*/%\^<>=-])/);
      if(!match){out+=paint(null,c);i++;continue;}
      const text=match[0];i+=text.length;
      const kind=keywords.has(text)?'keyword':types.has(text)||text.startsWith("'")?'type':/^[A-Z]/.test(text)?'constructor':/^\d/.test(text)?'number':/^[_$~]/.test(text)&&/^[_$~]+\d*$/.test(text)?'stack':text.startsWith('@')?'label':/^[a-zA-Z_]/.test(text)?null:'operator';
      out+=paint(kind,text);
    }
    return out;
  }
  function string(){
    let out=paint('string','"');i++;
    while(i<source.length){
      const c=source[i++];
      if(c==='\\'){const next=source[i]??'';i+=next.length;out+=paint('escape',c+next);continue;}
      if(c==='{'){out+=paint('operator',c)+code(true);continue;}
      out+=paint('string',c);if(c==='"')break;
    }
    return out;
  }
  const command=source.match(/^\s*:(?:[a-z]+|[{}])/);
  if(command){i=command[0].length;return paint('keyword',command[0])+code();}
  return code();
}
