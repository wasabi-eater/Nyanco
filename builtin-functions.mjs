import {installUnwrap,installOrElse} from './builtin-results.mjs';
import {installOperatorClasses} from './operator-classes.mjs';
import {parseExpression} from './language.mjs';
// Ordinary functions retain stack/effect polymorphism and use the same lowering.
export function withStandardFunctions(definitions){
 const result=Object.assign(new Map(definitions),definitions),token={file:'<standard>',line:1,col:1};
 const add=(name,parameters,body,signature)=>{if(result.has(name))return;
  const clauses=[{patterns:parameters.map(value=>({...token,kind:'word',value})),body:parseExpression(body,'<standard>',definitions.constructors),token:{...token,value:name}}];if(signature)clauses.signature=signature;result.set(name,clauses);
 };
 installUnwrap(result,add);
 if(!result.classes.has('or')){const classes=new Map(result.classes),methods=new Map(result.methods);installOperatorClasses(classes,methods);result.classes.set('or',classes.get('or'));result.methods.set('.|.',methods.get('.|.'));}
 installOrElse(result,add);
 add('loop',[],'while {True} _');
 // The outer loop also catches break during initialization. The inner loop
 // ends on break/cancel in cont; the final cancel prevents initialization restarting.
 add('iterate',['start','cont'],'fromYield {while {True} {call start; while {True} {yield $; call cont}; cancel}}');
 return result;
}
