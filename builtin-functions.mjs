import {installUnwrap} from './builtin-results.mjs';
import {parseExpression} from './language.mjs';
// Ordinary functions retain stack/effect polymorphism and use the same lowering.
export function withStandardFunctions(definitions){
 const result=Object.assign(new Map(definitions),definitions),token={file:'<standard>',line:1,col:1};
 const add=(name,parameters,body,signature)=>{if(result.has(name))return;
  const clauses=[{patterns:parameters.map(value=>({...token,kind:'word',value})),body:parseExpression(body,'<standard>',definitions.constructors),token:{...token,value:name}}];if(signature)clauses.signature=signature;result.set(name,clauses);
 };
 installUnwrap(result,add);
 add('loop',[],'while {True} _');
 // The outer loop also catches break during initialization. The inner loop
 // ends on break/cancel in cont; the final cancel prevents initialization restarting.
 add('iterate',['start','cont'],'fromYield {while {True} {call start; while {True} {yield $; call cont}; cancel}}');
 return result;
}
