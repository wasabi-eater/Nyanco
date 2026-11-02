import {lookupInstance} from './class-relations.mjs';
import {withStandardFunctions} from './builtin-functions.mjs';
import {combinationNames} from './combinatorics.mjs';
import {vectorOwnership} from './ownership.mjs';
import {transforms,streamTransforms,countTransform,callbackTransform} from './iteration.mjs';
import {withOption} from './builtin-option.mjs';
import {ioEffects} from './builtin-effects.mjs';
import {instanceKey} from './type-names.mjs';
import {readFileSync} from 'node:fs';
import {parseExpression} from './language.mjs';
import {checkExpression,loweringTypes,typeIR as T,formatType,missingOperands,StaticTypeError} from './types.mjs';

const str=JSON.stringify;
const lit=(v,type='int',source=null)=>v?.kind==='scalar'?`Char(${v.value.codePointAt(0)})`:typeof v==='string'?str(v):typeof v==='boolean'?String(v):`${type==='float'?'float64':type==='byte'?'uint8':'int64'}(${source??v})`;
const location=n=>str(n?`${n.file}:${n.line}:${n.col}`:'<empty>');
const tuple=items=>items.never?T.BOTTOM:T.stack(T.EMPTY,...items);
const neverValues=()=>Object.assign([],{never:true});
class StoppedEmission {}
function items(row) {
  const result=[];row=T.prune(row);if(T.isBottom(row))return neverValues();
  while(row.tag==='push'){result.unshift(row.item);row=T.prune(row.rest);}
  if(row.tag==='var')T.unify(row,T.EMPTY);
  else if(row.tag!=='empty')throw new Error('Unresolved native function arity');
  return result;
}
function effectParts(effect) {
  effect=T.prune(effect);
  // A row-valued effect observes the whole input prefix, even on a bottom path.
  if(T.effectSnapshot(effect.effects).entries.some(e=>e.args.some(a=>{a=T.prune(a);return a.sort==='row'||['push','empty','concat-row'].includes(a.tag);})))return {input:items(effect.input),output:items(effect.output)};
  if(effect.originalNever&&effect.bottomBase){
    const base=T.prune(effect.bottomBase),suffix=type=>{const result=[];type=T.prune(type);while(type!==base&&type.tag==='push'){result.unshift(type.item);type=T.prune(type.rest);}return type===base?result:null;};
    const input=suffix(effect.input),output=suffix(effect.output);if(input&&output)return {input,output};
  }
  if(T.isBottom(effect.output) && effect.bottomBase && !T.prune(effect.bottomBase).keepNativePrefix){const input=[];let t=T.prune(effect.input),base=T.prune(effect.bottomBase);while(t!==base && t.tag==='push'){input.unshift(t.item);t=T.prune(t.rest);}if(t===base)return {input,output:neverValues()};}
  if(T.isBottom(effect.input)||T.isBottom(effect.output))return {input:items(effect.input),output:items(effect.output)};
  const chain=row=>{const out=[];row=T.prune(row);while(true){out.push(row);if(row.tag!=='push')break;row=T.prune(row.rest);}return out;};
  const a=chain(effect.input),b=chain(effect.output);
  const common=a.findIndex(x=>!x.keepNativePrefix && b.includes(x));
  if(common>=0)return {input:a.slice(0,common).map(x=>x.item).reverse(),output:b.slice(0,b.indexOf(a[common])).map(x=>x.item).reverse()};
  return {input:items(effect.input),output:items(effect.output)};
}
function copyEnv(env) {
  const vars=new Set();for(const s of env.values())for(const v of T.free(s.type))vars.add(v);
  const replacements=new Map([...vars].map(v=>[v,{...T.variable(v.sort),...(v.numericLiterals?{numericLiterals:[...v.numericLiterals]}:{}),...(v.polymorphicNumber?{polymorphicNumber:true}:{}),...(v.numericPattern?{numericPattern:true}:{}),...(v.keepNativePrefix?{keepNativePrefix:true}:{}),...(v.lacks?{lacks:new Set(v.lacks)}:{}),...(v.classes?{classes:new Set(v.classes)}:{})}]));
  for(const [v,fresh] of replacements){if(v.relations)fresh.relations=v.relations.map(r=>({...r,args:r.args.map(t=>T.clone(t,replacements))}));if(v.associated)fresh.associated=new Map([...v.associated].map(([n,ts])=>[n,ts.map(t=>T.clone(t,replacements))]));if(v.eachItem)fresh.eachItem=T.clone(v.eachItem,replacements);if(v.eachEffects)fresh.eachEffects=T.clone(v.eachEffects,replacements);if(v.handlerAnswer)fresh.handlerAnswer=T.clone(v.handlerAnswer,replacements);}
  return new Map([...env].map(([name,s])=>[name,{...s,type:T.clone(s.type,replacements),vars:new Set([...s.vars].map(v=>replacements.get(v)||v))}]));
}
function freshTypes(input,output,latent) {
  // A quotation parameter carries only its consumed/produced suffix. Its
  // caller's untouched prefix is not an argument to the specialized function.
  const memo=new Map();
  function portable(type) {
    type=T.prune(type);
    if(memo.has(type))return memo.get(type);
    let result=type;
    if(['quote','continuation'].includes(type.tag)) {
      const parts=effectParts(type),tail=T.row();
      result={...T.quote(parts.input.never?T.BOTTOM:T.stack(tail,...parts.input.map(portable)),parts.output.never?T.BOTTOM:T.stack(tail,...parts.output.map(portable))),tag:type.tag,...(latent?{effects:T.effectSnapshot(type.effects)}:{}),...(type.originalNever?{originalNever:true,bottomBase:tail}:{})};
    } else if(type.tag==='stream')result={...type,item:portable(type.item)};
    else if(type.tag==='list')result={...type,item:portable(type.item)};
    else if(['tuple','tuple-tail'].includes(type.tag))result={...type,items:type.items.map(portable),tail:portable(type.tail)};
    else if(type.tag==='record')result={...type,row:portable(type.row)};
    else if(type.tag==='record-row')result={...type,fields:new Map([...type.fields].map(([k,v])=>[k,portable(v)])),tail:portable(type.tail)};
    else if(type.tag==='adt')result={...type,args:type.args.map(portable)};
    memo.set(type,result);return result;
  }
  const effect=T.quote(input.never?T.BOTTOM:tuple(input.map(portable)),output.never?T.BOTTOM:tuple(output.map(portable)),latent);
  return T.instantiate(T.generalize(effect));
}

export function transpileDirect(program,{expression='main',showStack=false,entryNodes=null,optimizeVectors=true}={}) {
  const definitions=withStandardFunctions(withOption(Object.assign(new Map(program.definitions),{...program.definitions,effects:ioEffects(program.definitions.effects)}))),entry=entryNodes||parseExpression(expression,'<entry>',program.definitions.constructors);
  checkExpression(entry,definitions);
  const vectorReuse=optimizeVectors?vectorOwnership(definitions,entry):new WeakSet();
  const types=loweringTypes(definitions),functions=[],specializations=new Map(),sites=[],siteKeys=new Map(),invocations=[],invKeys=new Map();
  const nodeIds=new Map();let next=0;
  const nodeID=n=>{if(!nodeIds.has(n))nodeIds.set(n,nodeIds.size);return nodeIds.get(n);};
  const returns=n=>n?`(${Array(n).fill('any').join(',')})`:'';
  const params=n=>Array.from({length:n},(_,i)=>`a${i} any`).join(',');
  const args=n=>Array.from({length:n},(_,i)=>`a${i}`);
  const typedDispatch=[...definitions.methods?.values()||[]].some(m=>m.dispatchIndex<0&&!m.specialCast);
  const latent=effect=>typedDispatch?T.effectSnapshot(effect.effects):undefined;
  const keyOf=(input,output,effect)=>formatType(T.quote(tuple(input),tuple(output),effect&&latent(effect)));
  const finish=(ctx,values)=>ctx.lines.push(values.never?'panic("Non-returning computation returned")':`return ${values.join(',')}`);
  const failReturn=n=>n?`return ${Array(n).fill('nil').join(',')}`:'return';
  function context() {
    const ctx={lines:[]};
    ctx.value=expr=>{const name=`v${next++}`;ctx.lines.push(`${name}:=any(${expr}); _=${name}`);return name;};
    ctx.call=(fn,inputs,count)=>{
      if(!count){ctx.lines.push(`${fn}(${inputs.join(',')})`);return [];}
      const names=Array.from({length:count},()=>`v${next++}`);
      ctx.lines.push(`${names.join(',')}:=${fn}(${inputs.join(',')});${names.map(n=>`_=${n}`).join(';')}`);return names;
    };
    return ctx;
  }
  function pattern(p) {
    if(p.kind==='tuple-pattern')return `tuplePattern(${p.fields.map(pattern).join(',')})`;
    if(p.kind==='literal')return `literalPattern(${lit(p.value,p.numericKind==='float'?'float':'int',p.numberSource)})`;
    if(p.kind==='word')return `${p.mutable?"mutablePattern":"variablePattern"}(${str(p.value)})`;
    const fields=p.fields.map(pattern).join(',');
    if(p.kind==='constructor')return `constructorPattern(${str(p.value)}${fields?','+fields:''})`;
    return `${p.kind==='push-pattern'?'pushPattern':'listPattern'}(${fields})`;
  }
  function registerSite(node,env,body=node.body) {
    const key=nodeID(node)+':'+[...env].map(([n,s])=>n+'='+(s.callable?'function:':'value:')+formatType(s.type)).join(';');
    if(siteKeys.has(key))return siteKeys.get(key);
    if(sites.length>500)throw new Error('Native quotation specialization limit exceeded');
    const id=sites.length;sites.push({id,body,env:copyEnv(env),node});siteKeys.set(key,id);return id;
  }
  function invocation(effect) {
    const {input,output}=effectParts(effect),key=keyOf(input,output,effect);
    if(!invKeys.has(key)) {
      if(invocations.length>500)throw new Error('Native call specialization limit exceeded');
      const value={name:`invoke${invocations.length}`,input,output,effects:latent(effect),handlers:new Map()};invocations.push(value);invKeys.set(key,value);
    }
    return invKeys.get(key);
  }
  function invoke(ctx,q,values,effect,at) {
    const inv=invocation(effect),inputs=values.splice(values.length-inv.input.length);
    values.push(...ctx.call(`m.${inv.name}`,[q,at,...inputs],inv.output.length));
  }
  function named(name,effect) {
    const {input,output}=effectParts(effect),key=name+':'+keyOf(input,output,effect);
    if(specializations.has(key))return specializations.get(key);
    if(functions.length>1000)throw new Error('Native function specialization limit exceeded');
    const id=functions.length,fn=`fn${id}`;functions.push('');specializations.set(key,{fn,input,output});
    const lines=[`func(m *Machine) ${fn}(${params(input.length)}) ${returns(output.length)} {`];
    for(const clause of definitions.get(name)) {
      const arity=clause.patterns.length,env=copyEnv(types.globals),signature=freshTypes(input,output,latent(effect));
      const ins=items(signature.input),outs=items(signature.output);
      env.locals=new Set();
      clause.patterns.forEach((p,i)=>types.pattern(p,ins[ins.length-arity+i],env));
      const remaining=arity?ins.slice(0,-arity):ins;
      const guard=clause.guard?types.analyze(clause.guard,tuple(remaining),new Map(env)):null;
      const bodyInput=guard?items(guard.output).slice(0,-1):remaining;
      const analysis=types.analyze(clause.body,tuple(bodyInput),env);
      T.unify(analysis.output,tuple(outs),clause.token);if(typedDispatch)T.specializeEffects(analysis.effects,signature.effects,clause.token);
      const ctx=context(),actual=args(input.length),argValues=arity?actual.slice(-arity):[];
      lines.push(`{ e:=m.globals.clone();if matches([]Pattern{${clause.patterns.map(pattern)}},[]any{${argValues}},e){`);
      let bodyValues=arity?actual.slice(0,-arity):actual;
      if(guard) {
        ctx.lines.push('g:=e.clone();_ = g');
        bodyValues=emit(clause.guard,[...bodyValues],'g',new Map(),guard.trace,ctx);
        if(bodyValues.never){finish(ctx,bodyValues);lines.push(...ctx.lines,'} }');continue;}
        ctx.lines.push(`if boolean(${bodyValues.pop()},${location(clause.token)}) {`);
      }
      const values=emit(clause.body,bodyValues,'e',new Map(),analysis.trace,ctx);
      finish(ctx,values);if(guard)ctx.lines.push('}');lines.push(...ctx.lines,'} }');
    }
    lines.push(`fail(${location(definitions.get(name)[0].token)},${str('No matching pattern for '+name)});${failReturn(output.length)}`,'}');
    functions[id]=lines.join('\n');return specializations.get(key);
  }
  function binaryCall(op,a,b,effect,ctx) {
    const m=definitions.methods?.get(op.value);
    if(m) {
      const input=items(T.prune(effect).input),type=T.prune(input.at(-2));
      const target=definitions.classes.get(m.className).instances.get(instanceKey(type))?.implementations.get(op.value);
      if(target){const spec=named(target,effect);return ctx.call(`m.${spec.fn}`,[a,b],1)[0];}
    }
    return ctx.value(['.&.','.|.','.<<.','.>>.'].includes(op.value)?`m.bitOperation(${str(op.value)},${a},${b},${location(op)})`:`binary(${str(op.value)},${a},${b},${location(op)})`);
  }
  function emit(nodes,values,env,holes,trace,ctx) {
    holes.references ??= new Map();
    ctx.lines.push(`m.enter(${location(nodes[0])})`);
    for(const n of nodes) {
      if(n.kind==='capture') {
        const snapshot=[...values];
        for(const s of n.slots){const value=snapshot[snapshot.length-1-s.index];holes.references.set(s,value);if(s.capturedName)ctx.lines.push(`${env}.declare(${str(s.capturedName)},${value},false,${location(s)})`);}
        const removed=[...new Set(n.slots.filter(s=>!s.peek).map(s=>s.index))].sort((a,b)=>a-b);
        for(const index of removed)values.splice(snapshot.length-1-index,1);
        continue;
      }
      const at=location(n),info=trace.get(n);if(!info)break;ctx.lines.push(`m.tick(${at})`);
      const child=(body,initial=[],bound=holes)=>{
        const e=`e${next++}`;ctx.lines.push(`${e}:=${env}.clone();_=${e}`);
        const result=emit(body,initial,e,bound,trace,ctx);if(result.never)throw new StoppedEmission();return result;
      };
      try {
      if(n.kind==='reference')values.push(holes.references.get(n));
      else if(n.kind==='literal'){
        const literal=typeof n.value==='number'&&n.numericKind!=='float'&&Number.isInteger(n.value)?T.integerLiteralInfo(definitions,n,T.prune(info.output).item):null;
        if(literal?.conversion){const value=ctx.value(lit(n.value,'int',n.numberSource));if(literal.conversion.target==='fromInt')values.push(ctx.value(`m.numericCast(${value},${str(literal.conversion.destination)},${location(n)})`));else{const spec=named(literal.conversion.target,literal.effect);values.push(...ctx.call(`m.${spec.fn}`,[value],1));}}
        else values.push(ctx.value(lit(n.value,literal?.type||T.numericName(T.prune(info.output).item)||(n.numericKind==='float'?'float':'int'),n.numberSource)));
      }
      else if(n.kind==='interpolation') {
        const count=n.fields.filter(f=>f.empty).length,arguments_=count?values.splice(-count):[];let index=0;
        const parts=[str(n.chunks[0])];
        for(let i=0;i<n.fields.length;i++){
          const f=n.fields[i],value=f.empty?arguments_[index++]:child(f.body)[0];
          parts.push(`stringValue(${shown(value,info.formatTypes[i],ctx,at,true)},${at})`,str(n.chunks[i+1]));
        }
        values.push(ctx.value(parts.join('+')));
      }
      else if(n.kind==='missing'){if(holes.has(n))values.push(holes.get(n));}
      else if(n.kind==='label') {const local=`labelEnv${next++}`;ctx.lines.push(`${local}:=${env}.clone();${local}.declare(${str(n.key)},&EffectLabel{},false,${at})`);values=emit(n.body,values,local,holes,trace,ctx);}
      else if(n.kind==='mask') {
        const inner=context(),result=emit(n.body,[...values],env,holes,trace,inner),returned=`masked${next++}`;
        ctx.lines.push(`${returned}:=m.mask(func(m *Machine) []any {${inner.lines.join(';')};return []any{${result.never?'':result}}},${str(n.operation)},${n.target?`labelTarget(${env}.read(${str(n.target)}),${at})`:'nil'},${at});_=${returned}`);
        values=items(info.output).map((_,i)=>ctx.value(`${returned}[${i}]`));
      }
      else if(n.kind==='application')values=emit(info.application,values,env,holes,trace,ctx);
      else if(n.kind==='scope')values=child(n.body,values);
      else if(n.kind==='record') {
        const missing=missingOperands([n]).filter(h=>!holes.has(h)),bindings=new Map(holes),vs=missing.length?values.splice(-missing.length):[];
        bindings.references=holes.references;missing.forEach((h,i)=>bindings.set(h,vs[i]));
        const fields=n.fields.map(f=>`${str(f.name)}:${child(f.body,[],bindings)[0]}`);
        values.push(ctx.value(`&Record{map[string]any{${fields.join(',')}}}`));
      }
      else if(n.kind==='dict'){const pairs=[];for(let j=0;j<n.fields.length;j+=2){const k=child(n.fields[j].body,[],holes)[0],v=child(n.fields[j+1].body,[],holes)[0];pairs.push(`[2]any{${k},${v}}`);}values.push(ctx.value(`makeDict([][2]any{${pairs.join(',')}})`));}
      else if(n.kind==='tuple')values.push(ctx.value(`&Tuple{[]any{${child(n.body,[],holes).join(',')}}}`));
      else if(n.kind==='path-update') {
        const original=values.pop(),args=n.fields.slice(0,-1).map(f=>child(f.body,[],holes)[0]);
        const path=n.path.map(p=>p.kind==='field'?`UpdatePart{kind:"field",name:${str(p.name)}}`:p.kind==='tuple-index'?`UpdatePart{kind:"tuple",index:float64(${p.index})}`:(()=>{const methods=info.indexPaths[n.path.indexOf(p)],g=context(),set=context(),read=indexCall('at',['v','i'],methods.get,g,at),write=indexCall('setAt',['v','i','x'],methods.set,set,at,n.path.indexOf(p)===0&&vectorReuse.has(n));return `UpdatePart{kind:"list",optional:${!!p.optional},index:${args[p.argument]},get:func(m *Machine,v,i any) any{${g.lines.join(';')};return ${read}},set:func(m *Machine,v,i,x any) any{${set.lines.join(';')};return ${write}}}`;})());
        const pathValue=`path${next++}`;ctx.lines.push(`${pathValue}:=[]UpdatePart{${path}}`);
        if(n.defaulting||n.path.some(p=>p.optional)){
          const inner=context(),e=`e${next++}`;inner.lines.push(`${e}:=${env}.clone();_=${e}`);
          const replacement=emit(n.fields.at(-1).body,n.updating?['old']:[],e,n.updating?new Map():holes,trace,inner);
          if(replacement.never)inner.lines.push('return nil');else inner.lines.push(`return ${replacement[0]}`);
          values.push(ctx.value(`m.modifyUpdate(${original},${pathValue},func(old any) any{${inner.lines.join(';')}},${!!n.defaulting},${at})`));
          continue;
        }
        const old=n.updating?ctx.value(`m.readUpdatePath(${original},${pathValue},${at})`):null;
        const replacement=child(n.fields.at(-1).body,n.updating?[old]:[],n.updating?new Map():holes)[0];
        values.push(ctx.value(`m.copyUpdate(${original},${pathValue},${replacement},${at},${vectorReuse.has(n)})`));
      }
      else if(n.kind==='list-index'){
        const xs=values.pop(),index=child(n.body,[],holes)[0];
        if(!n.optional)values.push(indexCall('at',[xs,index],info.indexGet,ctx,at));
        else {const inner=context(),value=indexCall('at',[xs,index],info.indexGet,inner,at);
          values.push(ctx.value(`m.handle(func(m *Machine) []any {${inner.lines.join(';')};return []any{&ADT{"option","Some",[]any{${value}}}}},map[string]EffectHandler{"exn":func(_ []any,_ *Continuation) []any{return []any{&ADT{"option","None",nil}}}},${at})[0]`));}
      }
      else if(n.kind==='tuple-index')values.push(ctx.value(`tupleIndex(${values.pop()},${n.index},${location(n)})`));
      else if(n.kind==='field')values.push(ctx.value(`recordField(${values.pop()},${str(n.name)},${location(n)})`));
      else if(n.kind==='list')values.push(ctx.value(`[]any{${child(n.body,[],holes).join(',')}}`));
      else if(n.kind==='quote') {
        const id=registerSite(n,info.env);
        values.push(ctx.value(`&Quote{${id},${env}.clone()}`));
      } else if(n.kind==='local-function') {
        const id=registerSite(n,info.localEnv),captured=`e${next++}`;
        ctx.lines.push(`${captured}:=${env}.clone()`);
        const q=ctx.value(`&Quote{${id},${captured}}`);
        ctx.lines.push(`${captured}.declare(${str(n.name)},${q},false,${at});${env}.declare(${str(n.name)},${q},false,${at})`);
      } else if(n.kind==='bind') {
        const vs=values.splice(values.length-n.patterns.length),matched=`e${next++}`;
        ctx.lines.push(`${matched}:=fresh();if !matches([]Pattern{${n.patterns.map(pattern)}},[]any{${vs}},${matched}) {fail(${at},"Assignment pattern did not match")}`);
        n.names.forEach((name,i)=>ctx.lines.push(`${env}.declare(${str(name)},${matched}.read(${str(name)}),${n.mutable[i]},${at})`));
      } else if(n.kind==='case') {
        const original=[...values],outputs=items(info.output).map(()=>`v${next++}`),matched=`matched${next++}`;
        outputs.forEach(v=>ctx.lines.push(`var ${v} any;_=${v}`));ctx.lines.push(`${matched}:=false`);
        for(const branch of n.branches) {
          const count=branch.patterns.length,e=`e${next++}`,args=count?original.slice(-count):[];
          let trial=count?original.slice(0,-count):[...original];
          ctx.lines.push(`if !${matched} {${e}:=${env}.clone();_=${e};if matches([]Pattern{${branch.patterns.map(pattern)}},[]any{${args}},${e}) {`);
          if(branch.guard) {
            const g=`e${next++}`;ctx.lines.push(`${g}:=${e}.clone();_=${g}`);
            trial=emit(branch.guard,trial,g,new Map(),trace,ctx);
            if(trial.never){ctx.lines.push('} }');continue;}
            ctx.lines.push(`if boolean(${trial.pop()},${location(branch.token)}) {`);
          }
          const result=emit(branch.body,trial,e,new Map(),trace,ctx);
          if(outputs.length && !result.never)ctx.lines.push(`${outputs}=${result}`);
          ctx.lines.push(`${matched}=true`);
          if(branch.guard)ctx.lines.push('}');ctx.lines.push('} }');
        }
        ctx.lines.push(`if !${matched} {fail(${at},"No matching case branch")}`);
        values=outputs;
      } else if(n.kind==='update') {
        const result=child(n.body);
        (n.names||[n.name]).forEach((name,i)=>ctx.lines.push(`${env}.update(${str(name)},${result[i]},${at})`));
      } else if(n.kind==='binary' || n.kind==='comparison-chain') {
        const missing=missingOperands([n]).filter(h=>!holes.has(h)),bindings=new Map(holes),vs=missing.length?values.splice(-missing.length):[];
        bindings.references=holes.references;
        missing.forEach((h,i)=>bindings.set(h,vs[i]));
        if(n.kind==='comparison-chain') {
          let left=child(n.operands[0],[],bindings)[0];
          const result=ctx.value('true');let closed=false;
          for(let i=0;i<n.operators.length;i++) {
            const op=n.operators[i];let right;
            try{right=child(n.operands[i+1],[],bindings)[0];}
            catch(error){if(!(error instanceof StoppedEmission)||i===0)throw error;for(let j=0;j<i;j++)ctx.lines.push('}');closed=true;break;}

            ctx.lines.push(`${result}=${binaryCall(op,left,right,info.operatorEffects[i],ctx)}`);
            if(i<n.operators.length-1)ctx.lines.push(`if boolean(${result},${location(op)}) {`);
            left=right;
          }
          if(!closed)for(let i=1;i<n.operators.length;i++)ctx.lines.push('}');
          values.push(result);continue;
        }
        if(['&&','||'].includes(n.value)){
          const a=child(n.left,[],bindings)[0],result=ctx.value(a);let condition=a;
          if(n.value==='||'){const type=T.prune(info.orElsePredicate.dispatchType),target=definitions.classes.get('orElse').instances.get(instanceKey(type))?.implementations.get('hasValue');if(!target)throw new StaticTypeError('Ambiguous orElse instance',n);const spec=named(target,info.orElsePredicate);condition=ctx.call(`m.${spec.fn}`,[a],1)[0];}
          ctx.lines.push(`if ${n.value==='||'?'!':''}boolean(${condition},${at}) {`);
          try{const b=child(n.right,[],bindings)[0];const selected=n.value==='||'?binaryCall(n,a,b,info.operatorEffects[0],ctx):b;ctx.lines.push(`${result}=${selected}`);}catch(error){if(!(error instanceof StoppedEmission))throw error;}
          ctx.lines.push('}');values.push(result);continue;
        }
        const a=child(n.left,[],bindings)[0],b=child(n.right,[],bindings)[0];
        values.push(binaryCall(n,a,b,info.operatorEffects[0],ctx));
      } else if(info.env.has(n.value)) {
        const value=ctx.value(`${env}.read(${str(n.value)})`);
        if(info.env.get(n.value).callable)invoke(ctx,value,values,info.effect,at);
        else values.push(value);
        if(n.ephemeral)ctx.lines.push(`delete(${env}.values,${str(n.value)});delete(${env}.locals,${str(n.value)})`);
      }
      else if(definitions.methods?.has(n.value) && !definitions.methods.get(n.value).specialEach && !definitions.methods.get(n.value).specialShow && !definitions.methods.get(n.value).specialIndex && !definitions.methods.get(n.value).specialCast && !definitions.methods.get(n.value).specialBits) {
        const m=definitions.methods.get(n.value),input=items(T.prune(info.effect).input);
        let type=T.prune(info.effect.dispatchType||input[input.length-m.inputCount+m.dispatchIndex]);if(type.numericLiterals){T.unify(type,{tag:'atom',name:'int'},n);type=T.prune(type);}
        const target=lookupInstance(definitions.classes.get(m.className),(info.effect.dispatchTypes||[type]).map(t=>{t=T.prune(t);if(t.numericLiterals){T.unify(t,{tag:'atom',name:'int'},n);t=T.prune(t);}return t;}))?.implementations.get(n.value);
        if(!target)throw new StaticTypeError(`Ambiguous or unresolved class method: ${n.value}; add a type annotation`,n);
        const spec=named(target,info.effect),vs=values.splice(values.length-spec.input.length);
        values.push(...ctx.call(`m.${spec.fn}`,vs,spec.output.length));
      }
      else if(definitions.has(n.value)) {
        const spec=named(n.value,info.effect),vs=values.splice(values.length-spec.input.length);
        values.push(...ctx.call(`m.${spec.fn}`,vs,spec.output.length));
      } else if(definitions.constructors?.has(n.value)) {
        const c=definitions.constructors.get(n.value),vs=c.fields.length?values.splice(-c.fields.length):[];
        values.push(ctx.value(`&ADT{${str(c.typeName)},${str(c.name)},[]any{${vs}}}`));
      } else if(definitions.effects?.has(n.value)) {
        const op=definitions.effects.get(n.value),args=op.syntax.input[0]?.tag==='stack-row'?values.splice(0):op.inputCount?values.splice(-op.inputCount):[];
        const result=`effect${next++}`;ctx.lines.push(`${result}:=m.performRoute(${str(n.value)},[]any{${args}},${at},${!!op.never},${n.target?`labelTarget(${env}.read(${str(n.target)}),${at})`:"nil"},0);_=${result}`);
        for(let i=0;i<(op.syntax.output[0]?.tag==='stack-row'?items(info.effect.output).length:op.outputCount);i++)values.push(ctx.value(`${result}[${i}]`));
      } else builtin(n,info,values,ctx,env,at);
      if(T.isBottom(info.output)){ctx.lines.push('panic("Non-returning computation returned")');return neverValues();}
      } catch(error){if(error instanceof StoppedEmission)return neverValues();throw error;}
    }
    ctx.lines.push('m.depth--');return values;
  }
  function walker(ctx,value,type,at) {
    type=T.prune(type);
    if(type.tag==='stream')return `${value}.(*Stream).walk`;
    if(type.tag==='var')return ctx.value(`&Stream{func(m *Machine,visit func(any)){m.walkUnresolved(${value},visit,${at})}}`)+'.(*Stream).walk';
    const name=`walk${next++}`;
    ctx.lines.push(`${name}:=func(m *Machine,visit func(any)){`);
    if(type.tag==='list')ctx.lines.push(`for _,x:=range list(${value},${at}){visit(x)}`);
    else if(type.tag==='atom' && type.name==='range')ctx.lines.push(`r:=${value}.(*Range);for i:=0;i<r.count();i++{m.tick(${at});visit(r.start+int64(i)*r.step())}`);
    else {
      const instance=definitions.classes?.get('streem')?.instances.get(instanceKey(type)),target=instance?.implementations.get('each');
      if(!target)throw new Error('No native each instance for '+formatType(type));
      const item=T.variable(),callback=T.quote(T.stack(T.EMPTY,item),T.EMPTY),effect=T.quote(T.stack(T.EMPTY,type,callback),T.EMPTY);
      const spec=named(target,effect);
      ctx.lines.push(`m.${spec.fn}(${value},&NativeVisitor{visit})`);
    }
    ctx.lines.push('}');return name;
  }
  function transformedStream(name,mode,source,sourceType,arg,argType,label,ctx,at) {
    const walk=walker(ctx,source,sourceType,at),inner=context();let count=null;
    if(countTransform(mode))count=ctx.value(`m.iterationCount(${arg},${str(name)},${at})`);
    if(callbackTransform(mode)) {
      const mapped=['item'];invoke(inner,arg,mapped,T.prune(argType),at);
      if(T.prune(argType).originalNever)inner.lines.push('panic("Non-returning callback returned")');
      else if(mode==='map')inner.lines.push(`visit(${mapped[0]})`);
      else if(mode==='flatMap') {const nestedType=T.prune(T.prune(argType).output).item,nested=walker(inner,mapped[0],nestedType,at);inner.lines.push(`${nested}(m,visit)`);}
      else if(mode==='filter')inner.lines.push(`if boolean(${mapped[0]},${at}){visit(item)}`);
      else if(mode==='takeWhile')inner.lines.push(`if !boolean(${mapped[0]},${at}){stop()};visit(item)`);
      else inner.lines.push(`if !boolean(${mapped[0]},${at}){skipping=false;visit(item)}`);
    } else if(mode==='flatten') {const nested=walker(inner,'item',T.iterableItem(sourceType),at);inner.lines.push(`${nested}(m,visit)`);}
    else if(mode==='skip')inner.lines.push('if remaining>0{remaining--;return};visit(item)');
    else inner.lines.push('visit(item);remaining--;if remaining==0{stop()}');
    const prefix=mode==='skipWhile'?'if !skipping{visit(item);return};':'';
    const state=count?`remaining:=${count}.(float64);${mode==='take'?'if remaining==0{return};':''}`:mode==='skipWhile'?'skipping:=true;':'';
    return ctx.value(`&Stream{func(m *Machine,visit func(any)){iterationBoundary(func(stop func()){${state}m.loop(func(m *Machine){${walk}(m,func(item any){${prefix}${inner.lines.join(';')}})},${at},${streamTransforms.has(name)?label:'nil'},${!streamTransforms.has(name)})})}}`);
  }
  function indexCall(name,args,effect,ctx,at,reuse=false){
    const inputs=items(T.prune(effect).input),type=T.prune(effect.dispatchType||inputs.at(name==='at'?-2:-3));
    const target=definitions.classes.get(name==='at'?'indexGet':'indexSet')?.instances.get(instanceKey(type))?.implementations.get(name);
    if(target){const spec=named(target,effect);return ctx.call(`m.${spec.fn}`,args,1)[0];}
    return ctx.value(name==='at'?`m.listIndex(${args},${at})`:`m.indexSetOwned(${args},${at},${reuse})`);
  }
  function shown(value,type,ctx,at,rawString=false) {
    type=T.prune(type);
    const target=definitions.classes.get('show')?.instances.get(instanceKey(type))?.implementations.get('show');
    if(target){const effect=T.instantiate(types.functions.get('show'));T.unify(effect.input,T.stack(T.EMPTY,type));const spec=named(target,effect);return ctx.call(`m.${spec.fn}`,[value],1)[0];}
    return ctx.value(`${rawString?'outputText':'text'}(${value})`);
  }
  function builtin(n,info,v,ctx,env,at) {
    const name=n.value,pop=()=>v.pop(),topTypes=items(info.input),label=n.handlerLabel?`${env}.read(${str(n.handlerLabel)}).(*EffectLabel)`:'nil';
    const call=(q,t,values=v)=>invoke(ctx,q,values,T.prune(t),at);
    const returnedBreak=(result)=>{ctx.lines.push(`_=${result}`);if(v.length)ctx.lines.push(`if ${result}!=nil{${v}=${v.map((_,i)=>`${result}[${i}]`)}}`);};
    if(['windows','chunks','chunkBy','groupBy'].includes(name)){
      const arg=pop(),source=pop(),walk=walker(ctx,source,topTypes.at(-2),at),keyed=['chunkBy','groupBy'].includes(name),inner=context();
      let key='nil',count='int64(0)';
      if(keyed){const vs=['item'];invoke(inner,arg,vs,T.prune(topTypes.at(-1)),at);inner.lines.push(T.prune(topTypes.at(-1)).originalNever?'panic("Non-returning callback returned")':`return ${vs[0]}`);key=`func(item any)any{${inner.lines.join(';')}}`;}
      else count=ctx.value(`m.partitionCount(${arg},${str(name)},${at})`)+'.(int64)';
      if(name==='groupBy'){const result=ctx.value('&Dict{}'),br=`breakResult${next++}`;ctx.lines.push(`${br}:=m.loop(func(m *Machine){m.groupItems(${walk},${key},${result}.(*Dict))},${at},${label})`);v.push(result);returnedBreak(br);}
      else v.push(ctx.value(`&Stream{func(m *Machine,visit func(any)){m.loop(func(m *Machine){m.partitionItems(${walk},${key},${count},${str(name)},visit,${at})},${at},${label})}}`));
      return;
    }
    if(name==='nth'){
      const index=pop(),source=pop(),walk=walker(ctx,source,topTypes.at(-2),at),result=ctx.value('optionValue(nil,false)'),count=`remaining${next++}`,br=`breakResult${next++}`;
      ctx.lines.push(`${count}:=${index}.(int64);var ${br} []any;if ${count}>=0{iterationBoundary(func(stop func()){${br}=m.loop(func(m *Machine){${walk}(m,func(item any){if ${count}==0{${result}=optionValue(item,true);stop()};${count}--})},${at},${label})})}`);v.push(result);returnedBreak(br);return;
    }
    if(name==='zip'||name==='vzip'){
      const right=pop(),left=pop(),lw=walker(ctx,left,topTypes.at(-2),at),rw=walker(ctx,right,topTypes.at(-1),at);
      const body=`m.walkZip(${lw},${rw},visit,${at})`;
      if(name==='zip')v.push(ctx.value(`&Stream{func(m *Machine,visit func(any)){m.loop(func(m *Machine){${body}},${at},${label})}}`));
      else{const result=`zip${next++}`,br=`breakResult${next++}`;ctx.lines.push(`${result}:=[]any{};${br}:=m.loop(func(m *Machine){m.walkZip(${lw},${rw},func(item any){${result}=append(${result},item)},${at})},${at},${label})`);v.push(ctx.value(result));returnedBreak(br);}return;
    }
    if(transforms.has(name)) {
      const mode=transforms.get(name),arg=mode==='flatten'?null:pop(),source=pop(),sourceType=topTypes.at(mode==='flatten'?-1:-2),argType=mode==='flatten'?null:topTypes.at(-1);
      const stream=transformedStream(name,mode,source,sourceType,arg,argType,label,ctx,at);
      if(streamTransforms.has(name))v.push(stream);
      else {const result=`collected${next++}`,br=`breakResult${next++}`;ctx.lines.push(`${result}:=[]any{};${br}:=m.loop(func(m *Machine){${stream}.(*Stream).walk(m,func(item any){${result}=append(${result},item)})},${at},${label})`);v.push(ctx.value(result));returnedBreak(br);}
      return;
    }
    if(['at','setAt'].includes(name)){const args=v.splice(-(name==='at'?2:3));v.push(indexCall(name,args,info.effect,ctx,at));return;}
    if(combinationNames.has(name)){
      const arg=name==='powerset'?null:pop(),source=pop(),walk=walker(ctx,source,topTypes.at(arg?-2:-1),at),rows=`choices${next++}`;
      let count='float64(0)',other='nil',extra='';
      if(name==='cartesianProduct'){const rightWalk=walker(ctx,arg,topTypes.at(-1),at);other=`other${next++}`;extra=`${other}:=[]any{};m.loop(func(m *Machine){${rightWalk}(m,func(v any){${other}=append(${other},v)})},${at},nil);`;}
      else if(arg){const checked=ctx.value(`m.iterationCount(${arg},${str(name)},${at})`);count=`number(${checked},${at})`;}
      v.push(ctx.value(`&Stream{func(m *Machine,visit func(any)){${rows}:=[]any{};m.loop(func(m *Machine){${walk}(m,func(v any){${rows}=append(${rows},v)})},${at},nil);${extra}m.combinations(${rows},${other},${count},${str(name)},visit,${at})}}`));return;
    }
    if(name==='values'){const source=pop();v.push(ctx.value(`&Stream{func(m *Machine,visit func(any)){for _,pair:=range ${source}.(*Dict).entries{visit(pair[1])}}}`));return;}
    if(name==='split') {
      const separator=pop(),source=pop();v.push(ctx.value(`&Stream{func(m *Machine,visit func(any)){m.walkSplit(${source},${separator},visit,${at})}}`));return;
    }
    if(name==='join') {
      const separator=pop(),source=pop(),walk=walker(ctx,source,topTypes.at(-2),at),parts=`parts${next++}`,br=`breakResult${next++}`;
      ctx.lines.push(`${parts}:=[]string{};${br}:=m.loop(func(m *Machine){${walk}(m,func(item any){${parts}=append(${parts},stringValue(item,${at}))})},${at},${label})`);
      v.push(ctx.value(`strings.Join(${parts},stringValue(${separator},${at}))`));returnedBreak(br);return;
    }
    if(definitions.methods?.get(name)?.specialCast){
      const value=pop(),conversion=T.castInfo(definitions,n,info.effect),target=conversion.target;
      if(target!==name){const spec=named(target,info.effect);v.push(...ctx.call(`m.${spec.fn}`,[value],1));}
      else v.push(ctx.value(`m.numericCast(${value},${str(conversion.destination)},${at})`));return;
    }
    if(name==='bytes'){v.push(ctx.value(`byteValues(${pop()},${at})`));return;}
    if(name==='chars'){v.push(ctx.value(`chars(${pop()},${at})`));return;}
    if(name==='toNum'||name==='parseNum'){v.push(ctx.value(`m.parseNumber(${pop()},${name==='toNum'},${at})`));return;}
    if(name==='fromYield') {
      const q=pop(),inv=invocation(info.bodyType),body=context();body.call(`m.${inv.name}`,[q,at],inv.output.length);
      v.push(ctx.value(`&Stream{func(m *Machine,visit func(any)){m.handle(func(m *Machine) []any {${body.lines.join(';')};return nil},map[string]EffectHandler{"yield":func(args []any,k *Continuation) []any {visit(args[0]);return resumeContinuation(k,nil,${at})}},${at},${label})}}`));return;
    }
    if(['reverse','sort','sortBy'].includes(name)) {
      const q=name==='sortBy'?pop():null,source=pop(),walk=walker(ctx,source,topTypes.at(q?-2:-1),at),rows=`sorted${next++}`,result=`collected${next++}`,br=`breakResult${next++}`;
      ctx.lines.push(`${rows}:=[]SortItem{};${br}:=m.loop(func(m *Machine){${walk}(m,func(item any){`);
      const keyCtx=context();let key='item';
      if(q){const values=['item'];invoke(keyCtx,q,values,topTypes.at(-1),at);key=values[0];}
      ctx.lines.push(...keyCtx.lines,`${rows}=append(${rows},SortItem{item,${key}})`, `})},${at},${label})`);
      if(name==='reverse')ctx.lines.push(`for i,j:=0,len(${rows})-1;i<j;i,j=i+1,j-1{${rows}[i],${rows}[j]=${rows}[j],${rows}[i]}`);
      else {
        const cmp=context(),less=binaryCall({...n,value:'<'},'a','b',info.comparison,cmp);
        ctx.lines.push(`if ${br}==nil{${br}=m.loop(func(m *Machine){stableSort(&${rows},func(a,b any) bool {m.tick(${at});${cmp.lines.join(';')};return boolean(${less},${at})})},${at},${label})}`);
      }
      ctx.lines.push(`${result}:=[]any{};for _,item:=range ${rows}{${result}=append(${result},item.value)}`);v.push(ctx.value(result));returnedBreak(br);return;
    }
    if(name==='max'||name==='min'){
      const b=pop(),a=pop(),less=binaryCall({...n,value:'<'},b,a,info.comparison,ctx),result=ctx.value(name==='max'?b:a);
      ctx.lines.push(`if boolean(${less},${at}){${result}=${name==='max'?a:b}}`);v.push(result);return;
    }
    if(['maxi','mini','maxiBy','miniBy','all','any'].includes(name)){
      const predicate=name==='all'||name==='any',q=['maxi','mini'].includes(name)?null:pop(),source=pop(),walk=walker(ctx,source,topTypes.at(q?-2:-1),at),result=ctx.value(predicate?String(name==='all'):'nil'),found=`found${next++}`,bestKey=`key${next++}`,br=`breakResult${next++}`;
      if(!predicate)ctx.lines.push(`${found}:=false;_=${found};var ${bestKey} any;_=${bestKey}`);
      ctx.lines.push(`var ${br} []any;iterationBoundary(func(stop func()){${br}=m.loop(func(m *Machine){${walk}(m,func(item any){`);
      const inner=context();let key='item';if(q){const values=['item'];invoke(inner,q,values,topTypes.at(-1),at);key=values[0]||'nil';}
      ctx.lines.push(...inner.lines);
      if(predicate)ctx.lines.push(`${result}=boolean(${key},${at});if ${name==='all'?'!':''}boolean(${result},${at}){stop()}`);
      else{
        const cmp=context(),less=binaryCall({...n,value:'<'},key,bestKey,info.comparison,cmp),replace=name.startsWith('maxi')?'!':'';
        ctx.lines.push(`if !${found}{${result}=item;${bestKey}=${key};${found}=true}else{`,...cmp.lines,`if ${replace}boolean(${less},${at}){${result}=item;${bestKey}=${key}}}`);
      }
      ctx.lines.push(`})},${at},${label})})`);
      v.push(predicate?result:ctx.value(`optionValue(${result},${found})`));returnedBreak(br);return;
    }
    if(['xor','testBit','setBit','clearBit'].includes(name)){
      const b=pop(),a=pop(),m=definitions.methods.get(name),target=definitions.classes.get(m.className).instances.get(instanceKey(T.prune(topTypes.at(-2))))?.implementations.get(name);
      if(target){const spec=named(target,info.effect);v.push(...ctx.call(`m.${spec.fn}`,[a,b],1));}
      else v.push(ctx.value(`m.bitOperation(${str(name)},${a},${b},${at})`));return;
    }
    if(name==='toVector') {
      const source=pop(),walk=walker(ctx,source,topTypes.at(-1),at),result=`collected${next++}`,br=`breakResult${next++}`;
      ctx.lines.push(`${result}:=[]any{};${br}:=m.loop(func(m *Machine){${walk}(m,func(item any){${result}=append(${result},item)})},${at},${label})`);v.push(ctx.value(result));returnedBreak(br);return;
    }
    if(['+','-','*','/','%','^','<','>','<=','>=','==','/=','&&','||','.&.','.|.','.<<.','.>>.','cons','push','Push','::','concat','++','range','..','..='].includes(name)) {
      const b=pop(),a=pop();v.push(ctx.value(vectorReuse.has(n)&&T.prune(topTypes.at(-2)).tag==='list'&&['push','Push','::','concat','++'].includes(name)?`vectorAppend(${a},${b},${['concat','++'].includes(name)},${at})`:`binary(${str(name)},${a},${b},${at})`));
    } else if(['not','head','tail','length'].includes(name))v.push(ctx.value(`unary(${str(name)},${pop()},${at})`));
    else if(name==='nop'){}
    else if(name==='dup')v.push(v.at(-1));
    else if(name==='drop')pop();
    else if(name==='swap'){const b=pop(),a=pop();v.push(b,a);}
    else if(name==='over')v.push(v.at(-2));
    else if(name==='rot'){const [a,b,c]=v.splice(-3);v.push(b,c,a);}
    else if(name==='show')v.push(shown(pop(),topTypes.at(-1),ctx,at));
    else if(name==='print')ctx.lines.push(`m.perform("put",[]any{outputText(${pop()})},${at},false)`);
    else if(name==='handle') {
      const handlers=pop(),body=pop(),inv=invocation(info.bodyType),entries=[];
      const pack=(receiver,inv,args)=>{
        const names=Array.from({length:inv.output.length},(_,i)=>`r${i}`),call=`${receiver}.${inv.name}(${args})`;
        return `${names.length?`${names.join(',')}:=`:''}${call};return []any{${names.join(',')}}`;
      };
      for(const [name,type] of info.handlers){
        const handler=invocation(type),count=effectParts(type).input.length-1;
        entries.push(`${str(name)}:func(args []any,k *Continuation) []any {${pack('m',handler,[`recordField(${handlers},${str(name)},${at})`,at,...Array.from({length:count},(_,i)=>`args[${i}]`),'k'].join(','))}}`);
      }
      const result=`results${next++}`;
      ctx.lines.push(`${result}:=m.handle(func(child *Machine) []any {${pack('child',inv,`${body},${at}`)}},map[string]EffectHandler{${entries.join(',')}},${at},${label});_=${result}`);
      const count=items(info.output).length-v.length;
      for(let i=0;i<count;i++)v.push(ctx.value(`${result}[${i}]`));
    }
    else if(name==='resume') {
      const k=pop(),type=T.prune(topTypes.at(-1)),parts=effectParts(type),args=parts.input.length?v.splice(-parts.input.length):[],result=`results${next++}`;
      ctx.lines.push(`${result}:=resumeContinuation(${k},[]any{${args}},${at});_=${result}`);
      for(let i=0;i<parts.output.length;i++)v.push(ctx.value(`${result}[${i}]`));
    }
    else if(name==='call'){const q=pop();call(q,topTypes.at(-1));}
    else if(name==='dip'){const q=pop(),x=pop();call(q,topTypes.at(-1));v.push(x);}
    else if(name==='if'||name==='when') {
      const no=name==='if'?pop():null,yes=pop(),condition=pop(),type=topTypes.at(name==='if'?-2:-1),original=[...v];
      const outCount=items(info.output).length;
      const outputs=Array.from({length:outCount},()=>`v${next++}`);
      outputs.forEach(x=>ctx.lines.push(`var ${x} any;_=${x}`));
      ctx.lines.push(`if boolean(${condition},${at}) {`);call(yes,type);if(outputs.length && !T.isBottom(T.prune(type).output))ctx.lines.push(`${outputs}=${v}`);
      ctx.lines.push('} else {');v.splice(0,v.length,...original);if(no)call(no,topTypes.at(-1));if(outputs.length && (!no || !T.isBottom(T.prune(topTypes.at(-1)).output)))ctx.lines.push(`${outputs}=${v}`);
      ctx.lines.push('}');v.splice(0,v.length,...outputs);
    } else if(name==='while') {
      const body=pop(),condition=pop(),bodyType=T.prune(topTypes.at(-1)),conditionType=T.prune(topTypes.at(-2));
      if(T.isBottom(conditionType.output)){call(condition,conditionType);return;}
      const breakResult=`breakResult${next++}`,state=v.map(x=>ctx.value(x));v.splice(0,v.length,...state);
      ctx.lines.push(`for {m.tick(${at})`);call(condition,conditionType);const flag=pop();
      // The final condition can change the number of carried values.
      const finals=v.map(()=>`v${next++}`);
      const beforeLoop=ctx.lines.findLastIndex(line=>line===`for {m.tick(${at})`);
      ctx.lines.splice(beforeLoop,0,...finals.map((x,i)=>`var ${x} any${state.length===finals.length?'='+state[i]:''};_=${x}`),`${breakResult}:=m.loop(func(m *Machine){`);
      if(state.length===finals.length && finals.length)ctx.lines.splice(beforeLoop+finals.length+2,0,`${finals}=${state}`);
      if(finals.length)ctx.lines.push(`${finals}=${v}`);
      ctx.lines.push(`if !boolean(${flag},${at}) {break}`);call(body,bodyType);
      if(T.isBottom(bodyType.output))ctx.lines.push('panic("Non-returning loop body returned")');else if(state.length)ctx.lines.push(`${state}=${v}`);ctx.lines.push('}');ctx.lines.push(`},${at},${label});_=${breakResult}`);if(finals.length)ctx.lines.push(`if ${breakResult}!=nil{${finals}=${finals.map((_,i)=>`${breakResult}[${i}]`)}}`);v.splice(0,v.length,...finals);
    } else if(['each','vmap','vfilter','fold'].includes(name)) {
      const containerType=T.prune(topTypes.at(name==='fold'?-3:-2));


      const q=pop(),qType=T.prune(topTypes.at(-1)),acc=name==='fold'?pop():null,xs=pop();
      const state=v.map(x=>ctx.value(x)),accName=acc?ctx.value(acc):null;
      const breakResult=`breakResult${next++}`,result=`list${next++}`,x=`item${next++}`;
      if(['vmap','vfilter'].includes(name))ctx.lines.push(`${result}:=[]any{}`);
      const walk=walker(ctx,xs,containerType,at);ctx.lines.push(`${breakResult}:=m.loop(func(m *Machine){`);
      ctx.lines.push(`${walk}(m,func(${x} any){`);
      v.splice(0,v.length,...state);if(accName)v.push(accName);v.push(x);call(q,qType);
      if(T.isBottom(qType.output))ctx.lines.push('panic("Non-returning callback returned")');else {
      if(name==='vmap')ctx.lines.push(`${result}=append(${result},${pop()})`);
      if(name==='vfilter')ctx.lines.push(`if boolean(${pop()},${at}) {${result}=append(${result},${x})}`);
      if(accName)ctx.lines.push(`${accName}=${pop()}`);
      if(state.length)ctx.lines.push(`${state}=${v}`);}
      ctx.lines.push('})');ctx.lines.push(`},${at},${label})`);
      v.splice(0,v.length,...state);if(accName)v.push(accName);if(['vmap','vfilter'].includes(name))v.push(ctx.value(result));ctx.lines.push(`_=${breakResult}`);if(v.length)ctx.lines.push(`if ${breakResult}!=nil{${v}=${v.map((_,i)=>`${breakResult}[${i}]`)}}`);
    } else if(name==='compose') {
      const portable=type=>{const {input,output}=effectParts(T.prune(type)),tail=T.row();return T.mono(T.quote(T.stack(tail,...input),T.stack(tail,...output)));};
      const b=pop(),a=pop(),captured=new Map([['__a',portable(topTypes.at(-2))],['__b',portable(topTypes.at(-1))]]);
      const body=['__a','call','__b','call'].map(value=>({...n,kind:'word',value}));
      const id=registerSite(n,captured,body),e=`e${next++}`;
      ctx.lines.push(`${e}:=fresh();${e}.declare("__a",${a},false,${at});${e}.declare("__b",${b},false,${at})`);
      v.push(ctx.value(`&Quote{${id},${e}}`));
    } else throw new Error(`Unsupported native builtin: ${name}`);
  }
  const init=definitions.initializers||[],initialEnv=new Map();initialEnv.locals=new Set();
  const initial=types.analyze(init,T.EMPTY,initialEnv),initialCtx=context();
  emit(init,[],'m.globals',new Map(),initial.trace,initialCtx);
  const entryEnv=new Map(types.globals),analysis=types.analyze(entry,T.EMPTY,entryEnv),mainCtx=context();
  const results=emit(entry,[],'m.globals',new Map(),analysis.trace,mainCtx);
  // Discover only reachable quotation arities, then compile compatible bodies.
  let changed=true;
  while(changed) {
    changed=false;
    for(const inv of invocations)for(const site of sites) {
      if(inv.handlers.has(site.id))continue;
      inv.handlers.set(site.id,null);changed=true;
      const signature=freshTypes(inv.input,inv.output,inv.effects),env=copyEnv(site.env);
      let typed;
      try {typed=types.analyze(site.body,signature.input,env,site.node.blockLabel);if(T.isBottom(signature.output)&&!T.isBottom(typed.output))continue;T.checkNeverPromises(typed.output,signature.output,site.node);T.unify(typed.output,signature.output,site.node);if(typedDispatch){T.specializeEffects(typed.effects,signature.effects,site.node);types.validate(site.body,typed.trace);}}
      catch(error){if(error instanceof StaticTypeError)continue;throw error;}
      const ctx=context(),vs=emit(site.body,args(inv.input.length),'e',new Map(),typed.trace,ctx);
      if(site.node.blockLabel) {
        const result=`labelResult${next++}`;
        inv.handlers.set(site.id,`${result}:=m.labelBlock(func(m *Machine,label *EffectLabel) []any {
e:=e.clone();e.declare(${str(site.node.blockLabel)},label,false,loc)
${ctx.lines.join('\n')}
${vs.never?'panic("Non-returning computation returned")':`return []any{${vs}}`}
},loc)
_=${result}
${inv.output.never?'panic("Non-returning computation returned")':`return ${inv.output.map((_,i)=>`${result}[${i}]`).join(',')}`}`);
      } else {finish(ctx,vs);inv.handlers.set(site.id,ctx.lines.join('\n'));}
    }
  }
  if(typedDispatch)for(const inv of invocations)if(![...inv.handlers.values()].some(Boolean))
    throw new StaticTypeError('Ambiguous or unsupported quotation specialization; add a type annotation');
  const dispatch=invocations.map(inv=>`func(m *Machine) ${inv.name}(value any,loc string${inv.input.length?','+params(inv.input.length):''}) ${returns(inv.output.length)} {
${inv.input.length===1 && inv.output.length===0?'if visitor,ok:=value.(*NativeVisitor);ok{visitor.visit(a0);return}':''}
q:=quotation(value,loc); e:=q.env.clone();_ = e
switch q.id {${[...inv.handlers].filter(([,body])=>body).map(([id,body])=>`case ${id}:\n${body}`).join('\n')}}
fail(loc,"Unsupported quotation specialization");${failReturn(inv.output.length)}
}`);
  const main=`func main(){defer func(){if err:=recover();err!=nil {fmt.Fprintln(os.Stderr,"Error:",err);os.Exit(1)}}()
m:=&Machine{globals:fresh(),budget:new(int)}
${initialCtx.lines.join('\n')}
${mainCtx.lines.join('\n')}
${showStack?`fmt.Println(text([]any{${results}}))`:''}
}`;
  return readFileSync(new URL('./go-direct-runtime.go.txt',import.meta.url),'utf8')+'\n'+readFileSync(new URL('./go-effects-runtime.go.txt',import.meta.url),'utf8')+'\n'+functions.join('\n\n')+'\n'+dispatch.join('\n\n')+'\n'+main+'\n';
}
