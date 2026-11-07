// Compiler-created nominal region identities cannot be forged by source code.
let next=0;
const owners=new WeakMap();
export function ownerIdentity(node,name){let names=owners.get(node);if(!names){names=new Map();owners.set(node,names);}if(!names.has(name))names.set(name,{name,id:next++});return names.get(name);}
export const loanRegion=()=>({tag:'region',id:next++,name:'loan'+next});
export function referencedRegions(type,prune,seen=new Set(),found=new Map()){
 if(!type||typeof type!=='object')return found;type=prune(type);if(seen.has(type))return found;seen.add(type);
 if(type.excludeLoan){const nested=referencedRegions(type.row,prune,new Set(seen));for(const [key,region] of nested)if(prune(region)!==type.excludeLoan)found.set(key,region);return found;}
 if(type.name==='borrowMut'&&type.args?.[0]){const region=prune(type.args[0]);found.set(region,region);}
 if(type.tag==='adt'&&type.name==='mutref'){const region=prune(type.args[0]);found.set(region,region);}
 // Walk types, capture metadata and latent effect dependencies. A borrowed
 // capability remains scoped even when only stored in a lazy value.
 for(const [key,value] of Object.entries(type)){
  if(['link','token','env','accesses','owner'].includes(key))continue;
  if(value instanceof Map)for(const item of value.values())referencedRegions(item,prune,seen,found);
  else if(Array.isArray(value))for(const item of value)referencedRegions(item,prune,seen,found);
  else if(value&&typeof value==='object')referencedRegions(value,prune,seen,found);
 }
 return found;
}
export function containsRegion(type,region,prune,seen=new Set()){
 if(!type||typeof type!=='object')return false;type=prune(type);if(type===region||type.tag==='region'&&type.id===region.id)return true;if(seen.has(type))return false;seen.add(type);
 return Object.entries(type).some(([key,value])=>{
  if(['link','token','env','accesses','owner'].includes(key))return false;
  return value instanceof Map?[...value.values()].some(x=>containsRegion(x,region,prune,seen)):Array.isArray(value)?value.some(x=>containsRegion(x,region,prune,seen)):value&&typeof value==='object'?containsRegion(value,region,prune,seen):false;
 });
}
