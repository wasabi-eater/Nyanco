import {parseExpression} from './language.mjs';
// Ordinary functions retain stack/effect polymorphism and use the same lowering.
export function withStandardFunctions(definitions){
 if(definitions.has('loop')&&definitions.has('iterate'))return definitions;
 const result=Object.assign(new Map(definitions),definitions),token={file:'<standard>',line:1,col:1};
 const add=(name,parameters,body)=>{if(result.has(name))return;
  const clauses=[{patterns:parameters.map(value=>({...token,kind:'word',value})),body:parseExpression(body,'<standard>',definitions.constructors),token:{...token,value:name}}];result.set(name,clauses);
 };
 add('loop',[],'while {True} _');
 // The outer loop also catches break during initialization. The inner loop
 // ends on break in cont; the final break prevents initialization restarting.
 add('iterate',['start','cont'],'fromYield {while {True} {call start; while {True} {yield $; call cont}; cancel}}');
 return result;
}
