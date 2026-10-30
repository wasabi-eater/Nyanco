import {lex} from '../language.mjs';
export const names=new Map([['and','.&.'],['or','.|.'],[':=','<-'],['map','vmap'],['filter','vfilter'],['toList','toVector'],...['takeWhile','skipWhile','take','skip','flatMap','flatten'].map(n=>[n,'v'+n]),...['map','filter','takeWhile','skipWhile','take','skip','flatMap','flatten'].map(n=>['s'+n,n])]);
export function migrate(source){
 const lines=source.split('\n'),starts=[0];for(let i=0;i<lines.length-1;i++)starts.push(starts.at(-1)+lines[i].length+1);
 const edits=lex(source).filter(t=>t.kind==='word'&&names.has(t.value)).map(t=>({start:starts[t.line-1]+t.col-1,end:starts[t.endLine-1]+t.endCol-1,value:names.get(t.value)}));
 for(const e of edits.reverse())source=source.slice(0,e.start)+e.value+source.slice(e.end);return source;
}
export function migrateNodes(value,seen=new Set()){
 if(!value||typeof value!=='object'||seen.has(value))return value;seen.add(value);
 if(['word','binary'].includes(value.kind)&&names.has(value.value))value.value=names.get(value.value);
 if(value instanceof Map)for(const [old,next] of [['and','.&.'],['or','.|.']]){const m=value.get(old);if(m?.className){value.delete(old);m.name=next;value.set(next,m);}}
 if(value.implementations instanceof Map)for(const [old,next] of [['and','.&.'],['or','.|.']])if(value.implementations.has(old)){value.implementations.set(next,value.implementations.get(old));value.implementations.delete(old);}
 if(Array.isArray(value))value.forEach(v=>migrateNodes(v,seen));else if(value instanceof Map)for(const v of value.values())migrateNodes(v,seen);else Object.values(value).forEach(v=>migrateNodes(v,seen));return value;
}
