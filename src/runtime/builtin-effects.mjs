// Operations are globally named; effect rows name their containing family.
export const worklistOperations = {push:'__worklistPush',pop:'__worklistPop',peek:'__worklistPeek'};
const item = {tag:'param',name:"'a"};
const optionalItem = {tag:'adt',name:'option',args:[item]};
const worklistEffects = Object.entries(worklistOperations).map(([member,name])=>{
  const input = member === 'push' ? [item] : [];
  const output = member === 'push' ? [] : [optionalItem];
  return [name,{name,qualifiedName:'std.worklist.'+member,parameters:["'a"],group:'worklist',grouped:true,builtin:true,never:false,
    syntax:{tag:'quote',input,output},inputCount:input.length,outputCount:output.length}];
});

export function ioEffects(existing=new Map()) {
  const base={parameters:[],group:'io',grouped:true,builtin:true,never:false};
  return new Map([
    ['borrowMut',{name:'borrowMut',parameters:["'r"],builtin:true,protected:true,never:false,syntax:{tag:'quote',input:[],output:[]},inputCount:0,outputCount:0}],
    ['read',{...base,name:'read',syntax:{tag:'quote',input:[],output:[{tag:'atom',name:'string'}]},inputCount:0,outputCount:1}],
    ['put',{...base,name:'put',syntax:{tag:'quote',input:[{tag:'atom',name:'string'}],output:[]},inputCount:1,outputCount:0}],
    ['exn',{name:'exn',parameters:[],builtin:true,never:true,syntax:{tag:'quote',input:[{tag:'atom',name:'string'}],output:[],never:true},inputCount:1,outputCount:0}],
    ['yield',{name:'yield',parameters:["'a"],builtin:true,never:false,syntax:{tag:'quote',input:[{tag:'param',name:"'a"}],output:[]},inputCount:1,outputCount:0}],
    ['break',{name:'break',parameters:["'s"],rowParameters:["'s"],builtin:true,never:true,syntax:{tag:'quote',input:[{tag:'stack-row',name:"'s"}],output:[],never:true},inputCount:0,outputCount:0}],
    ['cancel',{name:'cancel',parameters:[],builtin:true,never:true,syntax:{tag:'quote',input:[],output:[],never:true},inputCount:0,outputCount:0}],
    ...worklistEffects,
    ...existing
  ]);
}
export function effectFamilies(operations) {
  const groups=new Map();
  for(const op of operations.values()){
    const name=op.group||op.name;
    if(!groups.has(name))groups.set(name,{name,parameters:op.parameters||[],rowParameters:op.rowParameters||[],grouped:!!op.grouped,operations:[]});
    groups.get(name).operations.push(op);
  }
  return groups;
}
