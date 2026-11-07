// Backward liveness plus forward allocation/escape tracking. Arguments and
// captured values start shared. Only proven fresh, dead input references move.
export function analyzeOwnership(region,types){
 const live=new Set(region.outputs),liveAfter=new Map();
 for(const i of [...region.instructions].reverse()){
  liveAfter.set(i,new Set(live));
  for(const id of i.results)if(!i.arguments.includes(id))live.delete(id);
  if(!(i.op==='shuffle'&&i.name==='drop')&&i.op!=='bind')for(const id of i.arguments)live.add(id);
 }
 const resources=new Map(),held=new Map(),callbacks=new Map(),escaped=new Set();let next=0;
 const referenced=id=>new Set([...(resources.has(id)?[resources.get(id)]:[]),...held.get(id)||[]]);
 const escape=id=>{for(const resource of referenced(id))escaped.add(resource);};
 const fresh=id=>resources.set(id,next++);
 const forward=(to,from)=>{if(resources.has(from))resources.set(to,resources.get(from));if(held.has(from))held.set(to,held.get(from));if(callbacks.has(from))callbacks.set(to,callbacks.get(from));};
 const concatenation=patterns=>(patterns||[]).some(p=>p.kind==='concat-pattern'||concatenation(p.fields));
 for(const i of region.instructions){
  const name=i.name,vector=['vpush','push','Push','::','concat','++'].includes(name),heap=['hpush','hpop'].includes(name);
  const container=i.arguments[0],resource=resources.get(container);
  const slice=(i.source?.sliceMethod||['sliceBetween','sliceFrom','sliceTo'].includes(name))&&types[i.resultTypes[0]]?.kind==='list';
  if(slice){
   i.ownership={mode:'view',reason:'immutable-shared-storage'};
   i.arguments.forEach(escape);
   if(resource!==undefined&&i.results[0]!==undefined)resources.set(i.results[0],resource);
  }else if(i.op==='bind'&&concatenation(i.source?.patterns)){
   i.ownership={mode:'view',reason:'pattern-shared-storage'};
   i.arguments.forEach(escape);
  }else if((vector||heap)&&i.op==='call'){
   const resultIndex=name==='hpop'?1:0;
   const resultType=types[i.resultTypes[resultIndex]];
   const supported=vector?resultType?.kind==='list':resultType?.name==='heap';
   const aliased=i.arguments.slice(1).some(id=>resources.get(id)===resource);
   const dead=![...liveAfter.get(i)].some(id=>referenced(id).has(resource));
   const move=supported&&resource!==undefined&&!escaped.has(resource)&&!aliased&&dead;
   i.ownership={mode:move?'move':'copy',reason:move?'fresh-last-use':resource===undefined?'shared-input':escaped.has(resource)?'escaped':aliased?'self-alias':!dead?'live-alias':'unsupported-type'};
   i.arguments.slice(1).forEach(escape);
   const result=i.results[resultIndex];
   if(result!==undefined){if(move)resources.set(result,resource);else if(supported)fresh(result);}
  }else if(i.op==='quote'){
   const body=i.regions.find(r=>r.id===i.children.find(c=>c.role==='body')?.region);
   if(i.results[0]!==undefined){held.set(i.results[0],new Set(i.arguments.flatMap(id=>[...referenced(id)])));callbacks.set(i.results[0],body?.retention);}
  }else if(i.retention==='borrow'&&i.regions.every(r=>r.retention?.safe)){
   // A proved reader does not keep its argument after it returns. Its compound
   // results remain shared; no fresh allocation is assumed by this contract.
   i.borrowing={mode:'temporary',reason:'non-retaining-reader'};
  }else if(i.retention==='callback'){
   const count=name==='if'||name==='while'?2:1,qs=i.arguments.slice(-count).map(id=>callbacks.get(id));
   if(qs.length!==count||qs.some(q=>!q?.safe)){
    i.arguments.forEach(escape);i.before.forEach(escape);continue;
   }
   i.borrowing={mode:'temporary',reason:'synchronous-non-retaining-callback'};
   let state=i.arguments.slice(0,-(name==='if'?3:name==='when'||name==='dip'||name==='each'?2:name==='fold'?3:count));
   if(name==='fold'){
    state.forEach((id,j)=>forward(i.results[j],id));
    const accumulator=i.arguments.at(-2),summary=qs[0];
    if(summary.passthrough[0]===0)forward(i.results.at(-1),accumulator);
    else if((summary.outputs[0]||[]).includes('input:0'))escape(accumulator);
   }else{
    const summaries=name==='while'?[qs[0],qs[1]]:qs;
    for(let j=0;j<state.length&&j<i.results.length;j++){
     if(summaries.every(q=>q.passthrough[j]===j))forward(i.results[j],state[j]);
     else escape(state[j]);
    }
    if(name==='dip')forward(i.results.at(-1),i.arguments.at(-2));
   }
  }else if(i.op==='list'||i.op==='call'&&(i.allocates||['__emptyHeap','__emptyDeque','__emptySet'].includes(name))){
   if(i.op==='list')for(const resource of resources.values())escaped.add(resource);
   else i.arguments.forEach(escape);
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
