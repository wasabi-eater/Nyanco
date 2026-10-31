// Standard operator classes are available even without declarations or instances.
// Primitive fallbacks preserve the language's existing operator semantics.
export const operatorSpecs=new Map([
  ...['+','-','*','/','%','^'].map(op=>[op,{result:"'a",accept:t=>t.tag==='atom' && ['int','float','byte'].includes(t.name),primitive:'num'}]),
  ...['<','<=','>','>='].map(op=>[op,{result:'bool',accept:t=>t.tag==='atom' && ['int','float','byte','char'].includes(t.name),primitive:'num'}]),
  ...['==','/='].map(op=>[op,{result:'bool',accept:()=>true,universal:true}]),
  ...['.&.','.|.','xor'].map(op=>[op,{result:"'a",accept:t=>t.tag==='atom'&&['bool','int','byte'].includes(t.name)}]),
  ...['.<<.','.>>.'].map(op=>[op,{result:"'a",right:'int',exn:true,accept:t=>t.tag==='atom'&&['int','byte'].includes(t.name)}]),
  ['||',{result:"'a",accept:t=>t.tag==='atom'&&t.name==='bool'}],
  ['++',{result:"'a",accept:t=>t.tag==='list'||t.tag==='atom'&&t.name==='string'}],
]);
export const standardOperatorClasses=new Map([
  ['add',['+']],['sub',['-']],['mul',['*']],['div',['/']],['mod',['%']],['pow',['^']],
  ['eq',['==','/=']],['ord',['<','<=','>','>=']],['and',['.&.']],['or',['.|.']],['xor',['xor']],['shl',['.<<.']],['shr',['.>>.']],['append',['++']],
]);
export const operatorFallback=(c,t)=>c.operatorClass && [...c.methods.keys()].filter(op=>operatorSpecs.has(op)).every(op=>operatorSpecs.get(op).accept(t));
export const runtimeTypeKey=v=>Array.isArray(v)?'vector':v?.kind==='range'?'range':v?.kind==='scalar'?v.type:typeof v==='number'?'int':typeof v==='boolean'?'bool':typeof v==='string'?'string':v?.kind==='adt'?v.typeName:null;
export function builtinInstance(c,t) {
  if(!c)return false;
  const numeric=t.tag==='atom'&&['int','float','byte'].includes(t.name);
  return !!(c.showClass||c.bitClass&&t.tag==='atom'&&['int','byte'].includes(t.name)||operatorFallback(c,t)||c.castClass&&['int','float','byte','char'].includes(t.name)||c.numClass&&numeric||c.indexClass&&(t.tag==='list'||t.tag==='atom'&&t.name==='string')||c.name==='streem'&&(t.tag==='list'||t.tag==='stream'||t.tag==='atom'&&t.name==='range'));
}
export function primitiveOperatorClass(name,ops,token) {
  const param="'a",methods=new Map(ops.map(op=>[op,{name:op,className:name,param,signature:`'a ${operatorSpecs.get(op).right||"'a"} -> ${operatorSpecs.get(op).result}${operatorSpecs.get(op).exn?' / {exn}':''}`,token,inputCount:2,dispatchIndex:0,...(op==='xor'?{specialBits:true}:{})}]));
  return {name,param,methods,instances:new Map(),token,operatorClass:true};
}

export function installOperatorClasses(classes,methods) {
  for(const [name,ops] of standardOperatorClasses) {
    if(classes.has(name))continue;
    const c=primitiveOperatorClass(name,ops);c.standard=true;
    classes.set(name,c);for(const [op,m] of c.methods)if(!methods.has(op))methods.set(op,m);
  }
  if(!classes.has('bits')){
    const methodsForBits=new Map(['testBit','setBit','clearBit'].map(name=>[name,{name,className:'bits',param:"'a",signature:`'a int -> ${name==='testBit'?'bool':"'a"} / {exn}`,specialBits:true}]));
    classes.set('bits',{name:'bits',param:"'a",methods:methodsForBits,instances:new Map(),standard:true,bitClass:true});for(const [name,m] of methodsForBits)methods.set(name,m);
  }
  if(!classes.has('into')){
    const m={name:'from',className:'into',param:"'a",params:["'a","'b"],signature:"'a -> 'b / {exn}",specialCast:true,specialInto:true};
    classes.set('into',{name:'into',param:"'a",params:["'a","'b"],methods:new Map([['from',m]]),instances:new Map(),associated:[],standard:true,intoClass:true});methods.set('from',m);
  }
  for(const direction of ['to','from'])for(const type of ['int','float','byte','char']){
    const name=direction+type[0].toUpperCase()+type.slice(1);if(classes.has(name))continue;
    const source=direction==='to'?{tag:'param',name:"'a"}:{tag:'atom',name:type},target=direction==='to'?{tag:'atom',name:type}:{tag:'param',name:"'a"};
    const m={name,className:name,param:"'a",signature:direction==='to'?`'a -> ${type} / {exn}`:`${type} -> 'a / {exn}`,specialCast:true};
    classes.set(name,{name,param:"'a",methods:new Map([[name,m]]),instances:new Map(),standard:true,castClass:true,conversion:[source,target],supers:['into'],superConstraints:[{name:'into',args:[source,target]}]});if(!methods.has(name))methods.set(name,m);
  }
  if(!classes.has('num'))classes.set('num',{name:'num',param:"'a",methods:new Map(),instances:new Map(),associated:[],standard:true,numClass:true,supers:['add','sub','mul','div','mod','pow','toInt','toFloat','toByte','toChar','fromInt','fromFloat','fromByte']});
  for(const [name,method] of [['indexGet','at'],['indexSet','setAt']])if(!classes.has(name)){
    const associated=[{name:'key',owner:name,param:"'indexKey"},{name:'item',owner:name,param:"'indexItem"}],param="'c";
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
