// Backward liveness plus forward allocation/escape tracking. Arguments and
// captured values start shared. Only proven fresh, dead input references move.
export function analyzeOwnership(region,types){
 const live=new Set(region.outputs),liveAfter=new Map();
 for(const i of [...region.instructions].reverse()){
  liveAfter.set(i,new Set(live));
  for(const id of i.results)if(!i.arguments.includes(id))live.delete(id);
  if(!(i.op==='shuffle'&&i.name==='drop')&&i.op!=='bind')for(const id of i.arguments)live.add(id);
 }
 const resources=new Map(),escaped=new Set();let next=0;
 const escape=id=>{if(resources.has(id))escaped.add(resources.get(id));};
 const fresh=id=>resources.set(id,next++);
 for(const i of region.instructions){
  const name=i.name,vector=['vpush','push','Push','::','concat','++'].includes(name),heap=['hpush','hpop'].includes(name);
  const container=i.arguments[0],resource=resources.get(container);
  if((vector||heap)&&i.op==='call'){
   const kind=types[i.resultTypes[0]]?.kind;
   const supported=vector?kind==='list':types[i.resultTypes[0]]?.name==='heap';
   const aliased=i.arguments.slice(1).some(id=>resources.get(id)===resource);
   const dead=!liveAfter.get(i).has(container);
   const move=supported&&resource!==undefined&&!escaped.has(resource)&&!aliased&&dead;
   i.ownership={mode:move?'move':'copy',reason:move?'fresh-last-use':resource===undefined?'shared-input':escaped.has(resource)?'escaped':aliased?'self-alias':!dead?'live-alias':'unsupported-type'};
   i.arguments.slice(1).forEach(escape);
   if(i.results[0]!==undefined){if(move)resources.set(i.results[0],resource);else if(supported)fresh(i.results[0]);}
  }else if(i.op==='list'||i.op==='call'&&['heap','deque'].includes(name)){
   if(i.op==='list')for(const resource of resources.values())escaped.add(resource);
   if(i.results[0]!==undefined)fresh(i.results[0]);
  }else if(i.op==='bind'){
   if(!i.local||i.mutable)i.arguments.forEach(escape);
  }else if(i.op==='read'||i.op==='reference'||i.op==='shuffle'){
   // Forwarded value numbers retain their allocation identity.
  }else if(i.op==='literal'){
   // Scalars cannot alias a container allocation.
  }else {
   // Unknown calls may retain inputs; closures and control constructs can
   // observe lexical bindings even when they are absent from the value stack.
   i.before.forEach(escape);i.arguments.forEach(escape);
   if(i.op!=='call')for(const resource of resources.values())escaped.add(resource);
  }
 }
 return region;
}
