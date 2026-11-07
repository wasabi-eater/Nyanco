// Conservative affine flow analysis. Only fresh vector allocations and local
// last uses can own storage. Escapes, aliases and unknown calls lose ownership.
export function vectorOwnership(definitions,nodes,{local=false}={}) {
 const reusable=new WeakSet(),visited=new WeakSet();
 const escape=v=>{if(v)v.unique=false;};
 function unit(body,locals=false){
  if(visited.has(body))return;visited.add(body);
  const remaining=new Map();
  function count(value){if(!value||typeof value!=='object')return;if(value.kind==='word')remaining.set(value.value,(remaining.get(value.value)||0)+1);for(const [key,v] of Object.entries(value)){if(key==='patterns')continue;if(Array.isArray(v))v.forEach(count);else if(v&&typeof v==='object')count(v);}}
  body.forEach(count);walk(body,[],new Map(),remaining,locals);
 }
 function walk(body,stack,env,remaining,locals){
  const pop=()=>stack.pop()||null,forget=()=>{stack.forEach(escape);for(const x of env.values())escape(x);stack.length=0;};
  for(const n of body){
   if(n.kind==='application'){walk([...n.body.slice(1),n.body[0]],stack,env,remaining,locals);continue;}
   if(n.kind==='scope'){walk(n.body,stack,new Map(env),remaining,locals);continue;}
   if(n.kind==='list'){walk(n.body,[],new Map(env),remaining,locals).forEach(escape);stack.push({unique:true});continue;}
   if(n.kind==='literal'){stack.push(null);continue;}
   if(n.kind==='quote'||n.kind==='local-function'){for(const v of env.values())escape(v);unit(n.body,true);if(n.kind==='quote')stack.push(null);else env.set(n.name,null);continue;}
   if(n.kind==='bind'){
    const vs=n.patterns.map(pop).reverse();
    if(n.patterns.every(p=>p.kind==='word')&&n.names.length===vs.length){n.names.forEach((name,i)=>{const v=vs[i];if(!locals||n.mutable[i])escape(v);env.set(name,locals&&!n.mutable[i]?v:null);});}
    else {vs.forEach(escape);n.names.forEach(name=>env.set(name,null));}continue;
   }
   if(n.kind==='word'){
    const name=n.value;
    if(env.has(name)){const v=env.get(name),left=(remaining.get(name)||1)-1;remaining.set(name,left);if(left)escape(v);else env.delete(name);stack.push(v);continue;}
    if(['vpush','push','Push','::','concat','++'].includes(name)){
     const b=pop(),a=pop();if(a?.unique&&a!==b)reusable.add(n);escape(b);stack.push(a?.unique?a:{unique:true});continue;
    }
    if(name==='dup'){const v=pop();escape(v);stack.push(v,v);continue;}
    if(name==='over'){const b=pop(),a=pop();escape(a);stack.push(a,b,a);continue;}
    if(name==='swap'){const b=pop(),a=pop();stack.push(b,a);continue;}
    if(name==='drop'){pop();continue;}
    if(name==='nop')continue;
    if(['+','-','*','/','%','^','==','/=','<','>','<=','>=','and','or'].includes(name)){escape(pop());escape(pop());stack.push(null);continue;}
    forget();continue;
   }
   if(n.kind==='path-update'){
    const original=pop();
    if(n.updating){
     // A fresh root is held aside while its replacement runs. Values on the
     // enclosing stack can be exchanged with the replacement, so forget them.
     if(original?.unique&&n.path.length===1&&n.path[0].kind==='list-index')reusable.add(n);
     escape(original);forget();
     n.fields.forEach(f=>unit(f.body,true));
     stack.push(null);continue;
    }
    for(const f of n.fields)walk(f.body,[],new Map(env),remaining,locals).forEach(escape);
    if(n.path.length===1&&n.path[0].kind==='list-index'){if(original?.unique)reusable.add(n);stack.push({unique:true});}else{escape(original);stack.push(null);}continue;
   }
   // Any other construct can store, duplicate, suspend or expose a value.
   forget();
   if(n.body)unit(n.body,true);
   if(n.fields)for(const f of n.fields)if(f.body)unit(f.body,true);
   if(n.branches)for(const b of n.branches){if(b.guard)unit(b.guard,true);unit(b.body,true);}
   if(n.left){unit(n.left,true);unit(n.right,true);}
   if(n.operands)n.operands.forEach(b=>unit(b,true));
  }
  return stack;
 }
 for(const clauses of definitions.values())for(const c of clauses){unit(c.body,true);if(c.guard)unit(c.guard,true);}
 unit(definitions.initializers||[],false);unit(nodes,local);return reusable;
}
