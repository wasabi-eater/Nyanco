import {loweringTypes,typeIR as T,formatType} from './types.mjs';
import {analyzeOwnership} from './ir-ownership.mjs';

// Types are snapshots, not references into the mutable unification graph.
// Value numbers describe data flow; structured instructions retain child
// regions for patterns, handlers, quotations and other control constructs.
export function createTypedIR(definitions,{ownership=true}={}){
 const inference=loweringTypes(definitions),types=[],regions=[];let typeIDs=new Map();
 let nextValue=0;
 function type(t){
  if(!t)return null;t=T.prune(t);const representation=T.aliasRepresentation(t);if(representation!==t)return type(representation);
  if(typeIDs.has(t))return typeIDs.get(t);
  const id=types.length;typeIDs.set(t,id);const d={id,kind:t.tag,display:formatType(t)};types.push(d);
  // An otherwise unresolved integer literal defaults at native emission, just
  // as integerLiteralInfo does. Do not mutate the inference graph here.
  if(t.tag==='var'&&t.numericLiterals){Object.assign(d,{kind:'atom',name:'int',display:'int',literalDefault:true});return id;}
  if(t.name)d.name=t.name;
  if(t.tag==='var'||t.tag==='rigid'){d.sort=t.sort;d.constraints=[...t.classes||[]];}
  if(t.item)d.item=type(t.item);if(t.rest)d.rest=type(t.rest);
  if(t.args)d.arguments=t.args.map(type);if(t.items)d.items=t.items.map(type);
  if(t.tail)d.tail=type(t.tail);if(t.row)d.row=type(t.row);
  if(t.fields instanceof Map)d.fields=[...t.fields].map(([name,t])=>({name,type:type(t)}));
  if(t.input){d.input=type(t.input);d.output=type(t.output);d.effects=effects(t.effects);d.effectTails=effectTails(t.effects);}
  else if(t.effects){d.effects=effects(t.effects);d.effectTails=effectTails(t.effects);}
  return id;
 }
 function effects(e){return e?T.effectSnapshot(e).entries.map(e=>({name:e.name,arguments:e.args.map(type),...(e.target?{target:e.target}:{}),...(e.skip?{skip:e.skip}:{})})):[];}
 function effectTails(e){return e?T.effectDescription(e).tails.map(type):[];}
 function row(t){const values=[];t=T.prune(t);while(t.tag==='push'){values.unshift(t.item);t=T.prune(t.rest);}return {values,tail:t,never:T.isBottom(t)};}
 const value=t=>({id:nextValue++,type:type(t)});
 function region(nodes,trace,initial=null,local=true){
  const instructions=[],result={id:regions.length,instructions,inputs:[],outputs:[]};regions.push(result);
  let stack=initial||null;const env=new Map(),references=new Map();
  const add=(nodes,scope=env)=>{
   for(const source of nodes){
    const info=trace.get(source);if(!info)break;
    const before=row(info.input),after=row(info.output);
    if(!stack)stack=before.values.map(value);
    if(!result.inputs.length&&!instructions.length){result.inputs=[...stack];result.inputRow=type(before.tail);}
    if(source.kind==='application'){add(info.application,scope);continue;}
    if(source.kind==='scope'){add(source.body,new Map(scope));continue;}
    const prior=[...stack];
    // Find the physically shared row suffix. Equal element types alone do not
    // imply equal values (a function int -> int can change its argument).
    let a=T.prune(info.input),b=T.prune(info.output),ac=[],bc=[];
    while(a.tag==='push'){ac.push(a);a=T.prune(a.rest);}ac.push(a);
    while(b.tag==='push'){bc.push(b);b=T.prune(b.rest);}bc.push(b);
    const cut=ac.findIndex(a=>bc.includes(a));
    const callbackCall=source.kind==='word'&&(['call','dip','if','when','while','each','fold','handle','resume'].includes(source.value)||before.values.some(t=>['quote','continuation'].includes(T.prune(t).tag)));
    const preserved=callbackCall||cut<0?0:Math.max(0,prior.length-cut);
    let args=prior.slice(preserved),out=after.values.slice(preserved).map(value);
    let op=source.kind==='word'?'call':source.kind;
    const name=source.value;
    if(source.kind==='word'&&scope.has(name)){op='read';args=[scope.get(name)];out=args;}
    else if(source.kind==='word'&&info.env?.has(name)&&!info.env.get(name).callable){op='load';args=[];}
    else if(source.kind==='word'&&['dup','drop','swap','over','rot','nop'].includes(name)){
     op='shuffle';const count={dup:1,drop:1,swap:2,over:2,rot:3,nop:0}[name];args=count?prior.slice(-count):[];
     out=name==='dup'?[args[0],args[0]]:name==='drop'?[]:name==='swap'?[args[1],args[0]]:name==='over'?[...args,args[0]]:name==='rot'?[args[1],args[2],args[0]]:[];
     stack=prior.slice(0,prior.length-count);
    }else if(source.kind==='bind'){
     if(source.patterns.every(p=>p.kind==='word')&&source.names.length===args.length)source.names.forEach((n,i)=>scope.set(n,args[i]));
    }else if(source.kind==='capture'){
     for(const slot of source.slots){const v=prior[prior.length-1-slot.index];references.set(slot,v);if(slot.capturedName)scope.set(slot.capturedName,v);}
     const removed=new Set(source.slots.filter(s=>!s.peek).map(s=>s.index));out=prior.filter((_,i)=>!removed.has(prior.length-1-i));args=[...prior];stack=[];
    }else if(source.kind==='reference'){const reference=references.get(source);out=[reference||value(after.values.at(-1))];args=reference?out:[];}
    if(op!=='shuffle'&&source.kind!=='capture')stack=prior.slice(0,preserved);
    stack.push(...out);
    const data=Object.fromEntries(Object.entries(source).filter(([key])=>!['body','guard','fields','branches','operands','left','right','file','line','col','endLine','endCol'].includes(key)));
    if(source.fields)data.fields=source.fields.map(({body,...f})=>f);
    if(source.branches)data.branches=source.branches.map(({body,guard,...b})=>b);
    const instruction={id:instructions.length,op,...(name!==undefined?{name}:{}),arguments:args.map(v=>v.id),results:out.map(v=>v.id),before:prior.map(v=>v.id),after:stack.map(v=>v.id),resultTypes:out.map(v=>v.type),effects:effects(info.effect?.effects),effectTails:effectTails(info.effect?.effects),callType:info.effect?type(info.effect):null,location:{file:source.file,line:source.line,col:source.col},data,regions:[],children:[],...(source.kind==='bind'?{local,mutable:source.mutable.some(Boolean)}:{})};
    Object.defineProperties(instruction,{source:{value:source},typing:{value:info}});
    // Child control regions get independent unknown inputs. No ownership fact
    // crosses a branch, a closure or an effect boundary without a proof.
    const child=(body,role,index=0)=>{if(Array.isArray(body)&&body.some(n=>trace.has(n))){const r=region(body,trace);instruction.regions.push(r);instruction.children.push({role,index,region:r.id});}};
    if(source.body)child(source.body,'body');if(source.guard)child(source.guard,'guard');
    (source.fields||[]).forEach((f,i)=>child(f.body,'field',i));
    (source.branches||[]).forEach((b,i)=>{child(b.guard,'branch-guard',i);child(b.body,'branch-body',i);});
    if(source.operands)source.operands.forEach((b,i)=>child(b,'operand',i));if(source.left)child(source.left,'left');if(source.right)child(source.right,'right');
    instructions.push(instruction);result.never=after.never;result.outputRow=type(after.tail);
   }
  };
  add(nodes);result.outputs=(stack||[]).map(v=>v.id);result.outputTypes=(stack||[]).map(v=>v.type);
  result.inputTypes=result.inputs.map(v=>v.type);result.inputs=result.inputs.map(v=>v.id);
  if(ownership)analyzeOwnership(result,types);
  return result;
 }
 // Lower only after the caller has unified the specialization's result type.
 // Rebuilding is deliberate: another specialization must not reuse its types
 // or ownership conclusions even when the source node is identical.
 const plans=new WeakMap();
 function lower(nodes,trace,{local=true}={}){
  typeIDs=new Map();const result=region(nodes,trace,null,local),lookup=new Map();
  const collect=r=>{for(const i of r.instructions){lookup.set(i.source,i);i.regions.forEach(collect);}};collect(result);
  const plan={region:result,lookup};plans.set(trace,plan);return plan;
 }
 function instructions(nodes,trace,options){
  const plan=plans.get(trace)||lower(nodes,trace,options);
  return nodes.map(source=>({op:source.kind,source,typing:trace.get(source),ownership:plan.lookup.get(source)?.ownership}));
 }
 function describe(trace,owner,input=[],output=[]){const plan=plans.get(trace);if(plan)plan.region.owner={...owner,parameterTypes:input.map(type),returnTypes:output.map(type)};}
 function serialize(){return structuredClone({version:1,types,regions:regions.map(r=>({...r,instructions:r.instructions.map(({regions,...i})=>({...i,regions:regions.map(r=>r.id)}))}))});}
 return {...inference,lower,instructions,describe,types,regions,serialize};
}

export function verifyTypedIR(program){
 const ids=new Set(program.regions.map(r=>r.id));
 for(const r of program.regions){
  if(r.inputs.length!==r.inputTypes.length||r.outputs.length!==r.outputTypes.length)throw new Error('IR region/type arity mismatch');
  const defined=new Set(r.inputs);
  for(const i of r.instructions){
   for(const id of i.arguments)if(!defined.has(id))throw new Error(`IR region ${r.id}: undefined value %${id} at ${i.op}`);
   if(i.results.length!==i.resultTypes.length)throw new Error('IR result/type arity mismatch');
   for(const id of i.resultTypes)if(!program.types[id])throw new Error('IR has an unknown result type');
   for(const id of i.results){if(defined.has(id)&&!i.arguments.includes(id))throw new Error('IR value is defined twice');defined.add(id);}
   for(const child of i.children)if(!ids.has(child.region))throw new Error('IR has an unknown child region');
  }
  for(const id of r.outputs)if(!defined.has(id))throw new Error('IR has an undefined return value');
 }
 return true;
}
