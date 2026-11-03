// Read-only summaries are separate from effect rows: effect polymorphism alone
// does not prove that a callback cannot store one of its captured values.
const scalar=t=>t?.kind==='atom';
const union=sets=>new Set(sets.flatMap(s=>[...s||[]]));
export function summarizeRetention(region,types){
 const taints=new Map(),callbacks=new Map();let safe=true;
 region.inputs.forEach((id,index)=>taints.set(id,new Set(['input:'+index])));
 for(const c of region.captures||[])taints.set(c.value,new Set(['capture:'+c.external]));
 for(const i of region.instructions){
  const incoming=union(i.arguments.map(id=>taints.get(id)));
  if(i.op==='read'||i.op==='reference'||i.op==='shuffle'||i.op==='bind'){
   if(i.op==='bind'&&(!i.local||i.mutable))safe=false;
   continue;
  }
  if(i.op==='literal'){i.results.forEach(id=>taints.set(id,new Set()));continue;}
  if(i.op==='quote'){
   const body=i.regions.find(r=>r.id===i.children.find(c=>c.role==='body')?.region);
   if(i.results[0]!==undefined){taints.set(i.results[0],incoming);callbacks.set(i.results[0],body?.retention);}
   continue;
  }
  if(i.retention==='callback'){
   const count=i.name==='if'?2:i.name==='while'?2:1,quotes=i.arguments.slice(-count).map(id=>callbacks.get(id));
   if(quotes.length!==count||quotes.some(q=>!q?.safe))safe=false;
  }else if(i.retention!=='borrow'&&i.op!=='load'&&i.op!=='missing')safe=false;
  if(i.regions.some(r=>!r.retention?.safe))safe=false;
  for(let index=0;index<i.results.length;index++)taints.set(i.results[index],scalar(types[i.resultTypes[index]])?new Set():new Set(incoming));
 }
 const outputs=region.outputs.map(id=>[...taints.get(id)||[]]);
 if(outputs.some(ts=>ts.some(t=>t.startsWith('capture:'))))safe=false;
 return region.retention={safe,outputs,passthrough:region.outputs.map(id=>region.inputs.indexOf(id)),captures:(region.captures||[]).map(c=>c.external)};
}
