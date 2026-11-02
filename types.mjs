import {classParameters,instanceHeads,relationKey,superConstraints,lookupInstance,builtinConversion} from './class-relations.mjs';
import {resolveInheritance} from './class-inheritance.mjs';
import {withStandardFunctions} from './builtin-functions.mjs';
import {combinationNames} from './combinatorics.mjs';
import {transforms,streamTransforms,countTransform,predicateTransform,callbackTransform} from './iteration.mjs';
import {withOption,isStandardOption} from './builtin-option.mjs';
import {ioEffects,effectFamilies} from './builtin-effects.mjs';
import {classConstraint} from './class-syntax.mjs';
import {lowerName,instanceKey} from './type-names.mjs';
import {operatorFallback,operatorSpecs,builtinInstance,installOperatorClasses} from './operator-classes.mjs';
// Hindley–Milner-style value and stack-row inference. No program code is run.
import { typeSyntax, patternNames } from './type-syntax.mjs';
export class StaticTypeError extends Error {
  constructor(message, token) {
    super(`${token ? `${token.file}:${token.line}:${token.col}: ` : ''}Type error: ${message}`);
    this.name = 'StaticTypeError';
    this.token = token;
  }
}
let nextId = 0;
let activeClasses=new Map();
let activeEffects=new Map();
let activeFamilies=new Map();
let activeProtected=new Set();
let checkingUniversalHandler=false;
function requireConstraint(name,args,token) {
  const c=activeClasses.get(name);if(!c)throw new StaticTypeError(`Unknown class: ${name}`,token);
  if(classParameters(c).length>1){if(args.length===classParameters(c).length&&c.associated?.length)args=[...args,...c.associated.map(()=>variable())];return requireRelation(c,args,token);}
  if(name==='streem'){if(args.length!==1 && args.length!==2)throw new StaticTypeError('Invalid streem constraint arity',token);return requireIterable(args[0],args[1]||variable(),token);}
  if(c.associated?.length){
    if(args.length===1)args=[...args,...c.associated.map(()=>variable())];
    if(args.length!==1+c.associated.length)throw new StaticTypeError(`Invalid class constraint arity: ${name}`,token);
    return requireAssociated(c,args[0],args.slice(1),token);
  }
  if(args.length!==1)throw new StaticTypeError(`Invalid class constraint arity: ${name}`,token);
  return requireClass(name,args[0],token);
}
function applyContext(context,parameters,token){for(const [name,...params] of context)requireConstraint(name,params.map(p=>typeof p==='string'?(parameters.get(p)||atom(p)):syntaxType(p,parameters)),token);}
function argumentVariables(args){const out=new Set(),seen=new Set();function visit(t){t=prune(t);if(seen.has(t))return;seen.add(t);if(t.tag==='var'||t.tag==='rigid')out.add(t);else children(t).forEach(visit);}args.forEach(visit);return [...out];}
function sameType(a,b){a=prune(a);b=prune(b);if(a===b)return true;if(['var','rigid'].includes(a.tag)||['var','rigid'].includes(b.tag)||a.tag!==b.tag||a.name!==b.name)return false;const aa=children(a),bb=children(b);return aa.length===bb.length&&aa.every((t,i)=>sameType(t,bb[i]));}
function inheritedConstraints(c,args,seen=new Set()){
 const identity=t=>{t=prune(t);return t.id??[t.tag,t.name,...children(t).map(identity)].join(':');};const key=c.name+':'+args.map(identity).join(',');if(seen.has(key))return [];seen.add(key);
 const bindings=new Map(classParameters(c).map((p,i)=>[p,args[i]]));for(const [i,a] of (c.associated||[]).entries())bindings.set(a.param,args[classParameters(c).length+i]);
 return [{name:c.name,args},...superConstraints(c).flatMap(sc=>{const pc=activeClasses.get(sc.name),values=sc.args.map(t=>syntaxType(t,bindings));if(sc.name==='streem'&&c.associated?.some(a=>a.name==='item'))values.push(bindings.get(c.associated.find(a=>a.name==='item').param));else for(const a of pc.associated||[])values.push(bindings.get(a.param));return inheritedConstraints(pc,values,seen);})];
}
// Rigid anchors carry declared evidence; mutable anchors carry deferred obligations.
function constraintFacts(v,wanted){
 const facts=[...[...v.classes||[]].flatMap(n=>inheritedConstraints(activeClasses.get(n),[v])),...[...v.associated||[]].flatMap(([n,ts])=>inheritedConstraints(activeClasses.get(n),[v,...ts]))];
 for(const r of v.relations||[])if(v.tag==='rigid'||r.name!==wanted)facts.push(...inheritedConstraints(activeClasses.get(r.name),r.args));
 return facts;
}
function hasRelationEvidence(c,args){
 return argumentVariables(args).some(v=>constraintFacts(v,c.name).some(r=>r.name===c.name&&r.args.length===args.length&&r.args.every((t,i)=>sameType(t,args[i]))));
}
function requireSuperclasses(c,args,token,items=[]){
 const bindings=new Map(classParameters(c).map((p,i)=>[p,args[i]]));for(const [i,a] of (c.associated||[]).entries())bindings.set(a.param,items[i]);
 for(const sc of superConstraints(c)){
  const pc=activeClasses.get(sc.name),values=sc.args.map(t=>syntaxType(t,bindings));
  if(sc.name==='streem'&&c.associated?.some(a=>a.name==='item'))values.push(items[c.associated.findIndex(a=>a.name==='item')]);
  else for(const a of pc.associated||[])values.push(items[c.associated.findIndex(x=>x.name===a.name)]);
  requireConstraint(sc.name,values,token);
 }
}
// A multi-parameter class is a relation, not an associated-type dependency.
function requireRelation(c,args,token){
 if(args.length!==classParameters(c).length+(c.associated?.length||0))throw new StaticTypeError('Invalid class constraint arity: '+c.name,token);
 args=args.map(prune);if(hasRelationEvidence(c,args))return;
 const n=classParameters(c).length,heads=args.slice(0,n),instance=lookupInstance(c,heads);
 if(instance||heads.every(t=>!['var','rigid'].includes(t.tag))){
  if(!instance){if(c.intoClass&&builtinConversion(heads))return;throw new StaticTypeError('No instance: '+c.name+' '+args.map(formatType).join(' '),token);}
  const params=new Map();instanceHeads(instance).forEach((h,i)=>unify(args[i],syntaxType(h,params),token));for(const [i,a] of (c.associated||[]).entries())unify(args[n+i],syntaxType(instance.associated.get(a.name),params),token);applyContext(instance.context,params,token);requireSuperclasses(c,heads,token,args.slice(n));return;
 }
 const vars=argumentVariables(args).filter(v=>v.tag==='var');
 if(!vars.length)throw new StaticTypeError('Missing constraint: '+c.name+' '+args.map(formatType).join(' '),token);
 for(const v of vars){v.relations??=[];if(!v.relations.some(r=>r.name===c.name&&r.args.every((t,i)=>sameType(t,args[i]))))v.relations.push({name:c.name,args});}
}
function requireAssociated(c,container,items,token) {
  container=prune(container);if(container.numericLiterals){unify(container,INT,token);container=prune(container);}
  if(container.tag==='var'||container.tag==='rigid') {
    if(container.sort!=='value')throw new StaticTypeError('Class constraint requires a value type',token);
    for(const fact of constraintFacts(container,c.name))if(fact.name===c.name&&sameType(fact.args[0],container)){items.forEach((t,i)=>unify(t,fact.args[i+1],token));return;}
    const existing=container.associated?.get(c.name);
    if(existing){existing.forEach((t,i)=>unify(t,items[i],token));return;}
    if(container.tag==='rigid')throw new StaticTypeError(`Missing constraint: ${c.name} ${formatType(container)}`,token);
    container.associated??=new Map();container.associated.set(c.name,items);return;
  }
  if(c.indexClass&&container.tag==='adt'&&container.name==='dict'){unify(items[0],container.args[0],token);unify(items[1],container.args[1],token);return;}
  if(c.indexClass&&(container.tag==='list'||container.tag==='atom'&&container.name==='string')){
    unify(items[0],INT,token);unify(items[1],container.tag==='list'?container.item:BYTE,token);return;
  }
  const instance=c.instances.get(instanceKey(container));
  if(!instance)throw new StaticTypeError(`No instance: ${c.name} ${formatType(container)}`,token);
  const parameters=new Map();unify(container,syntaxType(instance.head,parameters),token);
  c.associated.forEach((a,i)=>unify(items[i],syntaxType(instance.associated.get(a.name),parameters),token));
  applyContext(instance.context,parameters,token);
  requireSuperclasses(c,[container],token,items);
}
function requireClass(name,type,token) {
  if(name==='streem')return requireIterable(type,variable(),token);
  type=prune(type);
  const c=activeClasses.get(name);
  if(!c)throw new StaticTypeError(`Unknown class: ${name}`,token);
  if(c.associated?.length)return requireAssociated(c,type,c.associated.map(()=>variable()),token);
  if(c.operatorClass && !c.supers?.length && !c.instances.size && [...c.methods.keys()].every(op=>operatorSpecs.get(op)?.universal))return;
  if(type.tag==='var') {
    if(type.sort!=='value')throw new StaticTypeError('Class constraint requires a value type',token);
    type.classes ??= new Set();if(hasRelationEvidence(c,[type]))return;for(const n of type.classes)if(inheritedConstraints(c,[type]).some(f=>f.name===n&&f.args.length===1&&sameType(f.args[0],type)))type.classes.delete(n);type.classes.add(name);return;
  }
  if(type.tag==='rigid') {
    if(!hasRelationEvidence(c,[type])){if(c.conversion){requireSuperclasses(c,[type],token);return;}throw new StaticTypeError(`Missing constraint: ${name} ${formatType(type)}`,token);}
    return;
  }
  requireSuperclasses(c,[type],token);
  const key=instanceKey(type),inst=c.instances.get(key);
  if(inst) { const parameters=new Map();unify(type,syntaxType(inst.head,parameters),token);applyContext(inst.context,parameters,token);return; }
  if(c.conversion)return;
  if(!builtinInstance(c,type))throw new StaticTypeError(`No instance: ${name} ${formatType(type)}`,token);
}

function requireIterable(container,item,token,latent=null) {
  container=prune(container);if(container.numericLiterals){unify(container,INT,token);container=prune(container);}
  if(latent){if(container.tag==='var'||container.tag==='rigid'){if(container.eachEffects)mergeEffects(latent,container.eachEffects,token);else container.eachEffects=latent;}else mergeEffects(latent,container.tag==='stream'?container.effects:effects(),token);}
  if(container.tag==='stream'){unify(container.item,item,token);return;}
  if(['var','rigid'].includes(container.tag))for(const fact of constraintFacts(container,'streem'))if(fact.name==='streem'&&sameType(fact.args[0],container)&&fact.args[1]){unify(item,fact.args[1],token);return;}
  if(container.tag==='var') {if(container.eachItem)unify(container.eachItem,item,token);else container.eachItem=item;return;}
  if(container.tag==='rigid') {if(!container.eachItem)throw new StaticTypeError('Missing streem constraint',token);unify(container.eachItem,item,token);return;}
  if(container.tag==='list'){unify(container.item,item,token);return;}
  if(container.tag==='atom' && container.name==='range'){unify(item,INT,token);return;}
  const instance=activeClasses.get('streem')?.instances.get(instanceKey(container));
  if(!instance)throw new StaticTypeError(`No instance: streem ${formatType(container)}`,token);
  const parameters=new Map();unify(container,syntaxType(instance.head,parameters),token);
  unify(item,syntaxType(instance.item,parameters),token);
  applyContext(instance.context,parameters,token);
}
function requireHandlers(handlers,answer,token,residual=null) {
  handlers=prune(handlers);
  if(isBottom(answer) && prune(answer).flexible)prune(answer).link=row();
  if(residual)handlers.handlerResidual=residual;
  residual ??= handlers.handlerResidual;
  if(handlers.tag==='var'){if(handlers.handlerAnswer)unify(handlers.handlerAnswer,answer,token);else handlers.handlerAnswer=answer;return;}
  if(handlers.tag==='rigid'){if(!handlers.handlerAnswer)throw new StaticTypeError('Missing handles constraint',token);unify(handlers.handlerAnswer,answer,token);return;}
  if(handlers.tag!=='record')throw new StaticTypeError('handle requires a handler record',token);
  const fields=flattenRecord(handlers.row);if(prune(fields.tail).tag!=='record-empty')throw new StaticTypeError('Handler record must have known fields',token);
  const expected=new Map(),groupParameters=new Map();
  const bodyEffects=residual?.dependencies?.[0]?.row;
  const bodyEntries=bodyEffects?effectView(bodyEffects).entries:[];
  for(const [name,type] of fields.fields){
    const op=activeEffects.get(name);if(!op)throw new StaticTypeError(`Unknown effect: ${name}`,token);
    let parameters=new Map((op.rowParameters||[]).map(p=>[p,row()]));
    if(op.grouped){
      if(!groupParameters.has(op.group)){
        const shared=new Map();for(const member of activeFamilies.get(op.group).operations)syntaxType(member.syntax,shared);
        groupParameters.set(op.group,shared);
      }
      parameters=groupParameters.get(op.group);
      for(const entry of bodyEntries.filter(e=>e.name===op.group && (e.target?e.target===residual?.dependencies?.[0]?.label:!e.skip)))op.parameters.forEach((p,i)=>unify(parameters.get(p),entry.args[i],token));
    }
    const signature=syntaxType(op.syntax,parameters),s=row();
    if(op.rowParameters?.length)for(const entry of bodyEntries.filter(e=>(e.operation||e.name)===(op.group||name)&&(e.target?e.target===residual?.dependencies?.[0]?.label:!e.skip)))op.parameters.forEach((p,i)=>unify(parameters.get(p),entry.args[i],token));
    const continuation={tag:'continuation',effects:residual||variable('effect-row'),input:op.syntax.never?BOTTOM:syntaxStack(op.syntax.output,parameters,s),output:concatRows(s,answer)};
    const handler=quote(push(syntaxStack(op.syntax.input,parameters,EMPTY),continuation),answer);
    if(op.parameters?.length && !op.grouped && !op.rowParameters?.length) {
      const skolems=new Map(op.parameters.map(name=>{const v=parameters.get(name);return [v,{tag:'rigid',sort:sortOf(prune(v)),id:nextId++,...(v.lacks?{lacks:new Set(v.lacks)}:{})}];}));
      const captured=(prune(type).captures||[]),protectedVars=new Set([...activeProtected,...free(answer),...captured.flatMap(t=>[...free(t)])]);
      const candidate=instantiate({type,vars:new Set([...free(type)].filter(v=>!protectedVars.has(v)))}),universal=clone(handler,skolems);
      checkNeverPromises(candidate,universal,token);const previousCheck=checkingUniversalHandler;checkingUniversalHandler=true;try{unify(candidate,universal,token);}finally{checkingUniversalHandler=previousCheck;}
      const rigidSet=new Set(skolems.values());
      const escapes=(t,seen=new Set())=>{t=prune(t);if(rigidSet.has(t))return true;if(seen.has(t))return false;seen.add(t);return children(t).some(x=>escapes(x,seen));};
      if(escapes(answer)||[...activeProtected,...captured].some(v=>escapes(v)))throw new StaticTypeError('Polymorphic effect parameter escapes its handler',token);
    }
    checkNeverPromises(type,handler,token);unify(type,handler,token);prune(type).handledArgs=(op.parameters||[]).map(n=>parameters.get(n));expected.set(name,handler);
  }
  return expected;
}
function eachEffect(instance) {
  // A callback may replace carried values without changing their types. Native
  // lowering must not mistake that shared type row for untouched values.
  const s=row();s.keepNativePrefix=true;
  const parameters=new Map(),container=instance?syntaxType(instance.head,parameters):variable(),item=instance?syntaxType(instance.item,parameters):variable();
  if(instance)applyContext(instance.context,parameters,instance.token);
  else requireIterable(container,item);
  const latent=variable('effect-row');requireIterable(container,item,null,latent);
  const callback=quote(push(s,item),s),combined=effects([],[{row:callback.effects},{row:latent}]);return generalize(quote(stack(s,container,callback),s,instance?combined:effects([],[{row:combined,exclude:['cancel','break'],loop:true,breakOutput:s}])));
}

const variable = (sort = 'value') => ({ tag: 'var', sort, id: nextId++ });
const row = () => variable('row');
const atom = name => ({ tag: 'atom', name });
const INT = atom('int'), FLOAT=atom('float'), BYTE=atom('byte'), CHAR=atom('char'), BOOL = atom('bool'), STRING = atom('string');
const EMPTY = { tag: 'empty' };
const BOTTOM = Object.freeze({tag:'bottom'});
const isBottom=t=>prune(t).tag==='bottom';
const REMPTY={tag:'record-empty'};
function lacks(t,labels,token) {
  labels=[...labels];t=prune(t);
  if(t.tag==='record-row') {
    for(const k of labels)if(t.fields.has(k))throw new StaticTypeError(`Duplicate record row field: ${k}`,token);
    return lacks(t.tail,labels,token);
  }
  if(t.tag==='var'){t.lacks ??= new Set();for(const k of labels)t.lacks.add(k);}
  if(t.tag==='rigid')for(const k of labels)if(!t.lacks?.has(k))throw new StaticTypeError(`Record row may contain field: ${k}`,token);
}
function recordRow(fields,tail=REMPTY) {
  fields=new Map(fields);lacks(tail,fields.keys());return {tag:'record-row',fields,tail};
}
const record=(fields,tail=REMPTY)=>({tag:'record',row:recordRow(fields,tail)});
function flattenRecord(t) {
  const fields=new Map();t=prune(t);
  while(t.tag==='record-row') {
    for(const [k,v] of t.fields){if(fields.has(k))unify(fields.get(k),v);else fields.set(k,v);}
    t=prune(t.tail);
  }
  return {fields,tail:t};
}
function unifyRecords(a,b,token) {
  const x=flattenRecord(a),y=flattenRecord(b);
  for(const [k,v] of x.fields)if(y.fields.has(k))unify(v,y.fields.get(k),token);
  const left=new Map([...x.fields].filter(([k])=>!y.fields.has(k)));
  const right=new Map([...y.fields].filter(([k])=>!x.fields.has(k)));
  if(!left.size && !right.size)return unify(x.tail,y.tail,token);
  if(x.tail===y.tail || left.size && y.tail.tag==='record-empty' || right.size && x.tail.tag==='record-empty')
    throw new StaticTypeError(`Record fields do not match: ${[...left.keys(),...right.keys()].join(', ')}`,token);
  if(!left.size)return unify(x.tail,recordRow(right,y.tail),token);
  if(!right.size)return unify(y.tail,recordRow(left,x.tail),token);
  const tail=variable('record-row');
  unify(x.tail,recordRow(right,tail),token);unify(y.tail,recordRow(left,tail),token);
}
const TEND={tag:'tuple-end'};
const tuple=(items,tail=TEND)=>({tag:'tuple',items,tail});
const tupleTail=(items,tail=TEND)=>({tag:'tuple-tail',items,tail});
function unifyTuples(a,b,token) {
  const aa=a.items||[],bb=b.items||[],at=a.tail||TEND,bt=b.tail||TEND;
  for(let i=0;i<Math.min(aa.length,bb.length);i++)unify(aa[i],bb[i],token);
  if(aa.length===bb.length)return unify(at,bt,token);
  const longer=aa.length>bb.length,tail=longer?bt:at;
  if(prune(tail).tag==='tuple-end')throw new StaticTypeError('Tuple index out of bounds or arity mismatch',token);
  return unify(tail,tupleTail((longer?aa:bb).slice(Math.min(aa.length,bb.length)),longer?at:bt),token);
}
const list = item => ({ tag: 'list', item });
const adt = (name,args) => ({tag:'adt',name,args});
function stackTail(t){t=prune(t);while(t.tag==='push')t=prune(t.rest);return t;}
const quote = (input, output, effects=variable('effect-row')) => ({ tag: 'quote', input, output, effects,...(isBottom(output)&&!isBottom(input)?{bottomBase:stackTail(input)}:{}) });
const push = (rest, item) => ({ tag: 'push', rest, item });
const stack = (rest, ...items) => items.reduce(push, rest);
const concatRows=(base,suffix)=>({tag:'concat-row',base,suffix});
const prune = t => {
  if(['var','bottom'].includes(t.tag) && t.link)return t.link=prune(t.link);
  if(t.tag==='concat-row') {
    const base=prune(t.base),suffix=prune(t.suffix);
    if(suffix.tag==='bottom'||base.tag==='bottom')return BOTTOM;
    if(base.tag==='empty')return suffix;
    if(suffix.tag==='empty')return base;
    if(suffix.tag==='push')return push(concatRows(base,suffix.rest),suffix.item);
  }
  return t;
};
const children = t => t.tag==='concat-row' ? [t.base,t.suffix] : ['tuple','tuple-tail'].includes(t.tag) ? [...t.items,t.tail] : t.tag==='record' ? [t.row] : t.tag==='record-row' ? [...t.fields.values(),t.tail] : t.tag === 'adt' ? t.args : ['list','stream'].includes(t.tag) ? [t.item] : ['quote','continuation'].includes(t.tag) ? [t.input,t.output] : t.tag === 'push' ? [t.rest,t.item] : [];
const sortOf = t => t.tag === 'var' || t.tag === 'rigid' ? t.sort : ['tuple-tail','tuple-end'].includes(t.tag) ? 'tuple-row' : ['empty','push','bottom','concat-row'].includes(t.tag) ? 'row' : ['record-row','record-empty'].includes(t.tag) ? 'record-row' : t.tag==='effects'?'effect-row':'value';
const effects = (entries=[], dependencies=[]) => ({tag:'effects',entries,dependencies});
function effectView(t, excluded=[], seen=new Map(), result={entries:[],tails:new Set()}) {
  t=prune(t);
  const key=JSON.stringify(excluded);
  if(seen.get(t)?.has(key))return result;
  if(!seen.has(t))seen.set(t,new Set());seen.get(t).add(key);
  if(t.tag==='var'||t.tag==='rigid'){result.tails.add(t);return result;}
  for(const e of t.entries||[]) {
    const family=activeFamilies.get(e.name);let entry={...e},hidden=false;
    for(const handler of excluded){
      const matches=entry.operation?handler.names.includes(entry.operation):handler.names.includes(entry.name)||family?.grouped&&family.operations.every(op=>handler.names.includes(op.name));
      if(!matches)continue;
      if(entry.target){if(entry.target===handler.label){hidden=true;break;}}
      else if(entry.skip)entry.skip--;else {hidden=true;break;}
    }
    if(hidden)continue;
    if(family?.grouped){const prior=result.entries.find(x=>x.name===entry.name && x.target===entry.target && (x.skip||0)===(entry.skip||0));if(prior)entry.args.forEach((a,i)=>unify(a,prior.args[i]));}
    result.entries.push(entry);
  }
  for(const d of t.dependencies||[]) {
    // Keep conversion effects dependent on the literal type until specialization.
    if(d.literalType){const type=prune(d.literalType);if(!(type.tag==='atom'&&['int','float','byte'].includes(type.name))&&!(type.tag==='var'&&!type.polymorphicNumber)){effectView(effects([{name:'exn',args:[]}]),excluded,seen,result);}continue;}
    const h=d.handlers?prune(d.handlers):null,fields=h?.tag==='record'?flattenRecord(h.row).fields:null;
    if(d.handlerEffects){
      if(fields)for(const [name,q] of fields){
        const handler=prune(q);if(!handler.effects)continue;
        const used=d.body?effectView(d.body):{entries:[],tails:new Set()},calls=used.entries.filter(e=>((e.operation||e.name)===name || !e.operation&&activeEffects.get(name)?.group===e.name) && (e.target?e.target===d.label:!e.skip));
        if(!handler.handledArgs?.length || !calls.length || used.tails.size)effectView(handler.effects,excluded,seen,result);
        else for(const call of calls){if(activeEffects.get(name)?.grouped)handler.handledArgs.forEach((t,i)=>unify(t,call.args[i]));const replacements=new Map(handler.handledArgs.map((t,i)=>[prune(t),call.args[i]]));effectView(clone(handler.effects,replacements),excluded,seen,result);}
      }
      continue;
    }
    if(d.breakOutput)for(const entry of effectView(d.row).entries.filter(e=>e.name==='break'&&(e.target?e.target===d.label:!e.skip)))unify(d.breakOutput,entry.args[0]);
    if(d.yieldItem)for(const entry of effectView(d.row).entries.filter(e=>(e.operation||e.name)==='yield' && (e.target?e.target===d.label:!e.skip)))unify(d.yieldItem,entry.args[0]);
    if(d.blockLabel){
      const inner=effectView(d.row,[],new Map(seen));
      const entries=inner.entries.map(e=>{if(e.target!==d.blockLabel)return e;const {target,...plain}=e;return plain;});
      effectView(effects(entries),excluded,seen,result);for(const tail of inner.tails)result.tails.add(tail);
    } else if(d.mask){
      const inner=effectView(d.row,[],new Map(seen));
      const entries=inner.entries.map(e=>{const matches=(e.operation||e.name)===d.mask || !e.operation&&activeEffects.get(d.mask)?.group===e.name;return matches&&!e.target?{...e,...(d.target?{target:d.target}:{skip:(e.skip||0)+1})}:e;});
      effectView(effects(entries),excluded,seen,result);for(const tail of inner.tails)result.tails.add(tail);
    } else {const names=[...d.exclude||[],...fields?.keys()||[]];effectView(d.row,names.length?[{names,label:d.label},...excluded]:excluded,seen,result);}
  }
  return result;
}
function mentionsLabel(type,label,seen=new Set()) {
  type=prune(type);if(seen.has(type))return false;seen.add(type);
  if(type.effects && effectView(type.effects).entries.some(e=>e.target===label))return true;
  return children(type).some(t=>mentionsLabel(t,label,seen));
}
function mergeEffects(a,b,token) {
  a=prune(a);b=prune(b);if(a===b)return;
  if(a.tag==='var'){a.link=b;return;}
  if(b.tag==='var'){b.link=a;return;}
  const av=effectView(a),bv=effectView(b);
  if(!av.tails.size)for(const tail of bv.tails)if(tail.tag==='var')tail.link=effects([...av.entries]);
  if(!bv.tails.size)for(const tail of av.tails)if(tail.tag==='var')tail.link=effects([...bv.entries]);
  // Union rather than equality: branches may perform different operations.
  const combined=effects([], [{row:{...a}},{row:{...b}}]);if(a.weak||b.weak)combined.weak=true;
  Object.assign(a,combined);Object.assign(b,combined);
}
function effectChildren(t,skipLiteral=false) {
  return t.tag==='effects' ? [...t.entries.flatMap(e=>e.args),...t.dependencies.flatMap(d=>[...(d.row?[d.row]:[]),...(d.handlers?[d.handlers]:[]),...(d.body?[d.body]:[]),...(d.yieldItem?[d.yieldItem]:[]),...(d.breakOutput?[d.breakOutput]:[]),...(!skipLiteral&&d.literalType?[d.literalType]:[])])] : [];
}
function checkEffectPromises(actual,expected,token,seen=new Set()) {
  actual=prune(actual);expected=prune(expected);
  if(seen.has(actual))return;seen.add(actual);
  if(actual.tag==='quote' && expected.tag==='quote'){unify(actual.input,expected.input,token);if(!isBottom(actual.output)&&!isBottom(expected.output))unify(actual.output,expected.output,token);}
  if(expected.effectBound && actual.effects) {
    const allowed=effectView(expected.effectBound),used=effectView(actual.effects);
    if(used.tails.size && !allowed.tails.size)throw new StaticTypeError('Open effect row cannot satisfy a closed effect annotation',token);
    for(const e of used.entries) {
      const candidates=allowed.entries.filter(x=>x.name===e.name && x.target===e.target && (x.skip||0)===(e.skip||0));
      if(!candidates.length && allowed.tails.size)continue;
      if(!candidates.length)throw new StaticTypeError(`Effect ${e.name} is not allowed by annotation`,token);
      const candidate=candidates.length===1?candidates[0]:candidates.find(c=>{
        const vars=new Set([...e.args,...c.args].flatMap(t=>[...free(t)])),replacements=new Map([...vars].map(v=>[v,variable(v.sort)]));
        try{e.args.forEach((a,i)=>unify(clone(a,replacements),clone(c.args[i],replacements),token));return true;}catch(error){if(error instanceof StaticTypeError)return false;throw error;}
      });
      if(!candidate)throw new StaticTypeError(`Effect arguments for ${e.name} are not allowed by annotation`,token);
      e.args.forEach((a,i)=>unify(a,candidate.args[i],token));
    }
  }
  if(actual.tag!==expected.tag)return;
  const aa=children(actual),bb=children(expected);
  if(aa.length===bb.length)aa.forEach((x,i)=>checkEffectPromises(x,bb[i],token,seen));
}
function free(t, found = new Set(), seen=new Set(),skipLiteral=false) {
  t = prune(t);if(seen.has(t))return found;seen.add(t);
  if (t.tag === 'var') {if(!found.has(t)){found.add(t);if(t.relations)for(const r of t.relations)for(const x of r.args)free(x,found,seen,skipLiteral);if(t.associated)for(const ts of t.associated.values())for(const x of ts)free(x,found,seen,skipLiteral);if(t.eachItem)free(t.eachItem,found,seen,skipLiteral);if(t.eachEffects)free(t.eachEffects,found,seen,skipLiteral);if(t.handlerAnswer)free(t.handlerAnswer,found,seen,skipLiteral);if(t.handlerResidual)free(t.handlerResidual,found,seen,skipLiteral);}}
  else for (const child of [...children(t),...effectChildren(t,skipLiteral),...(t.effects?[t.effects]:[]),...(t.dispatchType?[t.dispatchType]:[]),...(t.dispatchTypes||[])]) free(child, found,seen,skipLiteral);
  return found;
}
function keepNativePrefix(t) {t=prune(t);if(t.tag==='var'||t.tag==='push'){t.keepNativePrefix=true;if(t.tag==='push')keepNativePrefix(t.rest);}}
// ! is covariant as a result, but an explicit non-returning promise must
// never be satisfied by a computation that can return, including nested quotes.
function checkNeverPromises(actual,expected,token) {
  actual=prune(actual);expected=prune(expected);
  if(actual.tag==='quote' && expected.tag==='quote' && isBottom(expected.output) && !isBottom(actual.output))
    throw new StaticTypeError('Function annotated ! may return normally',token);
  if(actual.tag!==expected.tag)return;
  const aa=children(actual),bb=children(expected);
  if(aa.length===bb.length)aa.forEach((x,i)=>checkNeverPromises(x,bb[i],token));
}
function weakEffects(t,seen=new Set()) {
  t=prune(t);if(seen.has(t))return;seen.add(t);
  if(t.tag==='effects')t.weak=true;
  for(const child of [...children(t),...effectChildren(t),...(t.effects?[t.effects]:[])])weakEffects(child,seen);
}
function occurs(v,t,seen=new Set()){t=prune(t);if(v===t)return true;if(seen.has(t))return false;seen.add(t);return children(t).some(x=>occurs(v,x,seen));}
function unify(a, b, token) {
  a = prune(a); b = prune(b);
  if (a === b) return;
  if(a.tag==='concat-row' && prune(a.base)===b)return unify(a.suffix,EMPTY,token);
  if(b.tag==='concat-row' && prune(b.base)===a)return unify(b.suffix,EMPTY,token);
  if(a.tag==='concat-row' && b.tag==='push') {
    const rest=row();unify(a.suffix,push(rest,b.item),token);return unify(concatRows(a.base,rest),b.rest,token);
  }
  if(b.tag==='concat-row' && a.tag==='push')return unify(b,a,token);
  if(a.tag==='concat-row' && b.tag==='empty'){unify(a.base,EMPTY,token);return unify(a.suffix,EMPTY,token);}
  if(b.tag==='concat-row' && a.tag==='empty')return unify(b,a,token);

  if(a.sort==='effect-row'||b.sort==='effect-row'||a.tag==='effects'||b.tag==='effects')return mergeEffects(a,b,token);
  if (a.tag === 'var') {
    if (sortOf(a) !== sortOf(b)) throw new StaticTypeError('Value/stack kind mismatch', token);
    if (occurs(a,b)) throw new StaticTypeError('Infinite type or changing stack shape (loop/recursive stack effect)', token);
    if(a.numericLiterals){
      if(b.tag==='var'&&(b.eachItem||b.associated)){unify(a,INT,token);unify(b,INT,token);return;}
      if(b.tag==='var'){b.numericLiterals=[...new Set([...b.numericLiterals||[],...a.numericLiterals])];if(a.polymorphicNumber)b.polymorphicNumber=true;if(a.numericPattern)b.numericPattern=true;}
      else if(b.tag!=='atom'||!['int','float','byte'].includes(b.name)){try{requireClass('num',b,token);}catch(error){if(!(error instanceof StaticTypeError))throw error;throw new StaticTypeError('Cannot unify integer literal with '+formatType(b)+'. '+error.message.split('Type error: ').at(-1),token);}}
      else if(b.name==='int'&&a.numericLiterals.some(n=>{try{const x=BigInt(n);return x< -9223372036854775808n||x>9223372036854775807n;}catch{return true;}}))throw new StaticTypeError('int literal is outside signed 64-bit range',token);
      else if(b.name==='byte'&&a.numericLiterals.some(n=>Number(n)<0||Number(n)>255))throw new StaticTypeError('byte literal is outside 0..255',token);
    }
    for(const c of a.classes||[])requireClass(c,b,token);
    if(a.handlerAnswer)requireHandlers(b,a.handlerAnswer,token,a.handlerResidual);
    if(a.associated)for(const [name,items] of a.associated)requireConstraint(name,[b,...items],token);
    if(a.eachItem)requireIterable(b,a.eachItem,token,a.eachEffects);
    if(a.sort==='record-row')lacks(b,a.lacks||[],token);
    if(a.keepNativePrefix)keepNativePrefix(b);
    a.link = isBottom(b)?{tag:'bottom',flexible:true}:b;
    for(const r of a.relations||[])requireConstraint(r.name,r.args,token);return;
  }
  if (b.tag === 'var') return unify(b,a,token);
  if(a.tag==='bottom'||b.tag==='bottom') {
    if(sortOf(a)!=='row'||sortOf(b)!=='row')throw new StaticTypeError('Bottom is a return stack type',token);
    if(a.tag==='bottom' && a.flexible && b.tag!=='bottom')a.link=b;
    if(b.tag==='bottom' && b.flexible && a.tag!=='bottom')b.link=a;
    return;
  }
  if(a.tag==='continuation' && b.tag==='continuation' && isBottom(a.input)!==isBottom(b.input))
    throw new StaticTypeError('Cannot resume a non-returning effect',token);
  if(a.tag==='tuple' && b.tag==='tuple' || ['tuple-tail','tuple-end'].includes(a.tag) && ['tuple-tail','tuple-end'].includes(b.tag))return unifyTuples(a,b,token);
  if(['record-row','record-empty'].includes(a.tag) && ['record-row','record-empty'].includes(b.tag))return unifyRecords(a,b,token);
  if ((a.tag==='empty' && b.tag==='push') || (a.tag==='push' && b.tag==='empty'))
    throw new StaticTypeError('Stack shape mismatch / underflow: empty stack cannot supply a value',token);
  if (a.tag !== b.tag || (['atom','adt'].includes(a.tag) && a.name !== b.name) || (a.tag==='adt' && a.args.length!==b.args.length) || a.tag === 'rigid')
    throw new StaticTypeError(`Cannot unify ${formatType(a)} with ${formatType(b)}`, token);
  if(!checkingUniversalHandler && ['quote','continuation','stream'].includes(a.tag) && a.tag===b.tag){mergeEffects(a.effects??=variable('effect-row'),b.effects??=variable('effect-row'),token);}
  if(a.tag==='quote' && b.tag==='quote'){const captured=[...new Set([...(a.captures||[]),...(b.captures||[])])];if(captured.length){a.captures=captured;b.captures=captured;}}
  const aa=children(a), bb=children(b);
  aa.forEach((child,i)=>unify(child,bb[i],token));
}
function clone(t, replacements) {
  t=prune(t);
  if (replacements.has(t)) return replacements.get(t);
  if(t.tag==='concat-row')return concatRows(clone(t.base,replacements),clone(t.suffix,replacements));
  if(t.tag==='bottom')return BOTTOM;
  if(t.tag==='effects') {
    if(t.weak && replacements.preserveWeak)return t;
    const result=effects();if(t.weak)result.weak=true;replacements.set(t,result);
    result.entries=t.entries.map(e=>({...e,args:e.args.map(x=>clone(x,replacements))}));
    result.dependencies=t.dependencies.map(d=>({...d,...(d.row?{row:clone(d.row,replacements)}:{}),...(d.handlers?{handlers:clone(d.handlers,replacements)}:{}),...(d.body?{body:clone(d.body,replacements)}:{}),...(d.yieldItem?{yieldItem:clone(d.yieldItem,replacements)}:{}),...(d.literalType?{literalType:clone(d.literalType,replacements)}:{}),...(d.breakOutput?{breakOutput:clone(d.breakOutput,replacements)}:{})}));return result;
  }
  if(['tuple','tuple-tail'].includes(t.tag))return {...t,items:t.items.map(x=>clone(x,replacements)),tail:clone(t.tail,replacements)};
  if(t.tag==='record')return {tag:'record',row:clone(t.row,replacements)};
  if(t.tag==='record-row')return recordRow([...t.fields].map(([k,v])=>[k,clone(v,replacements)]),clone(t.tail,replacements));
  if(t.tag==='stream')return {tag:'stream',item:clone(t.item,replacements),effects:clone(t.effects,replacements),...(t.effectBound?{effectBound:clone(t.effectBound,replacements)}:{})};
  if(t.tag==='list') return list(clone(t.item,replacements));
  if(t.tag==='adt') return adt(t.name,t.args.map(a=>clone(a,replacements)));
  if(['quote','continuation'].includes(t.tag)) {
    const result={tag:t.tag};replacements.set(t,result);
    const input=clone(t.input,replacements),output=clone(t.output,replacements);Object.assign(result,quote(input,output),{tag:t.tag});
    result.effects=clone(t.effects||effects(),replacements);if(t.effectBound)result.effectBound=clone(t.effectBound,replacements);
    if(t.bottomBase){let source=prune(t.input),target=prune(input),base=prune(t.bottomBase);while(source!==base && source.tag==='push' && target.tag==='push'){source=prune(source.rest);target=prune(target.rest);}if(source===base)result.bottomBase=target;}
    if(t.originalNever)result.originalNever=true;
    if(t.dispatchTypes)result.dispatchTypes=t.dispatchTypes.map(t=>clone(t,replacements));
    if(t.dispatchType)result.dispatchType=clone(t.dispatchType,replacements);
    if(t.captures)result.captures=t.captures.map(x=>clone(x,replacements));if(t.handledArgs)result.handledArgs=t.handledArgs.map(x=>clone(x,replacements));
    return result;
  }
  if(t.tag==='push') return {...push(clone(t.rest,replacements),clone(t.item,replacements)),...(t.keepNativePrefix?{keepNativePrefix:true}:{})};
  return t;
}
const mono = type => ({ type, vars: new Set() });
function sharedRows(t,found=new Set()) {
  t=prune(t);
  if(t.tag==='quote') {
    const tail=x=>{x=prune(x);while(x.tag==='push')x=prune(x.rest);return x;};
    const a=tail(t.input),b=tail(t.output);if(a===b && a.tag==='var')found.add(a);
  }
  for(const child of children(t))sharedRows(child,found);return found;
}
function generalize(type, excluded = new Set()) {
  if(type.effects)effectView(type.effects);
  if(type.tag==='quote' && isBottom(type.output) && !type.bottomBase)type.bottomBase=stackTail(type.input);
  return { type, vars: new Set([...free(type)].filter(v=>!excluded.has(v))) };
}
function generalizeNumbers(scheme,token){
 // Ignore literal-only effect dependencies: a discarded literal has no public type.
 const escaping=free(scheme.type,new Set(),new Set(),true);
 for(const v of scheme.vars)if(v.numericLiterals&&v.tag==='var'){
  if(v.numericPattern||!escaping.has(v)){unify(v,INT,token);continue;}
  requireClass('num',v,token);v.polymorphicNumber=true;
 }
 return scheme;
}
function instantiate(scheme, rigid = false, bindings = null, preserveWeak = true) {
  const top=prune(scheme.type),fixedRows=new Set(top.tag==='quote'?[stackTail(top.input),stackTail(top.output)]:[]);
  const vars=new Set([...scheme.vars].map(prune).filter(v=>v.tag==='var'));
  const replacements=new Map([...vars].map(v=>[v, {...(rigid && v.sort!=='effect-row' && (v.sort!=='row'||fixedRows.has(v)) ? {tag:'rigid',sort:v.sort,id:nextId++} : variable(v.sort)),...(v.numericLiterals?{numericLiterals:[...v.numericLiterals]}:{}),...(v.polymorphicNumber?{polymorphicNumber:true}:{}),...(v.numericPattern?{numericPattern:true}:{}),...(v.keepNativePrefix?{keepNativePrefix:true}:{}),...(v.lacks?{lacks:new Set(v.lacks)}:{}),...(v.classes?{classes:new Set(v.classes)}:{})}]));
  for(const [v,fresh] of replacements){if(v.relations)fresh.relations=v.relations.map(r=>({...r,args:r.args.map(t=>clone(t,replacements))}));if(v.associated)fresh.associated=new Map([...v.associated].map(([n,ts])=>[n,ts.map(t=>clone(t,replacements))]));if(v.eachItem)fresh.eachItem=clone(v.eachItem,replacements);if(v.eachEffects)fresh.eachEffects=clone(v.eachEffects,replacements);if(v.handlerAnswer)fresh.handlerAnswer=clone(v.handlerAnswer,replacements);if(v.handlerResidual)fresh.handlerResidual=clone(v.handlerResidual,replacements);}
  replacements.preserveWeak=preserveWeak;
  if(bindings)for(const [v,fresh] of replacements)bindings.set(v,fresh);
  return clone(scheme.type,replacements);
}
function envFree(env) {
  const result=new Set();
  for(const scheme of env.values()) for(const v of free(scheme.type)) if(!scheme.vars.has(v)) result.add(v);
  return result;
}

export function formatType(type,{names=null,variableNames=new Map(),showConstraints=true,defaultNumbers=true}={}) {
  if(defaultNumbers)for(const v of free(type))if(v.numericLiterals&&!v.polymorphicNumber&&v.tag==='var')unify(v,INT);
  // An open callback row may include break, while every use of that row is
  // beneath a loop's handler. Expose that accepted operation in the signature
  // without injecting a performed effect into the callback's inference graph.
  const acceptsBreak=new WeakMap(),visitedTypes=new Set();
  function inspect(t) {
    t=prune(t);if(visitedTypes.has(t))return;visitedTypes.add(t);
    if(t.tag==='quote' && t.effects) {
      const states=new Map(),seen=new Map();
      function scan(row,handled=false) {
        row=prune(row);const bit=handled?2:1;
        if((seen.get(row)||0)&bit)return;seen.set(row,(seen.get(row)||0)|bit);
        if(row.tag==='var'||row.tag==='rigid'){states.set(row,(states.get(row)||0)|bit);return;}
        for(const d of row.dependencies||[]) {
          // Handler callback effects are another possible outward use. Do not
          // infer that a loop handles them just from a separate masked use.
          if(d.handlerEffects && d.handlers){
            const handlers=prune(d.handlers);
            if(handlers.tag==='record')for(const q of flattenRecord(handlers.row).fields.values()){const callback=prune(q);if(callback.effects)scan(callback.effects,false);}
          }
          if(!d.row)continue;
          if(d.mask==='cancel') {for(const tail of effectView(d.row).tails)states.set(tail,(states.get(tail)||0)|1);continue;}
          scan(d.row,handled || !!(d.loop && d.exclude?.includes('cancel')));
        }
      }
      scan(t.effects);
      let input=prune(t.input);
      while(input.tag==='push') {
        const callback=prune(input.item);
        if(callback.tag==='quote' && callback.effects){const tails=[...effectView(callback.effects).tails];if(tails.length && tails.every(tail=>states.get(tail)===2))acceptsBreak.set(callback,t.output);}
        input=prune(input.rest);
      }
    }
    for(const child of children(t))inspect(child);
  }
  inspect(type);
  const values=new Map(), rows=new Map(), recordRows=new Map(),tupleRows=new Map(),effectRows=new Map();
  const name=(v,names,prefix)=>{ if(!names.has(v)) names.set(v, `${prefix}${names.size || ''}`); return variableNames.get(v)||names.get(v); };
  // Keep row names stable and avoid reusing their identifiers for value types.
  const reserved=new Set([...visitedTypes,...free(type)].flatMap(t=>
    (t.tag==='var'||t.tag==='rigid') ? ({'effect-row':["'e"],'record-row':["'r"],'tuple-row':["'t"]}[t.sort]||[]) : []));
  let nextValueName=0;
  const alphabetic=i=>{let text='';do{text=String.fromCharCode(97+i%26)+text;i=Math.floor(i/26)-1;}while(i>=0);return "'"+text;};
  function valueName(t){
    if(!values.has(t)){let candidate;do{candidate=alphabetic(nextValueName++);}while(reserved.has(candidate));values.set(t,candidate);}
    return variableNames.get(t)||values.get(t);
  }
  function render(t) {
    t=prune(t);
    if(t.tag==='var'||t.tag==='rigid') return t.sort==='effect-row' ? name(t,effectRows,"'e") : t.sort==='tuple-row' ? name(t,tupleRows,"'t") : t.sort==='record-row' ? name(t,recordRows,"'r") : t.sort==='row' ? name(t,rows,'..s') : valueName(t);
    if(['record','record-row','record-empty'].includes(t.tag)) {
      const {fields,tail}=flattenRecord(t.tag==='record'?t.row:t);
      const parts=[...fields].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>`${k}: ${render(v)}`);
      return `{${parts.join(', ')}${tail.tag==='record-empty' ? (parts.length?'':':') : ` | ${render(tail)}`}}`;
    }
    if(['tuple','tuple-tail','tuple-end'].includes(t.tag)) {
      const parts=(t.items||[]).map(render);let tail=prune(t.tail||TEND);
      while(tail.tag==='tuple-tail'){parts.push(...tail.items.map(render));tail=prune(tail.tail);}
      return `#(${parts.join(' ')}${tail.tag==='tuple-end'?'':` | ${render(tail)}`})`;
    }
    if(t.tag==='concat-row')return `${renderStack(t.base)} ++ ${renderStack(t.suffix)}`;
    if(t.tag==='bottom')return '!';
    if(t.tag==='atom') return t.name;
    if(t.tag==='adt') return t.args.length ? `(${t.name} ${t.args.map(render).join(' ')})` : t.name;
    if(t.tag==='stream')return `(stream ${render(t.item)} { ->${renderEffects(t)} })`;
  if(t.tag==='list') return `[${render(t.item)}]`;
    if(t.tag==='continuation')return `continuation { ${renderStack(t.input)} -> ${renderStack(t.output)}${renderEffects(t)} }`;
    if(t.tag==='quote') return `{ ${renderStack(t.input)} -> ${renderStack(t.output)}${renderEffects(t)} }`;
    return renderStack(t);
  }
  function renderEffects(t) {
    if(!t.effects)return '';
    const view=effectView(t.effects),parts=[...new Set(view.entries.map(e=>[e.name+(e.target?'@'+e.target:(e.skip?'^'+e.skip:'')),...e.args.map(a=>sortOf(prune(a))==='row'?`(${renderStack(a)})`:render(a))].join(' ')))].sort();
    if(acceptsBreak.has(t) && !parts.includes('cancel')){parts.push('cancel');parts.push(`break (${renderStack(acceptsBreak.get(t))})`);parts.sort();}
    const tails=[...view.tails].map(render).sort();
    return parts.length||tails.length ? ` / {${parts.join(', ')}${tails.length?` | ${tails.join(', ')}`:''}}` : '';
  }
  function renderStack(t) {
    const items=[]; t=prune(t);if(t.tag==='bottom')return '!';
    while(t.tag==='push') { items.unshift(render(t.item)); t=prune(t.rest); }
    if(t.tag!=='empty') items.unshift(render(t));
    return items.length ? items.join(' ') : '∅';
  }
  const t=prune(type);
  const body=t.tag==='quote' ? `${renderStack(t.input)} -> ${renderStack(t.output)}${renderEffects(t)}` : render(t);
  const constraints=[...new Set([...free(t)].flatMap(v=>[...(v.relations||[]).map(r=>r.name+' '+r.args.map(render).join(' ')),...[...v.associated||[]].map(([n,ts])=>`${n} ${render(v)} ${ts.map(render).join(' ')}`),...[...v.classes||[]].sort().map(c=>`${c} ${render(v)}`),...(v.eachItem?[`streem ${render(v)} ${render(v.eachItem)}`]:[]),...(v.handlerAnswer?[`handles ${render(v)} ${render(v.handlerAnswer)}`]:[])]))];
  if(names)for(const group of [values,rows,recordRows,tupleRows,effectRows])for(const [v,n] of group)names.set(v,variableNames.get(v)||n);
  return showConstraints&&constraints.length?`${constraints.join(', ')} => ${body}`:body;
}

function builtinSchemes() {
  const out=new Map();
  const add=(names,build)=>{ for(const name of names.split(' ')) {
    const type=build(),callbacks=[];let input=prune(type.input);
    while(input.tag==='push'){const item=prune(input.item);if(['quote','continuation'].includes(item.tag))callbacks.push(item);input=prune(input.rest);}
    if(name==='compose'){const result=prune(type.output).item;result.effects=effects([],callbacks.map(q=>({row:q.effects})));type.effects=effects();}
    else type.effects=effects([],callbacks.map(q=>({row:q.effects??=variable('effect-row')})));
    if(['vmap','vfilter','fold'].includes(name)){const c=name==='fold'?prune(prune(type.input).rest).rest.item:prune(type.input).rest.item,latent=variable('effect-row');requireIterable(c,variable(),null,latent);type.effects.dependencies.push({row:latent});}
    if(['while','vmap','vfilter','fold'].includes(name))type.effects=effects([],[{row:type.effects,exclude:['cancel','break'],loop:true,breakOutput:type.output}]);
    out.set(name,generalize(type));
  } };
  add('+ - * / % ^',()=>{const s=row();return quote(stack(s,INT,INT),push(s,INT));});
  add('< > <= >=',()=>{const s=row();return quote(stack(s,INT,INT),push(s,BOOL));});
  add('== /=',()=>{const s=row(),a=variable();return quote(stack(s,a,a),push(s,BOOL));});
  add('&& ||',()=>{const s=row();return quote(stack(s,BOOL,BOOL),push(s,BOOL));});
  add('not',()=>{const s=row();return quote(push(s,BOOL),push(s,BOOL));});
  add('dup',()=>{const s=row(),a=variable();return quote(push(s,a),stack(s,a,a));});
  add('drop',()=>{const s=row(),a=variable();return quote(push(s,a),s);});
  {const s=row(),a=variable();out.set('print',generalize(quote(push(s,a),s,effects([{name:'io',operation:'put',args:[]}]))));}
  add('nop',()=>{const s=row();return quote(s,s);});
  for(const [name,result] of [['toInt',INT],['toFloat',FLOAT],['toByte',BYTE]]){
    const s=row(),a=variable();requireClass('num',a);out.set(name,generalize(quote(push(s,a),push(s,result),effects([{name:'exn',args:[]}]))));
  }
  {const s=row();out.set('toChar',generalize(quote(push(s,INT),push(s,CHAR),effects([{name:'exn',args:[]}]))));}
  add('values',()=>{const s=row(),k=variable(),v=variable();return quote(push(s,adt('dict',[k,v])),push(s,{tag:'stream',item:v,effects:effects()}));});
  add('bytes',()=>{const s=row();return quote(push(s,STRING),push(s,list(BYTE)));});
  add('chars',()=>{const s=row();return quote(push(s,STRING),push(s,list(CHAR)));});
  add('split',()=>{const s=row();return quote(stack(s,STRING,STRING),push(s,{tag:'stream',item:STRING,effects:effects()}));});
  add('toNum',()=>{const s=row();return quote(push(s,STRING),push(s,{tag:'adt',name:'option',args:[FLOAT]}));});
  {const s=row();out.set('parseNum',generalize(quote(push(s,STRING),push(s,FLOAT),effects([{name:'exn',args:[]}]))));}
  {const s=row(),c=variable(),latent=variable('effect-row');requireIterable(c,STRING,null,latent);
    out.set('join',generalize(quote(stack(s,c,STRING),push(s,STRING),effects([],[{row:latent,exclude:['cancel','break'],loop:true}]))));}
  for(const name of ['windows','chunks','chunkBy','groupBy']){
    const s=row(),source=variable(),item=variable(),key=variable(),latent=variable('effect-row'),callback=variable('effect-row');requireIterable(source,item,null,latent);
    const keyed=['chunkBy','groupBy'].includes(name),arg=keyed?quote(push(EMPTY,item),push(EMPTY,key),callback):INT;
    const result=name==='groupBy'?adt('dict',[key,list(item)]):{tag:'stream',item:name==='chunkBy'?{tag:'stream',item,effects:effects()}:list(item),effects:effects([],[{row:latent},...(keyed?[{row:callback}]:[])])};
    if(name!=='groupBy')result.effects=effects([],[{row:result.effects,exclude:['cancel','break'],loop:true,breakOutput:EMPTY}]);
    const output=push(s,result),performed=name==='groupBy'?effects([],[{row:latent,exclude:['cancel','break'],loop:true,breakOutput:output},{row:callback,exclude:['cancel','break'],loop:true,breakOutput:output}]):keyed?effects():effects([{name:'exn',args:[]}]);
    out.set(name,generalize(quote(stack(s,source,arg),output,performed)));
  }
  for(const name of ['zip','vzip']){const s=row(),left=variable(),right=variable(),a=variable(),b=variable(),le=variable('effect-row'),re=variable('effect-row');requireIterable(left,a,null,le);requireIterable(right,b,null,re);const traversal=effects([],[{row:effects([],[{row:le},{row:re}]),exclude:['cancel','break'],loop:true,breakOutput:name==='zip'?EMPTY:push(s,list(tuple([a,b])))}]);const result=name==='zip'?{tag:'stream',item:tuple([a,b]),effects:traversal}:list(tuple([a,b]));out.set(name,generalize(quote(stack(s,left,right),push(s,result),name==='zip'?effects():traversal)));}
  add('show',()=>{const s=row(),a=variable();return quote(push(s,a),push(s,STRING));});
  add('swap',()=>{const s=row(),a=variable(),b=variable();return quote(stack(s,a,b),stack(s,b,a));});
  add('over',()=>{const s=row(),a=variable(),b=variable();return quote(stack(s,a,b),stack(s,a,b,a));});
  add('rot',()=>{const s=row(),a=variable(),b=variable(),c=variable();return quote(stack(s,a,b,c),stack(s,b,c,a));});
  add('resume',()=>{const s=row(),t=row();return quote(push(s,{tag:'continuation',input:s,output:t}),t);});
  add('call',()=>{const s=row(),t=row();return quote(push(s,quote(s,t)),t);});
  add('if',()=>{const s=row(),t=row(),q=quote(s,t);return quote(stack(s,BOOL,q,q),t);});
  add('when',()=>{const s=row();return quote(stack(s,BOOL,quote(s,s)),s);});
  add('while',()=>{const s=row(),t=row();s.keepNativePrefix=true;t.keepNativePrefix=true;return quote(stack(s,quote(s,push(t,BOOL)),quote(t,s)),t);});
  add('dip',()=>{const s=row(),t=row(),a=variable();return quote(stack(s,a,quote(s,t)),push(t,a));});
  add('compose',()=>{const r=row(),s=row(),t=row(),u=row();return quote(stack(r,quote(s,t),quote(t,u)),push(r,quote(s,u)));});
  {
    const s=row(),c=variable(),a=variable(),latent=variable('effect-row');requireIterable(c,a,null,latent);
    out.set('toVector',generalize(quote(stack(s,c),stack(s,list(a)),effects([],[{row:latent,exclude:['cancel','break'],loop:true}]))));
  }
  {const s=row(),c=variable(),a=variable(),latent=variable('effect-row');requireIterable(c,a,null,latent);const output=push(s,adt('option',[a]));out.set('nth',generalize(quote(stack(s,c,INT),output,effects([],[{row:latent,exclude:['cancel','break'],loop:true,breakOutput:output}]))));}
  for(const name of combinationNames){
    const s=row(),c=variable(),a=variable(),latent=variable('effect-row');requireIterable(c,a,null,latent);
    const args=[c],deps=[{row:latent}];let item=list(a);
    if(name==='cartesianProduct'){const d=variable(),b=variable(),other=variable('effect-row');requireIterable(d,b,null,other);args.push(d);deps.push({row:other});item=tuple([a,b]);}
    else if(name!=='powerset')args.push(INT);
    const traversal=effects([],[{row:effects([],deps),exclude:['cancel','break'],loop:true,breakOutput:EMPTY}]);
    out.set(name,generalize(quote(stack(s,...args),push(s,{tag:'stream',item,effects:traversal}),effects(['powerset','cartesianProduct'].includes(name)?[]:[{name:'exn',args:[]}]))));
  }
  for(const name of ['reverse','sort','sortBy']) {
    const s=row(),c=variable(),a=variable(),key=name==='sortBy'?variable():a,latent=variable('effect-row');requireIterable(c,a,null,latent);
    const args=[c],dependencies=[{row:latent}];
    if(name==='sortBy'){const q=quote(stack(EMPTY,a),stack(EMPTY,key));args.push(q);dependencies.push({row:q.effects});}
    if(name!=='reverse')requireClass('ord',key);
    out.set(name,generalize(quote(stack(s,...args),push(s,list(a)),effects([],[{row:effects([],dependencies),exclude:['cancel','break'],loop:true}]))));
  }
  for(const name of ['max','min']){const s=row(),a=variable();requireClass('ord',a);out.set(name,generalize(quote(stack(s,a,a),push(s,a),effects())));}
  for(const name of ['maxi','mini','maxiBy','miniBy','all','any']){
    const s=row(),c=variable(),a=variable(),predicate=name==='all'||name==='any',key=name.endsWith('By')?variable():a,latent=variable('effect-row');requireIterable(c,a,null,latent);
    const args=[c],dependencies=[{row:latent}];if(!['maxi','mini'].includes(name)){const q=quote(stack(EMPTY,a),stack(EMPTY,predicate?BOOL:key));args.push(q);dependencies.push({row:q.effects});}
    if(!predicate)requireClass('ord',key);
    out.set(name,generalize(quote(stack(s,...args),push(s,predicate?BOOL:adt('option',[a])),effects([],[{row:effects([],dependencies),exclude:['cancel','break'],loop:true}]))));
  }
  for(const [name,mode] of transforms) {
    const s=row(),c=variable(),a=variable(),b=variable(),latent=variable('effect-row'),nested=variable('effect-row');requireIterable(c,a,null,latent);
    const inputs=[c],dependencies=[{row:latent}];let item=a;
    if(callbackTransform(mode)) {
      const q=quote(stack(EMPTY,a),stack(EMPTY,predicateTransform(mode)?BOOL:b));inputs.push(q);dependencies.push({row:q.effects});
      if(mode==='map')item=b;
      if(mode==='flatMap'){item=variable();requireIterable(b,item,null,nested);dependencies.push({row:nested});}
    } else if(mode==='flatten'){item=b;requireIterable(a,b,null,nested);dependencies.push({row:nested});}
    else inputs.push(INT);
    const traversal=effects([],[{row:effects([],dependencies),exclude:['cancel','break'],loop:true}]);
    const construction=effects(countTransform(mode)?[{name:'exn',args:[]}]:[]);
    const lazy=streamTransforms.has(name),result=lazy?{tag:'stream',item,effects:traversal}:list(item);
    out.set(name,generalize(quote(stack(s,...inputs),stack(s,result),lazy?construction:effects(construction.entries,[{row:effects([],dependencies),exclude:['cancel','break'],loop:true}]))));
  }
  out.set('each',eachEffect());
  add('vmap',()=>{const s=row(),a=variable(),b=variable(),c=variable();requireIterable(c,a);return quote(stack(s,c,quote(push(s,a),push(s,b))),push(s,list(b)));});
  add('vfilter',()=>{const s=row(),a=variable(),c=variable();requireIterable(c,a);return quote(stack(s,c,quote(push(s,a),push(s,BOOL))),push(s,list(a)));});
  add('fold',()=>{const s=row(),a=variable(),b=variable(),c=variable();s.keepNativePrefix=true;requireIterable(c,a);return quote(stack(s,c,b,quote(stack(s,b,a),push(s,b))),push(s,b));});
  add('cons',()=>{const s=row(),a=variable();return quote(stack(s,a,list(a)),push(s,list(a)));});
  add('push Push ::',()=>{const s=row(),a=variable();return quote(stack(s,list(a),a),push(s,list(a)));});
  add('concat ++',()=>{const s=row(),a=variable();return quote(stack(s,list(a),list(a)),push(s,list(a)));});
  add('length',()=>{const s=row(),a=variable();return quote(push(s,list(a)),push(s,INT));});
  add('head',()=>{const s=row(),a=variable();return quote(push(s,list(a)),push(s,a));});
  add('tail',()=>{const s=row(),a=variable();return quote(push(s,list(a)),push(s,list(a)));});
  add('.. ..=',()=>{const s=row();return quote(stack(s,INT,INT),push(s,atom('range')));});
  add('range',()=>{const s=row();return quote(stack(s,INT,INT),push(s,list(INT)));});
  for(const scheme of out.values()){
    const seen=new Set(),walk=(type)=>{type=prune(type);if(seen.has(type))return;seen.add(type);const visit=(effect)=>{effect=prune(effect);for(const d of effect.dependencies||[]){if(d.loop&&!d.breakOutput)d.breakOutput=type.tag==='stream'?EMPTY:type.output||EMPTY;if(d.row)visit(d.row);}};if(type.effects)visit(type.effects);for(const child of children(type))walk(child);};walk(scheme.type);
  }
  return out;
}

export function missingOperands(nodes, found = []) {
  for(const node of nodes) {
    if(node.kind==='missing') found.push(node);
    else if(node.kind==='record')for(const f of node.fields) {if(f.body.length===1 && f.body[0].kind==='missing')found.push(f.body[0]);}
    else if(node.kind==='binary') {missingOperands(node.left,found);missingOperands(node.right,found);}
    else if(node.kind==='comparison-chain')node.operands.forEach(operand=>missingOperands(operand,found));
    else if(node.kind==='scope' && node.body.length===1) missingOperands(node.body,found);
  }
  return found;
}

class Inference {
  constructor() { this.effectSink=effects();this.functions=builtinSchemes(); this.globals=new Map(); this.cells=new Map(); this.bindings=new Map(); this.replacements=new Map();this.localFunctions=new Map(); }
  block(nodes,input,env,bound) {
    const parent=this.effectSink;this.effectSink=effects();
    try {const output=this.sequence(nodes,input,env,bound);return quote(input,output,this.effectSink);} finally {this.effectSink=parent;}
  }
  labeledBlock(nodes,input,env,key,token) {
    if(!key)return this.block(nodes,input,env);
    const scope=new Map(env);scope.set(key,mono(atom('effect-label')));
    const type=this.block(nodes,input,scope);
    type.effects=effects([],[{row:type.effects,blockLabel:key}]);
    const escape=t=>mentionsLabel(t,key);
    const payloadEscape=effectView(type.effects).entries.some(e=>e.args.some(escape));
    if(escape(type.output)||payloadEscape||[...this.cells.values()].some(escape)||[...env.values()].some(s=>escape(s.type)))
      throw new StaticTypeError('Effect label escapes its block: '+(token?.labelName||key),token);
    return type;
  }
  localEffect(name,body,env,token) {
    const local=new Map(env),unknown=quote(row(),row(),effects());
    local.set(name,{...generalize(unknown),callable:true});
    const input=row(),candidate=this.block(body,input,new Map(local));
    local.set(name,{type:candidate,vars:sharedRows(candidate),callable:true});
    const checked=row();unify(candidate,this.block(body,checked,new Map(local)),token);
    return {...generalizeNumbers(generalize(candidate,envFree(env)),token),callable:true};
  }
  declare(env,name,type,mutable,node) {
    if(this.constructors?.has(name))throw new StaticTypeError(`Cannot shadow constructor: ${name}`,node);
    if(env.locals.has(name)) throw new StaticTypeError(`Variable already declared: ${name}`,node);
    if(env===this.rootEnv && this.functions.has(name)) throw new StaticTypeError(`Global variable conflicts with function: ${name}`,node);
    env.locals.add(name);
    const excluded=envFree(env);
    for(const v of this.excluded || []) excluded.add(v);
    if(mutable)weakEffects(type);
    for(const v of free(type))if(v.numericLiterals||hasRelationEvidence(activeClasses.get('num'),[v]))excluded.add(v);
    env.set(name,mutable ? {...mono(type),mutable:true} : generalize(type,excluded));
  }
  pop(current, token) {
    if(isBottom(current))return [BOTTOM,variable()];
    const rest=row(),item=variable();
    if(prune(current).tag==='empty') throw new StaticTypeError('Stack underflow: value required on empty stack',token);
    unify(current,push(rest,item),token); return [rest,item];
  }
  apply(effect,current,token) { effect=prune(effect);checkNeverPromises(current,effect.input,token);checkEffectPromises(current,effect.input,token); const output=row(); unify(effect,quote(current,output),token);this.effectSink.dependencies.push({row:effect.effects});return isBottom(output)?BOTTOM:output; }
  single(nodes,env,bound,token) {
    const result=this.sequence(nodes,EMPTY,new Map(env),bound),value=variable();
    if(isBottom(result))return BOTTOM;
    try { unify(result,push(EMPTY,value),token); }
    catch(error) { throw new StaticTypeError(`Binary operand must consume 0 and produce 1 value. ${error.message}`,token); }
    return value;
  }
  sequence(nodes,current,env,bound=new Map()) {
    const protectedBefore=activeProtected;
    try{return this.sequenceCore(nodes,current,env,bound);}finally{activeProtected=protectedBefore;}
  }
  sequenceCore(nodes,current,env,bound=new Map()) {
    const entry=current;
    env.locals ??= new Set();
    bound.references ??= new Map();
    for(const node of nodes) {
      if(isBottom(current))break;
      activeProtected=envFree(env);
      const trace=this.trace ? {input:current,env:new Map(env)} : null;
      if(node.kind==='word' && node.target && (!this.effects.has(node.value)||env.has(node.value)))throw new StaticTypeError('Only effect operations can have a target label; shadowed operations cannot be targeted',node);
      if(node.kind==='capture') {
        if(node.slots.length) {
          const count=Math.max(...node.slots.map(s=>s.index))+1,values=[];
          for(let i=0;i<count;i++){let value;[current,value]=this.pop(current,node.slots[0]);values.push(value);}
          for(const s of node.slots){bound.references.set(s,values[s.index]);if(s.capturedName)env.set(s.capturedName,mono(values[s.index]));}
          const removed=new Set(node.slots.filter(s=>!s.peek).map(s=>s.index));
          for(let i=count-1;i>=0;i--)if(!removed.has(i))current=push(current,values[i]);
        }
      } else if(node.kind==='reference') {
        if(!bound.references.has(node))throw new StaticTypeError('Stack reference binding may be skipped by a comparison chain',node);
        current=push(current,bound.references.get(node));
      }
      else if(node.kind==='label') {
        const parent=this.effectSink,local=effects(),scope=new Map(env);scope.set(node.key,mono(atom('effect-label')));this.effectSink=local;
        try {current=this.sequence(node.body,current,scope,bound);}finally{this.effectSink=parent;}
        if(effectView(local).entries.some(e=>e.target===node.key))throw new StaticTypeError('Label does not handle the targeted effect: '+node.name,node);
        if(mentionsLabel(current,node.key)||[...this.cells.values()].some(t=>mentionsLabel(t,node.key))||[...env.values()].some(s=>s.type&&mentionsLabel(s.type,node.key)))throw new StaticTypeError('Effect label escapes its handler: '+node.name,node);
        parent.dependencies.push({row:local});if(trace)trace.labelEnv=scope;
      }
      else if(node.kind==='mask') {
        if(!this.effects.has(node.operation))throw new StaticTypeError('Unknown effect operation: '+node.operation,node);
        const parent=this.effectSink,local=effects();this.effectSink=local;
        try {current=this.sequence(node.body,current,new Map(env),bound);}finally{this.effectSink=parent;}
        parent.dependencies.push({row:local,mask:node.operation,target:node.target});
      }
      else if(node.kind==='application') {
        const [head,...args]=node.body;
        const body=[...args,head];if(trace)trace.application=body;
        current=this.sequence(body,current,env,bound);
      }
      else if(node.kind==='literal'){const type=typeof node.value==='number'?((node.numericKind==='float'||!Number.isInteger(node.value))?FLOAT:{...variable(),numericLiterals:[node.numberSource??String(node.value)]}):this.value(node.value,node);current=push(current,type);if(typeof node.value==='number'&&node.numericKind!=='float'&&Number.isInteger(node.value))this.effectSink.dependencies.push({literalType:type});}
      else if(node.kind==='interpolation') {
        const values=[];for(const f of node.fields.filter(f=>f.empty)){let value;[current,value]=this.pop(current,node);values.unshift(value);}
        let index=0;const formatTypes=[],formatEffects=[];
        for(const f of node.fields){
          const value=f.empty?values[index++]:this.single(f.body,env,bound,node);
          if(isBottom(value)){current=BOTTOM;break;}
          const show=instantiate(this.functions.get('show'));unify(show,quote(push(EMPTY,value),push(EMPTY,STRING)),node);
          this.effectSink.dependencies.push({row:show.effects});formatTypes.push(value);formatEffects.push(show);
        }
        if(trace){trace.formatTypes=formatTypes;trace.formatEffects=formatEffects;}
        if(!isBottom(current))current=push(current,STRING);
      }
      else if(node.kind==='missing') {
        if(bound.has(node)) current=push(current,bound.get(node));
        else {const [rest,value]=this.pop(current,node);current=push(rest,value);}
      } else if(node.kind==='bind') {
        const values=[];
        for(let i=0;i<node.patterns.length;i++){let value;[current,value]=this.pop(current,node);values.unshift(value);}
        const matched=new Map();node.patterns.forEach((p,i)=>this.pattern(p,values[i],matched));
        const fields=node.names.map(name=>matched.get(name).type);
        this.excluded=new Set([...free(current),...free(entry)]);
        node.names.forEach((name,i)=>this.declare(env,name,fields[i],node.mutable[i],node));
        this.bindings.set(node,fields);
      } else if(node.kind==='local-function') {
        if(env.locals.has(node.name))throw new StaticTypeError(`Variable already declared: ${node.name}`,node);
        if(env===this.rootEnv && this.functions.has(node.name))throw new StaticTypeError(`Global variable conflicts with function: ${node.name}`,node);
        if(this.constructors?.has(node.name))throw new StaticTypeError(`Cannot shadow constructor: ${node.name}`,node);
        const scheme=this.localEffect(node.name,node.body,env,node);
        env.locals.add(node.name);env.set(node.name,scheme);
        if(trace)trace.localEnv=new Map(env);
      } else if(node.kind==='update') {
        const names=node.names||[node.name],bindings=names.map(name=>{
          if(!env.has(name))throw new StaticTypeError(`Unknown variable: ${name}`,node);
          const binding=env.get(name);if(!binding.mutable)throw new StaticTypeError(`Cannot assign to immutable variable: ${name}`,node);return binding;
        });
        const output=this.sequence(node.body,EMPTY,new Map(env),bound);
        if(isBottom(output))current=BOTTOM;
        else {
          const values=names.map(()=>variable());
          try{unify(output,stack(EMPTY,...values),node);}catch(error){throw new StaticTypeError(`Assignment operand must consume 0 and produce ${names.length} value(s). ${error.message}`,node);}
          values.forEach((value,i)=>{checkNeverPromises(value,bindings[i].type,node);checkEffectPromises(value,bindings[i].type,node);unify(bindings[i].type,value,node);});
        }
      } else if(node.kind==='scope') current=this.sequence(node.body,current,new Map(env),bound);
      else if(node.kind==='case') {
        const output=row();
        for(const branch of node.branches) {
          let trial=current;const args=[],local=new Map(env);
          for(const p of branch.patterns){let value;[trial,value]=this.pop(trial,p);args.unshift(value);}
          local.locals=new Set(patternNames(branch.patterns));
          branch.patterns.forEach((p,i)=>this.pattern(p,args[i],local));
          if(branch.guard){trial=this.sequence(branch.guard,trial,new Map(local));let flag;[trial,flag]=this.pop(trial,branch.token);unify(flag,BOOL,branch.token);}
          unify(output,this.sequence(branch.body,trial,local),branch.token);
        }
        current=output;
      }
      else if(node.kind==='binary' || node.kind==='comparison-chain') {
        const holes=missingOperands([node]).filter(h=>!bound.has(h)),values=[];
        for(const hole of holes){let value;[current,value]=this.pop(current,node);values.unshift(value);}
        const bindings=new Map(bound);holes.forEach((h,i)=>bindings.set(h,values[i]));
        bindings.references=bound.references;
        if(trace)trace.operatorEffects=[];
        if(node.kind==='comparison-chain') {
          let left=this.single(node.operands[0],env,bindings,node);
          if(isBottom(left)){current=BOTTOM;if(trace){trace.output=current;this.trace.set(node,trace);}continue;}
          let guaranteed;
          for(let i=0;i<node.operators.length;i++) {
            const op=node.operators[i],right=this.single(node.operands[i+1],env,bindings,op);
            if(isBottom(right)){if(i===0)current=BOTTOM;break;}
            const effect=instantiate(this.functions.get(op.value));if(trace)trace.operatorEffects.push(effect);
            this.apply(effect,stack(EMPTY,left,right),op);
            left=right;
            if(i===0)guaranteed=new Set(bindings.references.keys());
          }
          // Captures in a short-circuited operand cannot supply references
          // after the chain, even when parentheses share a lexical clause.
          for(const key of bindings.references.keys())if(!guaranteed?.has(key))bindings.references.delete(key);
          if(!isBottom(current))current=push(current,BOOL);
        } else if(['&&','||'].includes(node.value)){
          const left=this.single(node.left,env,bindings,node),guaranteed=new Set(bindings.references.keys());
          if(isBottom(left)){current=BOTTOM;if(trace){trace.output=current;this.trace.set(node,trace);}continue;}
          if(node.value==='&&')unify(left,BOOL,node);
          else {const predicate=instantiate(this.functions.get('hasValue'));this.apply(predicate,stack(EMPTY,left),node);if(trace)trace.orElsePredicate=predicate;}
          const right=this.single(node.right,env,bindings,node);
          if(!isBottom(right))unify(right,left,node);
          if(node.value==='||'){const effect=instantiate(this.functions.get('||'));this.apply(effect,stack(EMPTY,left,left),node);if(trace)trace.operatorEffects.push(effect);}
          for(const key of bindings.references.keys())if(!guaranteed.has(key))bindings.references.delete(key);
          current=push(current,left);
        } else {
          const left=this.single(node.left,env,bindings,node),right=isBottom(left)?BOTTOM:this.single(node.right,env,bindings,node);
          if(isBottom(left)||isBottom(right)){current=BOTTOM;if(trace){trace.output=current;this.trace.set(node,trace);}continue;}
          const effect=instantiate(this.functions.get(node.value));if(trace)trace.operatorEffects.push(effect);
          const result=this.apply(effect,stack(EMPTY,left,right),node);
          const value=variable();unify(result,push(EMPTY,value),node);current=push(current,value);
        }
      } else if(node.kind==='record') {
        const holes=missingOperands([node]).filter(h=>!bound.has(h)),values=[];
        for(const h of holes){let value;[current,value]=this.pop(current,node);values.unshift(value);}
        const bindings=new Map(bound);bindings.references=bound.references;
        holes.forEach((h,i)=>bindings.set(h,values[i]));
        const fields=[];for(const f of node.fields){const value=this.single(f.body,env,bindings,node);if(isBottom(value)){current=BOTTOM;break;}fields.push([f.name,value]);}
        if(!isBottom(current))current=push(current,record(fields));
      } else if(node.kind==='field') {
        let value;[current,value]=this.pop(current,node);const item=variable();
        unify(value,record([[node.name,item]],variable('record-row')),node);current=push(current,item);
      } else if(node.kind==='tuple') {
        let result=prune(this.sequence(node.body,EMPTY,new Map(env),bound));const items=[];
        while(result.tag==='push'){items.unshift(result.item);result=prune(result.rest);}
        if(isBottom(result))current=BOTTOM;else {unify(result,EMPTY,node);current=push(current,tuple(items));}
      } else if(node.kind==='dict'){const key=variable(),value=variable();for(let j=0;j<node.fields.length;j+=2){unify(key,this.single(node.fields[j].body,env,bound,node),node);unify(value,this.single(node.fields[j+1].body,env,bound,node),node);}current=push(current,adt('dict',[key,value]));
      } else if(node.kind==='path-update') {
        let original;[current,original]=this.pop(current,node);
        const args=node.fields.slice(0,-1).map(f=>this.single(f.body,env,bound,node));
        if(args.some(isBottom)){current=BOTTOM;}else {
          const replace=(type,depth)=>{
            if(depth===node.path.length){
              if(!node.updating)return this.single(node.fields.at(-1).body,env,bound,node);
              const result=this.sequence(node.fields.at(-1).body,stack(EMPTY,type),new Map(env)),item=variable();
              if(isBottom(result))return BOTTOM;
              unify(result,stack(EMPTY,item),node);return item;
            }
            const part=node.path[depth],item=variable();
            if(part.kind==='field') {
              const tail=variable('record-row');unify(type,record([[part.name,item]],tail),node);
              const result=replace(item,depth+1);return isBottom(result)?BOTTOM:record([[part.name,result]],tail);
            }
            if(part.kind==='tuple-index') {
              const items=Array.from({length:part.index+1},()=>variable()),tail=variable('tuple-row');
              unify(type,tuple(items,tail),node);items[part.index]=replace(items[part.index],depth+1);return isBottom(items[part.index])?BOTTOM:tuple(items,tail);
            }
            const get=instantiate(this.functions.get('at')),set=instantiate(this.functions.get('setAt'));
            unify(get,quote(stack(EMPTY,type,args[part.argument]),push(EMPTY,item)),node);
            const result=replace(item,depth+1);if(isBottom(result))return BOTTOM;
            unify(set,quote(stack(EMPTY,type,args[part.argument],result),push(EMPTY,type)),node);
            this.effectSink.dependencies.push({row:get.effects,...(part.optional||node.defaulting?{exclude:['exn']}:{})},{row:set.effects});
            if(trace){trace.indexPaths??=[];trace.indexPaths[depth]={get,set};}return type;
          };
          const result=replace(original,0);current=isBottom(result)?BOTTOM:push(current,result);
        }
      } else if(node.kind==='list-index') {
        if(node.optional && !isStandardOption({dataTypes:this.dataTypes,constructors:this.constructors}))throw new StaticTypeError('Optional indexing requires data option a = None | Some a',node);
        let value;[current,value]=this.pop(current,node);const item=variable();
        const index=this.single(node.body,env,bound,node);
        if(isBottom(index))current=BOTTOM;
        else {
          const get=instantiate(this.functions.get('at'));unify(get,quote(stack(EMPTY,value,index),push(EMPTY,item)),node);
          if(trace)trace.indexGet=get;
          this.effectSink.dependencies.push({row:get.effects,...(node.optional?{exclude:['exn']}:{})});
          current=push(current,node.optional?adt('option',[item]):item);
        }
      } else if(node.kind==='tuple-index') {
        let value;[current,value]=this.pop(current,node);
        const items=Array.from({length:node.index+1},()=>variable());
        unify(value,tuple(items,variable('tuple-row')),node);current=push(current,items[node.index]);
      } else if(node.kind==='list') {
        let result=prune(this.sequence(node.body,EMPTY,new Map(env),bound));
        const item=variable();
        while(result.tag==='push'){unify(item,result.item,node);result=prune(result.rest);}
        if(isBottom(result))current=BOTTOM;else {unify(result,EMPTY,node);current=push(current,list(item));}
      } else if(node.kind==='quote') {
        const captured=[...envFree(env)].filter(v=>v.sort!=='row'),input=row(),type=this.labeledBlock(node.body,input,new Map(env),node.blockLabel,node);
        if(captured.length)type.captures=captured;
        current=push(current,type);
      } else if(env.has(node.value)) {
        const scheme=env.get(node.value),type=instantiate(scheme);
        if(scheme.callable){if(trace)trace.effect=type;current=this.apply(type,current,node);}
        else current=push(current,type);
        if(node.ephemeral){env.delete(node.value);env.locals?.delete(node.value);}
      }
      else if(node.value==='fromYield') {
        let body;[current,body]=this.pop(current,node);const expected=quote(EMPTY,row());unify(body,expected,node);
        const item=variable(),op=this.effects.get('yield');
        if(!op || op.inputCount!==1 || op.outputCount!==0 || op.never || op.parameters.length!==1)throw new StaticTypeError('fromYield requires effect yield a : a ->',node);
        const params=new Map(),signature=syntaxType(op.syntax,params);unify(prune(signature.input).item,item,node);
        const view=effectView(expected.effects);
        for(const entry of view.entries.filter(e=>(e.operation||e.name)==='yield' && (e.target?e.target===node.handlerLabel:!e.skip)))unify(item,entry.args[0],node);
        
        const result={tag:'stream',item,effects:effects([],[{row:expected.effects,exclude:['yield'],yieldItem:item,label:node.handlerLabel}])};
        if(trace)trace.bodyType=expected;
        current=push(current,result);
      }
      else if(node.value==='handle') {
        let handlers,body;[current,handlers]=this.pop(current,node);[current,body]=this.pop(current,node);
        const answer=row(),expectedBody=quote(EMPTY,answer);unify(body,expectedBody,node);
        const residual=effects([],[{row:expectedBody.effects,handlers,label:node.handlerLabel}]);
        const expectedHandlers=requireHandlers(handlers,answer,node,residual);
        this.effectSink.dependencies.push({row:residual},{handlers,handlerEffects:true,body:expectedBody.effects,label:node.handlerLabel});
        if(trace){trace.handlers=expectedHandlers;trace.bodyType=expectedBody;}
        current=concatRows(current,answer);
      }
      else if(this.functions.has(node.value)) {
        if(['maxi','mini','maxiBy','miniBy','nth'].includes(node.value)&&!isStandardOption({dataTypes:this.dataTypes,constructors:this.constructors}))throw new StaticTypeError(node.value+' requires data option a = None | Some a',node);
        if(node.value==='toNum' && !isStandardOption({dataTypes:this.dataTypes,constructors:this.constructors}))throw new StaticTypeError('toNum requires data option a = None | Some a',node);
        if((['each','vmap','vfilter','fold','sortBy','maxiBy','miniBy','all','any','while','when','chunkBy','groupBy'].includes(node.value)||transforms.has(node.value))) {
          const adapt=(type)=>{type=prune(type);if(type.tag!=='quote'||!isBottom(type.output))return type;
            return {...type,output:row(),originalNever:true};
          };
          const top=prune(current);if(top.tag==='push'){current=push(top.rest,adapt(top.item));if(node.value==='while'){const rest=prune(top.rest);if(rest.tag==='push')current=push(push(rest.rest,adapt(rest.item)),prune(current).item);}}
          if(trace)trace.input=current;
        }
        if(node.value==='while') {
          const top=prune(current),rest=top.tag==='push'?prune(top.rest):null,condition=rest?.tag==='push'?prune(rest.item):null;
          if(condition?.tag==='quote' && effectView(condition.effects).entries.some(e=>(e.operation||e.name)==='cancel' && (e.target?e.target===node.handlerLabel:!e.skip)))unify(condition.output,push(condition.input,BOOL),node);
        }
        const effect=instantiate(this.functions.get(node.value)),before=current;
        if(node.target)effect.effects=effects(effectView(effect.effects).entries.map(e=>({...e,target:node.target})));
        if(node.handlerLabel){for(const dependency of effect.effects?.dependencies||[])if(dependency.loop)dependency.label=node.handlerLabel;const output=prune(effect.output);if(output.tag==='push' && prune(output.item).tag==='stream')for(const d of prune(output.item).effects.dependencies||[])if(d.loop)d.label=node.handlerLabel;}
        if(trace)trace.effect=effect;
        current=this.apply(effect,current,node);
        if(this.effects.has(node.value)&&!this.effects.get(node.value).rowParameters?.length)for(const v of free(effect.input))if(v.numericLiterals)unify(v,INT,node);
        if(['sort','sortBy','maxi','mini','maxiBy','miniBy','max','min'].includes(node.value)) {
          const input=prune(before),key=['sortBy','maxiBy','miniBy'].includes(node.value)?prune(prune(input.item).output).item:node.value==='sort'?prune(prune(current).item).item:['max','min'].includes(node.value)?prune(current).item:prune(prune(current).item).args[0];
          const comparison=instantiate(this.functions.get('<'));
          unify(comparison,quote(stack(EMPTY,key,key),stack(EMPTY,BOOL)),node);
          this.effectSink.dependencies.push(['max','min'].includes(node.value)?{row:comparison.effects}:{row:comparison.effects,exclude:['cancel','break'],loop:true,breakOutput:effect.output,label:node.handlerLabel});
          if(trace)trace.comparison=comparison;
        }
        if(node.value==='while') {
          const input=prune(before),rest=input.tag==='push'?prune(input.rest):null,condition=rest?.tag==='push'?prune(rest.item):null;
          if(condition?.tag==='quote' && isBottom(condition.output) && !effectView(condition.effects).entries.some(e=>['cancel','break'].includes(e.name))){current=BOTTOM;effect.output=BOTTOM;}
        }
      }
      else throw new StaticTypeError(`Unknown word: ${node.value}`,node);
      if(trace) { trace.output=current;this.trace.set(node,trace); }
    }
    return current;
  }
  value(value,token) {
    if(this.hostTypes?.has(value))return instantiate(generalize(this.hostTypes.get(value)));
    if(value?.kind==='cell') {
      if(!this.cells.has(value)) {
        const type=variable(); this.cells.set(value,type);
        if(value.staticType) {
          for(const v of free(value.staticType)) if(!this.replacements.has(v)) this.replacements.set(v,variable(v.sort));
          unify(type,clone(value.staticType,this.replacements),token);
        }
        // Revalidate closures too: redefining a referenced function must not
        // invalidate the saved type of a mutable quotation.
        unify(type,this.value(value.value,token),token);
      }
      return this.cells.get(value);
    }
    if(value?.kind==='effect-label')return atom('effect-label');
    if(value?.kind==='stream') {
      if(value.mode==='dict-values'){const k=variable(),v=variable();unify(this.value(value.source,token),adt('dict',[k,v]),token);return {tag:'stream',item:v,effects:effects()};}
      if(value.mode==='snapshot'){const item=variable();for(const v of value.items)unify(item,this.value(v,token),token);return {tag:'stream',item,effects:effects()};}
      if(value.mode==='partition'){
        const item=variable(),latent=variable('effect-row'),deps=[{row:latent}];requireIterable(this.value(value.source,token),item,token,latent);
        if(value.operation==='chunkBy'){const key=variable(),block=this.value(value.block,token);unify(block,quote(push(EMPTY,item),push(EMPTY,key)),token);deps.push({row:block.effects});}
        return {tag:'stream',item:value.operation==='chunkBy'?{tag:'stream',item,effects:effects()}:list(item),effects:effects([],[{row:effects([],deps),exclude:['cancel','break'],loop:true,breakOutput:EMPTY,label:value.label?.key}])};
      }
      if(value.mode==='zip'){const a=variable(),b=variable(),le=variable('effect-row'),re=variable('effect-row');requireIterable(this.value(value.left,token),a,token,le);requireIterable(this.value(value.right,token),b,token,re);return {tag:'stream',item:tuple([a,b]),effects:effects([],[{row:effects([],[{row:le},{row:re}]),exclude:['break','cancel'],breakOutput:EMPTY,loop:true,label:value.label?.key}])};}
      if(value.mode==='combinatorial'){
        const a=variable(),latent=variable('effect-row'),deps=[{row:latent}];requireIterable(this.value(value.source,token),a,token,latent);let item=list(a);
        if(value.operation==='cartesianProduct'){const b=variable(),other=variable('effect-row');requireIterable(this.value(value.right,token),b,token,other);deps.push({row:other});item=tuple([a,b]);}
        return {tag:'stream',item,effects:effects([],[{row:effects([],deps),exclude:['cancel','break'],loop:true,breakOutput:EMPTY}])};
      }
      if(value.mode==='split')return {tag:'stream',item:STRING,effects:effects()};
      if(value.mode==='fromYield') {const block=this.value(value.block,token),item=variable();unify(block,quote(EMPTY,row()),token);for(const e of effectView(block.effects).entries.filter(e=>(e.operation||e.name)==='yield' && (e.target?e.target===value.label?.key:!e.skip)))unify(item,e.args[0],token);return {tag:'stream',item,effects:effects([],[{row:block.effects,exclude:['yield'],label:value.label?.key}])};}
      const mode=value.mode,item=variable(),latent=variable('effect-row'),nested=variable('effect-row');requireIterable(this.value(value.source,token),item,token,latent);
      const deps=[{row:latent}];let result=item;
      if(callbackTransform(mode)) {const block=this.value(value.block,token),mapped=variable();unify(block,quote(stack(EMPTY,item),stack(EMPTY,predicateTransform(mode)?BOOL:mapped)),token);deps.push({row:block.effects});if(mode==='map')result=mapped;if(mode==='flatMap'){result=variable();requireIterable(mapped,result,token,nested);deps.push({row:nested});}}
      if(mode==='flatten'){result=variable();requireIterable(item,result,token,nested);deps.push({row:nested});}
      return {tag:'stream',item:result,effects:effects([],[{row:effects([],deps),exclude:['cancel','break'],breakOutput:EMPTY,label:value.label?.key}])};
    }
    if(value?.kind==='range')return atom('range');
    if(value?.kind==='tuple')return tuple(value.items.map(v=>this.value(v,token)));
    if(value?.kind==='dict'){const key=variable(),item=variable();for(const [k,v] of value.entries){unify(key,this.value(k,token),token);unify(item,this.value(v,token),token);}return adt('dict',[key,item]);}
    if(value?.kind==='record')return record(Object.entries(value.fields).map(([k,v])=>[k,this.value(v,token)]));
    if(value?.kind==='scalar')return atom(value.type);
    if(typeof value==='number') return INT;
    if(typeof value==='boolean') return BOOL;
    if(typeof value==='string') return STRING;
    if(value?.kind==='adt') {
      const constructor=this.constructors.get(value.constructor);
      if(!constructor || constructor.typeName!==value.typeName || constructor.fields.length!==value.fields.length)
        throw new StaticTypeError(`Unknown or invalid constructor value: ${value.constructor}`,token);
      const {fields,result}=constructorTypes(constructor);
      fields.forEach((type,i)=>unify(type,this.value(value.fields[i],token),token));
      return result;
    }
    if(Array.isArray(value)){const item=variable();for(const x of value)unify(item,this.value(x,token),token);return list(item);}
    if(value?.kind==='local-function') {
      if(this.localFunctions.has(value))return this.localFunctions.get(value);
      const placeholder=quote(row(),row());this.localFunctions.set(value,placeholder);
      const env=new Map([...value.env].filter(([n])=>n!==value.name).map(([n,v])=>[n,this.scheme(v,token)]));
      const scheme=this.localEffect(value.name,value.body,env,token);unify(placeholder,scheme.type,token);return placeholder;
    }
    if(value?.kind==='closure') {
      const env=new Map([...value.env].map(([n,v])=>[n,this.scheme(v,token)]));
      const input=row(),parent=this.trace;
      if(this.quotations)this.trace=new Map();
      const type=this.labeledBlock(value.body,input,env,value.blockLabel,token||value.body[0]);
      if(this.quotations){this.quotations.set(value,{type,trace:this.trace});this.trace=parent;}
      return type;
    }
    throw new StaticTypeError('Unsupported host value',token);
  }
  pattern(pattern,type,env) {
    if(pattern.kind==='tuple-pattern') {
      const items=pattern.fields.map(()=>variable());unify(type,tuple(items),pattern);
      pattern.fields.forEach((p,i)=>this.pattern(p,items[i],env));
    }
    else if(pattern.kind==='literal')unify(type,typeof pattern.value==='number'?((pattern.numericKind==='float'||!Number.isInteger(pattern.value))?FLOAT:{...variable(),numericLiterals:[pattern.numberSource??String(pattern.value)],numericPattern:true}):this.value(pattern.value,pattern),pattern);
    else if(pattern.kind==='list-pattern' || pattern.kind==='push-pattern') {
      const item=variable();unify(type,list(item),pattern);
      pattern.fields.forEach((p,i)=>this.pattern(p,pattern.kind==='push-pattern' && i===0 ? list(item) : item,env));
    }
    else if(pattern.kind==='constructor') {
      const {fields,result}=constructorTypes(this.constructors.get(pattern.value));
      unify(type,result,pattern);
      pattern.fields.forEach((p,i)=>this.pattern(p,fields[i],env));
    } else if(pattern.value!=='_'){if(pattern.mutable)weakEffects(type);env.set(pattern.value,{...mono(type),...(pattern.mutable?{mutable:true}:{})});}
  }
  scheme(value,token) {
    const type=this.value(value,token),excluded=new Set();
    for(const t of this.cells.values()) for(const v of free(t)) excluded.add(v);
    return value?.kind==='cell' ? {...mono(type),mutable:true} : {...generalize(type,excluded),...(value?.kind==='local-function'?{callable:true}:{})};
  }
}

function syntaxValue(syntax,parameters){const value=syntaxType(syntax,parameters);if(sortOf(prune(value))!=='value')throw new StaticTypeError('Stack row used as a value type');return value;}
function syntaxStack(nodes,parameters,base=row()){let result=base;for(const [i,node] of nodes.entries()){if(node.tag==='stack-row'){if(i)throw new StaticTypeError('Stack row must precede stack values');result=syntaxType(node,parameters);}else result=push(result,syntaxValue(node,parameters));}return result;}
function syntaxType(syntax,parameters) {
  if(syntax.tag==='stack-sequence')return syntaxStack(syntax.items,parameters,EMPTY);
  if(syntax.tag==='stack-row'){if(!parameters.has(syntax.name))parameters.set(syntax.name,row());const value=parameters.get(syntax.name);if(sortOf(prune(value))!=='row')throw new StaticTypeError('Stack row parameter used as another kind of type');value.keepNativePrefix=true;return value;}
  if(syntax.tag==='stream'){const block=syntaxType(syntax.block,parameters);return {tag:'stream',item:syntaxValue(syntax.item,parameters),effects:block.effects,effectBound:block.effectBound};}
  if(syntax.tag==='param') {
    if(!parameters.has(syntax.name))parameters.set(syntax.name,variable());
    const type=parameters.get(syntax.name);if(sortOf(prune(type))!=='value')throw new StaticTypeError('Record row parameter used as a value type');return type;
  }
  if(syntax.tag==='tuple') {
    let tail=TEND;
    if(syntax.tail){if(!parameters.has(syntax.tail))parameters.set(syntax.tail,variable('tuple-row'));tail=parameters.get(syntax.tail);if(sortOf(prune(tail))!=='tuple-row')throw new StaticTypeError('Tuple row parameter used as another kind of type');}
    return tuple(syntax.items.map(t=>syntaxValue(t,parameters)),tail);
  }
  if(syntax.tag==='record') {
    let tail=REMPTY;
    if(syntax.tail){if(!parameters.has(syntax.tail))parameters.set(syntax.tail,variable('record-row'));tail=parameters.get(syntax.tail);if(sortOf(prune(tail))!=='record-row')throw new StaticTypeError('Record row parameter used as a value type');}
    return record(syntax.fields.map(([k,v])=>[k,syntaxValue(v,parameters)]),tail);
  }
  if(syntax.tag==='atom')return atom(syntax.name);
  if(syntax.tag==='list')return list(syntaxValue(syntax.item,parameters));
  if(syntax.tag==='adt')return adt(syntax.name,syntax.args.map(t=>syntaxValue(t,parameters)));
  const s=row();
  const result=quote(syntaxStack(syntax.input,parameters,s),syntax.never?BOTTOM:syntaxStack(syntax.output,parameters,s));
  if(syntax.effects) {
    result.effects=effects(syntax.effects.map(e=>{
      const op=activeFamilies.get(e.name);if(!op)throw new StaticTypeError(`Unknown effect: ${e.name}`);
      if(e.args.length!==(op.parameters?.length||0))throw new StaticTypeError(`Effect ${e.name} requires ${op.parameters?.length||0} type arguments`);
      const args=e.args.map(t=>syntaxType(t,parameters));args.forEach((t,i)=>{if(sortOf(prune(t))!==(op.rowParameters?.includes(op.parameters[i])?'row':'value'))throw new StaticTypeError(`Wrong kind of argument for effect ${e.name}`);});return {name:e.name,args};
    }));
    if(syntax.effectTail){
      if(!parameters.has(syntax.effectTail))parameters.set(syntax.effectTail,variable('effect-row'));
      const tail=parameters.get(syntax.effectTail);if(sortOf(prune(tail))!=='effect-row')throw new StaticTypeError('Effect row parameter used as another kind of type');
      result.effects.dependencies.push({row:tail});
    }
    result.effectBound=effects([...result.effects.entries],[...result.effects.dependencies]);
  }
  return result;
}
function constructorTypes(constructor) {
  const parameters=new Map(constructor.parameters.map(name=>[name,variable()]));
  return {fields:constructor.fields.map(t=>syntaxValue(t,parameters)),result:adt(constructor.typeName,[...parameters.values()])};
}

// Declarations use : syntax. A single arrow separates input
// and output stacks; lowercase type names are universally quantified.
function annotation(source, token, dataTypes,extraParameters=[]) {
  if(source.trim()==='!')return generalize(quote(row(),BOTTOM));
  const parts=source.split('=>');
  if(parts.length>2)throw new StaticTypeError('Invalid constraint annotation',token);
  const effectSource=parts.at(-1),parameters=new Map(extraParameters.map(n=>[n,variable()]));
  const tokens=effectSource.match(/\.\.|->|[\[\]{}():,|#!/]|'?[A-Za-z_][A-Za-z0-9_']*/g)||[];
  if(tokens.join('')!==effectSource.replace(/\s/g,'')) throw new StaticTypeError('Invalid type annotation',token);
  const parser=typeSyntax(tokens,dataTypes,null,message=>{throw new StaticTypeError(message,token);});
  let depth=0,hasArrow=false;
  for(const t of tokens){if(t==='->' && depth===0)hasArrow=true;if(['(','[','{'].includes(t))depth++;if([')',']','}'].includes(t))depth--;}
  let result;
  if(hasArrow)result=parser.effect();
  else {const output=parser.types();if(output.length!==1)throw new StaticTypeError('Value annotation requires one type',token);result={tag:'quote',input:[],output};}
  if(!parser.done())throw new StaticTypeError('Unexpected type annotation token',token);
  const type=syntaxType(result,parameters);
  if(parts.length===2)for(const constraint of parts[0].split(',')) {
    const c=classConstraint(constraint,n=>activeClasses.has(n)||n==='handles');
    if(!c)throw new StaticTypeError('Invalid class constraint',token);
    const cls=activeClasses.get(c.name),associatedCount=c.name==='streem'?1:(cls?.associated?.length||0),count=cls?classParameters(cls).length:1;
    const parser=typeSyntax(c.args,dataTypes,null,m=>{throw new StaticTypeError(m,token);}),syntax=parser.types();if(!parser.done())throw new StaticTypeError('Invalid class constraint type',token);
    const args=syntax.map((t,i)=>{
      function check(t){if(t?.tag==='param'&&!parameters.has(t.name)){if(associatedCount&&i>=count&&t.name.startsWith("'"))parameters.set(t.name,variable());else throw new StaticTypeError('Constraint must name a type variable in the method effect',token);}else if(t&&typeof t==='object')for(const v of Object.values(t))if(Array.isArray(v))v.forEach(check);else if(v&&typeof v==='object')check(v);}
      check(t);return syntaxType(t,parameters);
    });
    if(c.name==='handles'&&args.length===2)requireHandlers(args[0],push(EMPTY,args[1]),token);
    else requireConstraint(c.name,args,token);
  }
  return {...generalize(type),parameters};
}

function dependencies(clauses,definitions,globals) {
  const result=new Set(),seen=new Set();
  function valueDependencies(value) {
    if(!value || typeof value!=='object' || seen.has(value))return;
    seen.add(value);
    if(Array.isArray(value))value.forEach(valueDependencies);
    else if(value.kind==='tuple')value.items.forEach(valueDependencies);
    else if(value.kind==='adt')value.fields.forEach(valueDependencies);
    else if(value.kind==='cell')valueDependencies(value.value);
    else if(value.kind==='record')Object.values(value.fields).forEach(valueDependencies);
    else if(value.kind==='closure' || value.kind==='local-function')walk(value.body,new Set(value.kind==='local-function'?[value.name]:[]),value.env);
  }
  function walk(nodes,locals,captured=globals) {
    for(const n of nodes) {
      if(n.kind==='bind')n.names.forEach(x=>locals.add(x));
      else if(n.kind==='local-function'){locals.add(n.name);walk(n.body,new Set(locals),captured);}
      else if(n.kind==='word' && !locals.has(n.value)){
        if(captured.has(n.value))valueDependencies(captured.get(n.value));
        else if(definitions.has(n.value))result.add(n.value);
      }
      else if(['record','dict','path-update'].includes(n.kind))n.fields.forEach(f=>walk(f.body,new Set(locals),captured));
      else if(n.body)walk(n.body,new Set(locals),captured);
      else if(n.kind==='binary'){walk(n.left,new Set(locals),captured);walk(n.right,new Set(locals),captured);}
      else if(n.kind==='comparison-chain')n.operands.forEach(operand=>walk(operand,new Set(locals),captured));
      else if(n.kind==='case')for(const branch of n.branches) {
        const branchLocals=new Set([...locals,...patternNames(branch.patterns)]);
        if(branch.guard)walk(branch.guard,new Set(branchLocals),captured);
        walk(branch.body,branchLocals,captured);
      }
    }
  }
  for(const c of clauses) {
    if(c.guard)walk(c.guard,new Set(patternNames(c.patterns)));
    walk(c.body,new Set(patternNames(c.patterns)));
  }
  return result;
}
function components(definitions,globals) {
  let index=0;const ids=new Map(),low=new Map(),pending=[],active=new Set(),result=[];
  function visit(name) {
    ids.set(name,index);low.set(name,index++);pending.push(name);active.add(name);
    for(const dependency of dependencies(definitions.get(name),definitions,globals)) {
      if(!ids.has(dependency)){visit(dependency);low.set(name,Math.min(low.get(name),low.get(dependency)));}
      else if(active.has(dependency))low.set(name,Math.min(low.get(name),ids.get(dependency)));
    }
    if(low.get(name)===ids.get(name)){
      const group=[];let member;do{member=pending.pop();active.delete(member);group.push(member);}while(member!==name);result.push(group);
    }
  }
  for(const name of definitions.keys())if(!ids.has(name))visit(name);
  return result;
}

function prepare(definitions,globalValues,initialized=false) {
  definitions=withStandardFunctions(withOption(definitions));
  const operators=installOperatorClasses(new Map(definitions.classes||[]),new Map(definitions.methods||[]));resolveInheritance(operators.classes,(message,t)=>{throw new StaticTypeError(message,t);});
  activeClasses=operators.classes;
  const inference=new Inference();
  inference.classes=activeClasses;
  inference.effects=ioEffects(definitions.effects);activeEffects=inference.effects;activeFamilies=effectFamilies(activeEffects);
  for(const [name,op] of inference.effects){const params=new Map((op.rowParameters||[]).map(p=>[p,row()]));if(op.grouped)for(const member of activeFamilies.get(op.group).operations)syntaxType(member.syntax,params);const type=syntaxType(op.syntax,params);type.effects=effects([{name:op.group||name,...(op.grouped?{operation:name}:{}),args:(op.parameters||[]).map(n=>params.get(n))}]);inference.functions.set(name,generalize(type));}
  for(const [name,m] of operators.methods) {
    if(m.specialEach){inference.functions.set(name,eachEffect());continue;}
    const associated=activeClasses.get(m.className).associated||[],scheme=annotation(`${m.className} ${[...classParameters(activeClasses.get(m.className)),...associated.map(a=>a.param)].join(' ')} => ${m.signature}`,m.token,definitions.dataTypes||new Map(),[...classParameters(activeClasses.get(m.className)),...associated.map(a=>a.param)]);
    if(!scheme.type.effectBound)scheme.type.effects=effects();
    const input=[];let t=prune(scheme.type.input);while(t.tag==='push'){input.unshift(prune(t.item));t=prune(t.rest);}
    const index=input.indexOf(scheme.parameters.get(m.param));
    scheme.type.dispatchType=scheme.parameters.get(m.param);
    scheme.type.dispatchTypes=classParameters(activeClasses.get(m.className)).map(p=>scheme.parameters.get(p));
    m.inputCount=input.length;m.dispatchIndex=index;
    inference.functions.set(name,scheme);
  }
  inference.dataTypes=definitions.dataTypes;
  inference.constructors=definitions.constructors || new Map();
  for(const c of activeClasses.values())if(c.supers?.length)for(const instance of c.instances.values()){
    const params=new Map(),heads=instanceHeads(instance).map(h=>syntaxType(h,params));applyContext(instance.context,params,instance.token);
    const args=[...heads,...(c.associated||[]).map(a=>syntaxType(instance.associated.get(a.name),params))];
    const checked=instantiate(generalize(tuple(args)),true);requireConstraint(c.name,checked.items,instance.token);
  }

  for(const [name,constructor] of inference.constructors) {
    const {fields,result}=constructorTypes(constructor),s=row();
    inference.functions.set(name,generalize(quote(stack(s,...fields),push(s,result),effects())));
  }
  for(const name of globalValues.keys())if(inference.functions.has(name)||definitions.has(name))
    throw new StaticTypeError(`Global variable conflicts with function: ${name}`);
  // Reserve names for recursive closures stored in the REPL environment.
  for(const name of definitions.keys())inference.functions.set(name,generalize(quote(row(),row())));
  for(const [name,value] of globalValues)inference.globals.set(name,inference.scheme(value));
  const initializers=initialized ? [] : definitions.initializers || [];
  inference.rootEnv=inference.globals;
  inference.globals.locals=new Set(globalValues.keys());
  unify(inference.sequence(initializers,EMPTY,inference.globals),EMPTY);
  const initialGlobals=new Map([...inference.globals].filter(([name])=>!globalValues.has(name)));
  const rebuild=()=>new Map([...globalValues].map(([name,value])=>[name,inference.scheme(value)]).concat([...initialGlobals]));
  for(const group of components(definitions,globalValues)) {
    inference.globals=rebuild();
    function inferBody(name,effect) {
      for(const clause of definitions.get(name)) {
        const base=row(),args=clause.patterns.map(()=>variable()),env=new Map(inference.globals);
        env.locals=new Set(patternNames(clause.patterns));
        clause.patterns.forEach((p,i)=>inference.pattern(p,args[i],env));
        const parentSink=inference.effectSink;inference.effectSink=effects();
        let bodyInput=base;
        if(clause.guard){bodyInput=inference.sequence(clause.guard,base,new Map(env));let flag;[bodyInput,flag]=inference.pop(bodyInput,clause.token);unify(flag,BOOL,clause.token);}
        const output=inference.sequence(clause.body,bodyInput,env);
        unify(effect,quote(stack(base,...args),output,inference.effectSink),clause.token);inference.effectSink=parentSink;
      }
    }
    const recursive=group.length>1 || dependencies(definitions.get(group[0]),definitions,globalValues).has(group[0]);
    if(recursive) {
      // Discover candidate effects without making recursive calls share the
      // caller's ambient row. Then validate EVERY body against those candidates,
      // allowing only common stack tails (never value types) to vary recursively.
      for(const name of group){const signature=definitions.get(name).signature,declared=typeof signature==='string'?annotation(signature,definitions.get(name)[0].token,definitions.dataTypes):null;if(declared && !declared.type.effectBound)declared.type.effects=effects();inference.functions.set(name,declared && isBottom(declared.type.output)?declared:generalize(quote(row(),row(),effects())));}
      const candidates=new Map();
      for(const name of group){const effect=quote(row(),row());inferBody(name,effect);candidates.set(name,effect);}
      function rowParameters(t,found=new Set()) {
        t=prune(t);
        if(t.tag==='quote') {
          const tail=x=>{x=prune(x);while(x.tag==='push')x=prune(x.rest);return x;};
          const a=tail(t.input),b=tail(t.output);
          if(a===b && a.tag==='var')found.add(a);
        }
        for(const child of children(t))rowParameters(child,found);
        return found;
      }
      for(const [name,type] of candidates)inference.functions.set(name,{type,vars:rowParameters(type)});
      for(let pass=0;pass<=group.length;pass++)for(const [name,type] of candidates)inferBody(name,type);
    } else inferBody(group[0],inference.functions.get(group[0]).type);
    const excluded=envFree(inference.globals);
    const published=new Map();
    for(const name of group) {
      const clauses=definitions.get(name),inferred=generalize(inference.functions.get(name).type,excluded);
      if(clauses.signature) {
        const declared=clauses.signature.each?eachEffect(clauses.signature.each):annotation(clauses.signature,clauses[0].token,definitions.dataTypes || new Map());
        // Class dispatch uses the method contract, so implementations must not
        // silently introduce effects absent from that contract.
        if(name.startsWith('__tc_') && !declared.type.effectBound) {
          if(clauses.signature.each) {
            if(effectView(inferred.type.effects).entries.length)throw new StaticTypeError('each instance must handle its own operations; callback effects are propagated',clauses[0].token);
          } else declared.type.effectBound=effects();
        }
        checkNeverPromises(inferred.type,declared.type,clauses[0].token);
        if(isBottom(declared.type.output) && !isBottom(inferred.type.output))throw new StaticTypeError('Function annotated ! may return normally',clauses[0].token);
        const bindings=new Map(),checked=instantiate(declared,true,bindings);
        const actual=instantiate(inferred);checkEffectPromises(actual,checked,clauses[0].token);unify(actual,checked,clauses[0].token);
        const restore=new Map([...bindings].map(([v,fresh])=>[fresh,v]));
        published.set(name,{...declared,type:clone(checked,restore)});
      } else published.set(name,generalizeNumbers(inferred,clauses[0].token));
    }
    for(const [name,scheme] of published)inference.functions.set(name,scheme);
  }
  // Recheck saved closures against the now-final function schemes. Earlier
  // passes may have cached cells while recursive names were placeholders.
  inference.cells=new Map();inference.localFunctions=new Map();inference.replacements=new Map();
  inference.globals=rebuild();
  if(initializers.length) {
    inference.trace=new Map();
    const env=new Map([...globalValues].map(([name,value])=>[name,inference.scheme(value)]));
    env.locals=new Set(globalValues.keys());inference.rootEnv=env;
    unify(inference.sequence(initializers,EMPTY,env),EMPTY);
    for(const [name,scheme] of initialGlobals) unify(scheme.type,env.get(name).type);
  }
  return inference;
}

export function checkDefinitions(definitions,globals=new Map()) {
  const inference=prepare(definitions,globals);
  return new Map([...inference.effects.keys(),...inference.constructors.keys(),...definitions.methods?.keys()||[],...[...definitions.keys()].filter(n=>!n.startsWith('__tc_'))].map(name=>[name,formatType(inference.functions.get(name).type)]));
}
export function checkExpression(nodes,definitions=new Map(),globals=new Map(),values=[],plan={},initialized=false) {
  const inference=prepare(definitions,globals,initialized),env=new Map(inference.globals);
  env.locals=new Set(env.keys());
  inference.rootEnv=env;
  inference.trace??=new Map();
  const input=stack(EMPTY,...values.map(v=>inference.value(v))),output=inference.sequence(nodes,input,env);
  if(true) {
    plan.dispatch=executionTypes(inference,definitions);plan.dispatch.numericOnly=![...definitions.methods?.values()||[]].some(m=>m.dispatchIndex<0&&!m.specialCast);
    plan.dispatch.validate([...(initialized?[]:definitions.initializers||[]),...nodes],inference.trace);
  }
  for(const type of [...inference.cells.values(),...[...env.values()].map(s=>s.type)])for(const v of free(type))if(v.numericLiterals)unify(v,INT);
  plan.cells=inference.cells;plan.bindings=inference.bindings;
  // Internal visitors and live continuations have no source-level body to
  // reconstruct. Their argument contract was checked at the call site.
  const opaque=(value,seen=new Set())=>{
    if(!value||typeof value!=='object'||seen.has(value))return false;seen.add(value);
    if(value.native||value.kind==='continuation')return true;
    const parts=Array.isArray(value)?value:value instanceof Map?[...value.values()]:Object.values(value);
    return parts.some(v=>opaque(v,seen));
  };
  plan.valueType=value=>opaque(value)?undefined:inference.value(value);
  return formatType(quote(input,output,inference.effectSink));
}
// Effect rows are unions in ordinary inference. At a specialized call site,
// a uniquely known operation signature also supplies expected argument types.
function specializeEffects(actual,expected,token) {
  const entries=effectView(expected).entries;
  for(const e of effectView(actual).entries) {
    const candidates=entries.filter(x=>x.name===e.name && x.target===e.target && (x.skip||0)===(e.skip||0));
    const distinct=new Map(candidates.map(x=>[x.args.map(formatType).join(','),x]));
    if(distinct.size===1)e.args.forEach((a,i)=>unify(a,[...distinct.values()][0].args[i],token));
  }
}
// Runtime dictionaries are specialized from solved call-site types. Runtime
// arguments are used to reconnect stored closures to those types, never to
// guess an instance from a method result.
function integerLiteralInfo(definitions,node,type){
 type=prune(type);if(type.tag==='var'){unify(type,INT,node);type=prune(type);}
 if(type.tag==='atom'&&['int','float','byte'].includes(type.name))return {type:type.name};
 requireClass('num',type,node);
 try{const value=BigInt(node.numberSource??String(node.value));if(value< -9223372036854775808n||value>9223372036854775807n)throw new Error();}catch{throw new StaticTypeError('int literal is outside signed 64-bit range',node);}
 const effect=quote(stack(EMPTY,INT),stack(EMPTY,type),effects([{name:'exn',args:[]}]));effect.dispatchType=type;effect.dispatchTypes=[type];
 return {effect,conversion:castInfo(definitions,{...node,value:'fromInt'},effect)};
}
function castInfo(definitions,node,effect){
 const method=definitions.methods.get(node.value),c=definitions.classes.get(method.className),values=(effect.dispatchTypes||[effect.dispatchType]).map(prune);
 const bindings=new Map(classParameters(c).map((p,i)=>[p,values[i]]));
 const args=c.intoClass?values:c.conversion.map(t=>syntaxType(t,bindings));
 for(let i=0;i<args.length;i++){let t=prune(args[i]);if(t.numericLiterals){unify(t,INT,node);t=prune(t);}args[i]=t;if(['var','rigid'].includes(t.tag))throw new StaticTypeError('Ambiguous conversion: '+node.value+'; add a type annotation for source and result',node);}
 const instance=lookupInstance(definitions.classes.get('into'),args),target=instance?.implementations.get('from');
 if(!target&&!builtinConversion(args))throw new StaticTypeError('No instance: into '+args.map(formatType).join(' '),node);
 return {target:target||node.value,destination:args[1].name,types:args};
}
function executionTypes(base,definitions) {
  const hostTypes=new WeakMap();
  const activate=()=>{activeClasses=base.classes;activeEffects=base.effects;activeFamilies=effectFamilies(activeEffects);};
  function fresh() {
    activate();const inf=new Inference();
    Object.assign(inf,{functions:base.functions,globals:base.globals,constructors:base.constructors,dataTypes:base.dataTypes,effects:base.effects,trace:new Map(),quotations:new Map(),hostTypes});return inf;
  }
  function target(node,effect) {
    activate();const method=definitions.methods.get(node.value);if(method.specialCast)return castInfo(definitions,node,effect).target;let type=prune(effect?.dispatchType||variable());if(type.numericLiterals){unify(type,INT,node);type=prune(type);}
    if(type.tag==='var'||type.tag==='rigid')throw new StaticTypeError(`Ambiguous class method: ${node.value}; add a type annotation to determine ${method.className}`,node);
    const args=(effect.dispatchTypes||[type]).map(t=>{t=prune(t);if(t.numericLiterals){unify(t,INT,node);t=prune(t);}if(['var','rigid'].includes(t.tag))throw new StaticTypeError('Ambiguous class method: '+node.value+'; add a type annotation',node);return t;}),result=lookupInstance(definitions.classes.get(method.className),args)?.implementations.get(node.value);
    if(!result && (method.specialShow||method.specialIndex||method.specialCast||method.specialBits))return node.value;
    if(!result && operatorFallback(definitions.classes.get(method.className),type))return node.value;
    if(!result)throw new StaticTypeError(`No instance: ${method.className} ${formatType(type)}`,node);
    return result;
  }
  const clauses=new WeakMap();
  function clause(c,effect) {
    const key=formatType(effect);if(clauses.get(c)?.has(key))return clauses.get(c).get(key);
    const inf=fresh(),env=new Map(base.globals),args=[];
    effect=instantiate(generalize(effect));let input=effect.input;
    for(let i=0;i<c.patterns.length;i++){let arg;[input,arg]=inf.pop(input,c.token);args.unshift(arg);}
    env.locals=new Set(patternNames(c.patterns));c.patterns.forEach((p,i)=>inf.pattern(p,args[i],env));
    if(c.guard){input=inf.sequence(c.guard,input,new Map(env));let flag;[input,flag]=inf.pop(input,c.token);unify(flag,BOOL,c.token);}
    const output=inf.sequence(c.body,input,env);unify(output,effect.output,c.token);specializeEffects(inf.effectSink,effect.effects,c.token);
    inf.trace.enclosingType=effect;
    if(!clauses.has(c))clauses.set(c,new Map());clauses.get(c).set(key,inf.trace);
    return inf.trace;
  }
  function observe(values,input) {
    let row=prune(input);
    for(let i=values.length-1;i>=0&&row.tag==='push';i--,row=prune(row.rest)) {
      const value=values[i];if(value?.native||value?.kind==='continuation')hostTypes.set(value,row.item);
    }
  }
  function argumentsPlan(values,input,token) {
    const inf=fresh();
    const actual=stack(EMPTY,...values.map(v=>v?.native||v?.kind==='continuation'?variable():inf.value(v,token)));
    unify(actual,input,token);return inf.quotations;
  }
  function local(value,effect) {
    const inf=fresh(),type=inf.value(value);unify(type,effect);return inf.trace;
  }
  function runtimeCall(node,values) {
    const inf=fresh(),effect=instantiate(inf.functions.get(node.value));
    const input=stack(EMPTY,...values.map(v=>v?.native||v?.kind==='continuation'?variable():inf.value(v,node)));
    unify(input,effect.input,node);return {input,effect};
  }
  function validate(nodes,trace,seen=new Set()) {
    for(const node of nodes) {
      const info=trace?.get(node);if(!info)continue;
      if(node.kind==='quote'||node.kind==='local-function')continue;
      let name=node.value,callEffect=info.effect;
      if(node.kind==='literal'&&typeof node.value==='number'&&node.numericKind!=='float'&&Number.isInteger(node.value)){const literal=integerLiteralInfo(definitions,node,prune(info.output).item);if(literal.conversion){name=literal.conversion.target;callEffect=literal.effect;}}
      if(definitions.methods?.has(name)&&info.effect?.dispatchType)name=target(node,info.effect);
      if(definitions.has(name)&&callEffect) {
        const key=name+':'+formatType(callEffect);if(seen.has(key))continue;seen.add(key);
        for(const c of definitions.get(name))validate([...(c.guard||[]),...c.body],clause(c,callEffect),seen);
      }
      for(const value of Object.values(node)) {
        if(Array.isArray(value))for(const item of value)if(item&&typeof item==='object') {
          if(trace.has(item))validate([item],trace,seen);
          else for(const child of ['body','guard'])if(Array.isArray(item[child]))validate(item[child],trace,seen);
        }
      }
    }
  }
  return {trace:base.trace,castInfo:(node,effect)=>{activate();return castInfo(definitions,node,effect);},target,clause,argumentsPlan,local,runtimeCall,validate,observe};
}
export function inferExpression(nodes,definitions=new Map(),globals=new Map(),initialized=false) {
  const inference=prepare(definitions,globals,initialized),input=row();
  const env=new Map(inference.globals);inference.rootEnv=env;
  env.locals=new Set(env.keys());
  inference.trace=new Map();const output=inference.sequence(nodes,input,env);
  for(const [node,info] of inference.trace)if(node.kind==='literal'&&typeof node.value==='number'&&node.numericKind!=='float'){const type=prune(info.output).item;if(prune(type).tag==='var'&&prune(type).numericLiterals)unify(type,INT,node);}
  return formatType(quote(input,output,inference.effectSink));
}

// Compiler-only access to solved effects. Source checking remains identical.
export function loweringTypes(definitions) {
  const base=prepare(definitions,new Map());
  function analyze(nodes,input,env,blockLabel=null) {
    activeClasses=base.classes;activeEffects=base.effects;activeFamilies=effectFamilies(activeEffects);
    const inference=new Inference();
    inference.functions=base.functions;inference.globals=base.globals;inference.constructors=base.constructors;inference.dataTypes=base.dataTypes;
    inference.effects=base.effects;inference.trace=new Map();
    const type=blockLabel?inference.labeledBlock(nodes,input,env,blockLabel,nodes[0]):null;
    const output=type?type.output:inference.sequence(nodes,input,env);
    return {output,effects:type?type.effects:inference.effectSink,trace:inference.trace,env};
  }
  const execution=executionTypes(base,definitions);
  return {clause:execution.clause,trace:execution.trace,validate:execution.validate,globals:base.globals,functions:base.functions,analyze,pattern:(p,t,e)=>base.pattern(p,t,e)};
}

// Source-positioned instantiated function types for editor hovers. Reuse the
// checked clause analysis so surrounding arguments and results constrain calls.
export function occurrenceTypes(definitions,file) {
  const info=loweringTypes(definitions),result=new Map();
  result.substitutions=new Map();
  const collect=trace=>{
    const escaping=trace.enclosingType?free(trace.enclosingType,new Set(),new Set(),true):new Set();
    // Default only literals local to the body; inputs/outputs of the enclosing
    // polymorphic function must stay polymorphic in occurrence displays.
    for(const t of trace.values())for(const effect of [t.effect,...t.operatorEffects||[]])if(effect)
      for(const v of free(effect))if(v.numericLiterals&&!v.polymorphicNumber&&!escaping.has(v))unify(v,INT);
    for(const [node,t] of trace){
      const save=(token,effect)=>{
        if(effect&&token.file===file){
          const key=`${token.line}:${token.col}`,actual=instantiate(generalize(effect),false,null,false);
          const actualNames=new Map();result.set(key,formatType(actual,{names:actualNames,defaultNumbers:false}));
          const scheme=info.functions.get(token.value);
          if(scheme){
            const originalNames=new Map(),bindings=new Map();
            formatType(scheme.type,{names:originalNames});
            const generic=instantiate(scheme,false,bindings);
            try{
              unify(generic,actual,token);
              const substitutions=[];
              for(const [variable,name] of originalNames){
                const replacement=bindings.get(variable);if(!replacement)continue;
                const type=formatType(prune(replacement),{variableNames:actualNames,showConstraints:false,defaultNumbers:false});
                if(type!==name)substitutions.push({variable:name,type});
              }
              result.substitutions.set(key,substitutions);
            }catch{} // Keep the occurrence type if no matching scheme is available.
          }
        }
      };
      save(node,t.effect);
      if(node.kind==='comparison-chain')node.operators.forEach((op,i)=>save(op,t.operatorEffects?.[i]));
      else if(t.operatorEffects?.length)save(node,t.operatorEffects[0]);
    }
  };
  collect(info.trace||new Map());
  for(const [name,clauses] of definitions){
    if(!clauses.some(c=>c.token?.file===file))continue;
    const scheme=info.functions.get(name);if(!scheme)continue;
    for(const c of clauses)if(c.token?.file===file)collect(info.clause(c,instantiate(scheme)));
  }
  return result;
}
export const typeIR={integerLiteralInfo,castInfo,numericName:t=>{if(!t)return null;t=prune(t);return t.tag==='atom'?t.name:t.numericLiterals?'int':null;},specializeEffects,effectSnapshot:row=>effects(effectView(row).entries.map(e=>({...e,args:[...e.args]}))),iterableItem:type=>{const item=variable();requireIterable(type,item);return prune(item);},prune,clone,free,unify,instantiate,mono,generalize,quote,stack,EMPTY,BOTTOM,isBottom,checkNeverPromises,row,variable};
