import {typeIR} from './types.mjs';

export const T={...typeIR,prune:t=>{let next=typeIR.prune(t);while(true){const rep=typeIR.aliasRepresentation(next);if(rep===next)return next;next=typeIR.prune(rep);}}};
T.numericName=t=>typeIR.numericName(T.prune(t));
export const tuple=items=>items.never?T.BOTTOM:T.stack(T.EMPTY,...items);
export const neverValues=()=>Object.assign([],{never:true});
export class StoppedEmission {}
export function items(row) {
  const result=[];row=T.prune(row);if(T.isBottom(row))return neverValues();
  while(row.tag==='push'){result.unshift(row.item);row=T.prune(row.rest);}
  if(row.tag==='var')T.unify(row,T.EMPTY);
  else if(row.tag!=='empty')throw new Error('Unresolved native function arity');
  return result;
}
export function effectParts(effect) {
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
export function copyEnv(env) {
  const vars=new Set();for(const s of env.values())for(const v of T.free(s.type))vars.add(v);
  const replacements=new Map([...vars].map(v=>[v,{...T.variable(v.sort),...(v.numericLiterals?{numericLiterals:[...v.numericLiterals]}:{}),...(v.polymorphicNumber?{polymorphicNumber:true}:{}),...(v.numericPattern?{numericPattern:true}:{}),...(v.keepNativePrefix?{keepNativePrefix:true}:{}),...(v.lacks?{lacks:new Set(v.lacks)}:{}),...(v.classes?{classes:new Set(v.classes)}:{})}]));
  for(const [v,fresh] of replacements){if(v.relations)fresh.relations=v.relations.map(r=>({...r,args:r.args.map(t=>T.clone(t,replacements))}));if(v.associated)fresh.associated=new Map([...v.associated].map(([n,ts])=>[n,ts.map(t=>T.clone(t,replacements))]));if(v.eachItem)fresh.eachItem=T.clone(v.eachItem,replacements);if(v.eachEffects)fresh.eachEffects=T.clone(v.eachEffects,replacements);if(v.handlerAnswer)fresh.handlerAnswer=T.clone(v.handlerAnswer,replacements);}
  return new Map([...env].map(([name,s])=>[name,{...s,type:T.clone(s.type,replacements),vars:new Set([...s.vars].map(v=>replacements.get(v)||v))}]));
}
export function freshTypes(input,output,latent) {
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
