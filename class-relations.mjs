import {instanceKey} from './type-names.mjs';
export const classParameters=c=>c.params||[c.param];
export const instanceHeads=i=>i.heads||[i.head];
export const relationKey=ts=>ts.map(t=>instanceKey(t)||(t.tag==='param'?'*':null)).every(Boolean)?ts.map(t=>instanceKey(t)||'*').join('|'):null;
export const superConstraints=c=>c.superConstraints||(c.supers||[]).map(name=>({name,args:[{tag:'param',name:c.param}]}));
export function substitute(t,bindings){
 if(t?.tag==='param')return bindings.get(t.name)||t;
 if(Array.isArray(t))return t.map(x=>substitute(x,bindings));
 if(t&&typeof t==='object')return Object.fromEntries(Object.entries(t).map(([k,v])=>[k,substitute(v,bindings)]));
 return t;
}
export function ancestorArguments(classes,c,args,name){
 if(c.name===name)return args;
 const bindings=new Map(classParameters(c).map((p,i)=>[p,args[i]]));
 for(const sc of superConstraints(c)){const result=ancestorArguments(classes,classes.get(sc.name),sc.args.map(t=>substitute(t,bindings)),name);if(result)return result;}
 return null;
}
export function lookupInstance(c,args){
 const key=relationKey(args);
 return (key&&c.instances.get(key))||[...c.instances.values()].find(i=>instanceHeads(i).every((h,n)=>h.tag==='param'||instanceKey(h)===instanceKey(args[n])));
}
export function builtinConversion(args){
 const [a,b]=args;if(!a||!b||a.tag!=='atom'||b.tag!=='atom')return false;
 return ['int','float','byte','char'].includes(a.name)&&['int','float','byte','char'].includes(b.name);
}

export function syntaxSource(t){
 if(t.tag==='param'||t.tag==='atom')return t.name;
 if(t.tag==='adt')return '( '+[t.name,...t.args.map(syntaxSource)].join(' ')+' )';
 if(t.tag==='list')return '[ '+syntaxSource(t.item)+' ]';
 if(t.tag==='tuple')return '#( '+t.items.map(syntaxSource).join(' ')+(t.tail?' | '+t.tail:'')+' )';
 if(t.tag==='record')return '{ '+t.fields.map(([k,v])=>k+' : '+syntaxSource(v)).join(' , ')+(t.tail?' | '+t.tail:'')+' }';
 if(t.tag==='stream')return 'stream '+syntaxSource(t.item)+' '+syntaxSource(t.block);
 return '{ '+t.input.map(syntaxSource).join(' ')+' -> '+(t.never?'!':t.output.map(syntaxSource).join(' '))+(t.effects?' / { '+t.effects.map(e=>[e.name,...e.args.map(syntaxSource)].join(' ')).join(' , ')+(t.effectTail?' | '+t.effectTail:'')+' }':'')+' }';
}
