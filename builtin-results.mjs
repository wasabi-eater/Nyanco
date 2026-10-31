import {isStandardOption} from './builtin-option.mjs';
const parameter=name=>({tag:'param',name});
export function withResult(definitions){
 if(definitions.dataTypes?.has('result')||definitions.constructors?.has('Ok')||definitions.constructors?.has('Err'))return definitions;
 const result=Object.assign(new Map(definitions),definitions),parameters=["'a","'err"],token={file:'<standard>',line:1,col:1};
 result.dataTypes=new Map(definitions.dataTypes);result.constructors=new Map(definitions.constructors);
 result.dataTypes.set('result',{name:'result',parameters,token,postfix:false,builtin:true});
 for(const [name,type] of [['Ok',"'a"],['Err',"'err"]])result.constructors.set(name,{name,typeName:'result',parameters,fields:[parameter(type)],token});
 return result;
}
export function isStandardResult(definitions){
 const d=definitions.dataTypes?.get('result');return d?.parameters.length===2&&['Ok','Err'].every((name,i)=>{const c=definitions.constructors?.get(name);return c?.typeName==='result'&&c.fields.length===1&&c.fields[0].tag==='param'&&c.fields[0].name===d.parameters[i];});
}
export function installUnwrap(definitions,add){
 definitions.classes=new Map(definitions.classes);definitions.methods=new Map(definitions.methods);
 const token={file:'<standard>',line:1,col:1},signatures={unwrap:"'c -> 'associated_item / {exn}",unwrapOr:"'c 'associated_item -> 'associated_item",unwrapOrElse:"'c {-> 'associated_item / { | 'e}} -> 'associated_item / { | 'e}"};
 let c=definitions.classes.get('unwrap');
 if(!c){c={name:'unwrap',param:"'c",params:["'c"],associated:[{name:'item',param:"'associated_item",owner:'unwrap'}],supers:[],superConstraints:[],methods:new Map(),instances:new Map(),standard:true,token};
  for(const [name,signature] of Object.entries(signatures)){const m={name,className:'unwrap',param:"'c",params:["'c"],signature,token};c.methods.set(name,m);definitions.methods.set(name,m);}
 }else c={...c,instances:new Map(c.instances)};
 definitions.classes.set('unwrap',c);
 for(const type of ['option','result']){
  if(c.instances.has(type)||!(type==='option'?isStandardOption(definitions):isStandardResult(definitions)))continue;
  const isResult=type==='result',head={tag:'adt',name:type,args:[parameter("'a"),...(isResult?[parameter("'err")]:[])]};
  const context=isResult?[["show",parameter("'err")]]:[],instance={target:type,head,heads:[head],context,implementations:new Map(),associated:new Map([['item',parameter("'a")]]),signatures:new Map(),token};
  const success=isResult?'Ok x':'Some x',failure=isResult?'Err error':'None',container=isResult?"(result 'a 'err)":"(option 'a)";
  for(const method of Object.keys(signatures)){
   const name='__standard_'+type+'_'+method,params=method==='unwrap'?['value']:['value','fallback'];
   const fail=method==='unwrap'?(isResult?'exn (show error)':'exn "unwrap: None"'):method==='unwrapOr'?'fallback':'call fallback';
   const signature=(isResult?"show 'err => ":'')+signatures[method].replaceAll("'c",container).replaceAll("'associated_item","'a");
   add(name,params,`value; case\n  -> ${success} then x\n  -> ${failure} then ${fail}`,signature);
   instance.implementations.set(method,name);instance.signatures.set(name,signature);
  }
  c.instances.set(type,instance);
 }
 if(isStandardResult(definitions))add('catch',['block'],'handle {Ok (call block)} {exn: {-> message k; Err message}}');
}

export function installOrElse(definitions,add){
 const token={file:'<standard>',line:1,col:1};
 let c=definitions.classes.get('orElse');
 if(!c){c={name:'orElse',param:"'a",params:["'a"],associated:[],supers:[],methods:new Map(),instances:new Map(),standard:true,token};for(const [name,signature] of [['||',"'a 'a -> 'a"],['hasValue',"'a -> bool"]]){const m={name,className:'orElse',param:"'a",signature,token};c.methods.set(name,m);definitions.methods.set(name,m);}}
 else c={...c,instances:new Map(c.instances)};
 definitions.classes.set('orElse',c);
 for(const type of ['bool','option','result']){
  if(c.instances.has(type)||type==='option'&&!isStandardOption(definitions)||type==='result'&&!isStandardResult(definitions))continue;
  const head=type==='bool'?{tag:'atom',name:type}:{tag:'adt',name:type,args:[parameter("'a"),...(type==='result'?[parameter("'err")]:[])]};
  const instance={target:type,head,heads:[head],context:[],implementations:new Map(),associated:new Map(),signatures:new Map(),token};
  const has='__standard_'+type+'_hasValue',choose='__standard_'+type+'_orElse';
  const success=type==='option'?'Some x':'Ok x',failure=type==='option'?'None':'Err error';
  add(has,['value'],type==='bool'?'value':`value; case\n  -> ${success} then True\n  -> ${failure} then False`);
  add(choose,['left','right'],type==='bool'?'if left {True} {right}':`left; case\n  -> ${success} then left\n  -> ${failure} then right`);
  instance.implementations.set('||',choose);instance.implementations.set('hasValue',has);c.instances.set(type,instance);
  if(type!=='bool'){const strict=definitions.classes.get('or'),copy={...strict,instances:new Map(strict.instances)};copy.instances.set(type,{...instance,implementations:new Map([['.|.',choose]])});definitions.classes.set('or',copy);}
 }
}
