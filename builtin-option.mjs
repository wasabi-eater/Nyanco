import {withResult} from './builtin-results.mjs';
export function withOption(definitions,{skipOption=false,skipResult=false}={}){const result=skipOption?definitions:optionDefinitions(definitions);return skipResult?result:withResult(result);}
// Standard option ADT; existing explicit declarations retain their identity.
function optionDefinitions(definitions) {
  if(definitions.dataTypes?.has('option') || definitions.constructors?.has('Some') || definitions.constructors?.has('None'))return definitions;
  const result=Object.assign(new Map(definitions),definitions);
  result.dataTypes=new Map(definitions.dataTypes);
  result.constructors=new Map(definitions.constructors);
  const parameters=["'a"],token={file:'<builtin>',line:1,col:1};
  result.dataTypes.set('option',{name:'option',parameters,token,postfix:false,builtin:true});
  for(const [name,fields] of [['None',[]],['Some',[{tag:'param',name:"'a"}]]])
    result.constructors.set(name,{name,typeName:'option',parameters,fields,token});
  return result;
}
export function isStandardOption(definitions) {
  const d=definitions.dataTypes?.get('option'),some=definitions.constructors?.get('Some'),none=definitions.constructors?.get('None');
  return d?.parameters.length===1 && some?.typeName==='option' && none?.typeName==='option' && none.fields.length===0 && some.fields.length===1 && some.fields[0].tag==='param' && some.fields[0].name===d.parameters[0];
}
