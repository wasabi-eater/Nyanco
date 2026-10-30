// Standard operator classes are available even without declarations or instances.
// Primitive fallbacks preserve the language's existing operator semantics.
export const operatorSpecs=new Map([
  ...['+','-','*','/','%','^'].map(op=>[op,{result:"'a",accept:t=>t.tag==='atom' && ['int','float','byte'].includes(t.name),primitive:'num'}]),
  ...['<','<=','>','>='].map(op=>[op,{result:'bool',accept:t=>t.tag==='atom' && ['int','float','byte','char'].includes(t.name),primitive:'num'}]),
  ...['==','/='].map(op=>[op,{result:'bool',accept:()=>true,universal:true}]),
  ...['and','or'].map(op=>[op,{result:"'a",accept:t=>t.tag==='atom' && t.name==='bool',primitive:'bool'}]),
  ['++',{result:"'a",accept:t=>t.tag==='list'||t.tag==='atom'&&t.name==='string'}],
]);
export const standardOperatorClasses=new Map([
  ['num',['+','-','*','/','%','^']],['add',['+']],['sub',['-']],['mul',['*']],['div',['/']],['mod',['%']],['pow',['^']],
  ['eq',['==','/=']],['ord',['<','<=','>','>=']],['and',['and']],['or',['or']],['append',['++']],
]);
export const operatorFallback=(c,t)=>c.operatorClass && [...c.methods.keys()].every(op=>operatorSpecs.get(op).accept(t));
export const runtimeTypeKey=v=>Array.isArray(v)?'vector':v?.kind==='range'?'range':v?.kind==='scalar'?v.type:typeof v==='number'?'int':typeof v==='boolean'?'bool':typeof v==='string'?'string':v?.kind==='adt'?v.typeName:null;
export function primitiveOperatorClass(name,ops,token) {
  const param="'a",methods=new Map(ops.map(op=>[op,{name:op,className:name,param,signature:`'a 'a -> ${operatorSpecs.get(op).result}`,token,inputCount:2,dispatchIndex:0}]));
  return {name,param,methods,instances:new Map(),token,operatorClass:true};
}

export function installOperatorClasses(classes,methods) {
  for(const [name,ops] of standardOperatorClasses) {
    if(classes.has(name))continue;
    if(ops.some(op=>methods.has(op)) && name!=='num')continue;
    const c=primitiveOperatorClass(name,ops);c.standard=true;
    classes.set(name,c);for(const [op,m] of c.methods)if(!methods.has(op))methods.set(op,m);
  }
  for(const [name,method] of [['indexGet','at'],['indexSet','setAt']])if(!classes.has(name)){
    const associated=[{name:'key',param:"'indexKey"},{name:'item',param:"'indexItem"}],param="'c";
    const m={name:method,className:name,param,signature:method==='at'?"'c 'indexKey -> 'indexItem / {exn}":"'c 'indexKey 'indexItem -> 'c / {exn}",inputCount:method==='at'?2:3,dispatchIndex:0,specialIndex:true};
    classes.set(name,{name,param,associated,methods:new Map([[method,m]]),instances:new Map(),standard:true,indexClass:true});methods.set(method,m);
  }
  if(!classes.has('show') && !methods.has('show')) {
    const m={name:'show',className:'show',param:"'a",signature:"'a -> string",inputCount:1,dispatchIndex:0,specialShow:true};
    classes.set('show',{name:'show',param:"'a",methods:new Map([['show',m]]),instances:new Map(),standard:true,showClass:true});methods.set('show',m);
  }
  if(!classes.has('streem')) {
    const m={name:'each',className:'streem',param:"'c",specialEach:true,inputCount:2,dispatchIndex:0};
    classes.set('streem',{name:'streem',param:"'c",methods:new Map([['each',m]]),instances:new Map(),standard:true});methods.set('each',m);
  }
  return {classes,methods};
}
