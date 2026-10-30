// Historical grammar fixtures feed legacy ASTs into the CURRENT type checker,
// interpreter, and Go backend. Prefix parser and migration tests run separately.
import {migrateNodes} from './v048.mjs';
import * as current from '../language.mjs';
import * as types from '../types.mjs';
import {signatureText,marker} from './v037.mjs';
import * as old from './v037/language.mjs';
export {LanguageError,StaticTypeError,format,builtinNames,lex} from '../language.mjs';
const histories=new WeakMap();
const defaults=['add','sub','mul','div','mod','pow','eq','ord','and','or','append','each','handles'];
export function legacyType(text,definitions=new Map()){
  const classes=new Set([...defaults,...definitions.classes?.keys()||[]]);
  let out=text.replace(/\bstreem\b/g,"each");
  const pos=out.indexOf('=>');
  if(pos>=0)out=out.slice(0,pos).split(',').map(x=>{const parts=x.trim().split(/\s+/);return classes.has(parts[0])?[...parts.slice(1),parts[0]].join(' '):x.trim()}).join(', ')+' =>'+out.slice(pos+2);
  out=out.replace(/\/ \{([^{}]*)\}/g,(_,body)=>'/ {'+body.split(',').map(x=>{const words=x.trim().split(/\s+/);return definitions.effects?.has(words[0])?[...words.slice(1),words[0]].join(' '):x.trim()}).join(', ')+'}');
  for(const name of definitions.dataTypes?.keys()||[])out=out.replace(new RegExp('\\('+name+" ([^()]*)\\)",'g'),(_,args)=>'('+args+' '+name+')');
  return out;
}
function compileLegacy(source,file,previous=new Map(),options={}){
  if((source.trimStart().startsWith(marker)||source.trimStart().startsWith('-- HaskStack 0.38 prefix')))return current.compile(source,file,previous,options);
  const legacy=old.compile(source,file,histories.get(previous)||new Map(),{...options,checkTypes:false});
  const snapshot=structuredClone({entries:[...legacy.definitions],props:{...legacy.definitions}}),definitions=Object.assign(new Map(snapshot.entries),snapshot.props),dataTypes=legacy.definitions.dataTypes;
  if(definitions.classes.has('each')){const c=definitions.classes.get('each');definitions.classes.delete('each');c.name='streem';definitions.classes.set('streem',c);}
  for(const c of definitions.classes.values())for(const inst of c.instances.values())for(const context of inst.context||[])if(context[0]==='each')context[0]='streem';
  for(const m of definitions.methods.values())if(m.className==='each')m.className='streem';
  const convert=s=>{try{return signatureText(s,dataTypes).replace(/\beach\b/g,'streem');}catch(error){throw new current.StaticTypeError(error.message);}};
  for(const clauses of definitions.values())if(typeof clauses.signature==='string')clauses.signature=convert(clauses.signature);
  for(const method of definitions.methods.values())if(method.signature)method.signature=convert(method.signature);
  for(const declaration of definitions.dataTypes.values())declaration.postfix=false;
  for(const c of definitions.classes.values())if(c.instances.has('list')){c.instances.set('vector',c.instances.get('list'));c.instances.delete('list');}
  migrateNodes(definitions);migrateNodes(definitions.initializers);
  histories.set(definitions,legacy.definitions);
  const inferred=options.checkTypes===false?new Map():types.checkDefinitions(definitions,options.globals);
  return {...legacy,definitions,types:new Map([...inferred].map(([n,t])=>[n,legacyType(t,definitions)]))};
}
export function parseExpression(source,file,constructors){try{return migrateNodes(old.parseExpression(source,file,constructors));}catch(error){if(error instanceof old.LanguageError)Object.setPrototypeOf(error,current.LanguageError.prototype);throw error;}}
export class VM extends current.VM {
  evaluate(source,stack=[],file='<eval>'){return this.execute(parseExpression(source,file,this.definitions.constructors),stack);}
  infer(source,file='<type>'){return legacyType(types.inferExpression(parseExpression(source,file,this.definitions.constructors),this.definitions,this.globals,this.initialized===this.definitions),this.definitions);}
}

export function compile(...args){try{return compileLegacy(...args);}catch(error){if(error instanceof old.LanguageError)Object.setPrototypeOf(error,current.LanguageError.prototype);throw error;}}
