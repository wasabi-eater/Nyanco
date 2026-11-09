import {readFileSync} from 'node:fs';
import {compile,builtinNames,lex,declarationGroups} from './language.mjs';
import {worklistOperations} from '../runtime/builtin-effects.mjs';

// Standard modules expose the native primitives through the same symbol shape
// used by directory modules. The prelude is a set of public reexports of them.
const groups=new Map();
const standard=new Map();
const put=(module,name,internal=name,kind='function')=>{
  const exports=groups.get(module)||new Map();groups.set(module,exports);
  const access=new Map(kind==='effect'?[['type','pub'],['value','pub']]:[[['data','type','class','effect-family'].includes(kind)?'type':'value','pub']]);
  const old=exports.get(name);
  exports.set(name,{name,internal,kind,kinds:new Set([...(old?.kinds||[]),kind]),access:new Map([...old?.access||[],...access]),visibility:'pub',token:{file:`<std.${module}>`,line:1,col:1,value:name}});
};
const add=(module,names,kind='function')=>names.split(/\s+/).filter(Boolean).forEach(name=>put(module,name,name,kind));
const aliases=(module,prefix,names)=>names.split(/\s+/).filter(Boolean).forEach(name=>{put(module,name,prefix+name);assigned.add(prefix+name);});

const definitions=compile('','<std-inventory>').definitions;
const assigned=new Set();
const assign=(module,names,kind='function')=>{add(module,names,kind);names.split(/\s+/).filter(Boolean).forEach(n=>assigned.add(n));};
assign('vector','vector Push cons head tail length reverse toVector sliceBetween sliceFrom sliceTo binarySearch binarySearchBy partitionPoint');
put('vector','isEmpty');put('vector','in');
assign('vector','vscan vreplicate');put('vector','scan','vscan');put('vector','replicate','vreplicate');
put('vector','push','vpush');assigned.add('push');assigned.add('vpush');
assign('deque','deque toDeque');
assign('heap','heap toHeap');
assign('worklist','withHeap withDeque');
put('worklist','worklist','worklist','effect-family');
for(const [name,internal] of Object.entries(worklistOperations))put('worklist',name,internal,'effect');
for(const [module,prefix,names] of [['deque','q','push pushFront pop popFront popBack peek peekBack length isEmpty'],['heap','h','push pop peek length isEmpty']])aliases(module,prefix,names);
aliases('vector','v','map filter flatMap flatten take takeWhile skip skipWhile zip');
assign('stream','each map filter flatMap flatten fold sum product count countIf orderedCounts zip zipWith unzip take takeWhile skip skipWhile max maxi maxiBy min mini miniBy all any nth sort sortBy windows chunks chunkBy groupBy permutations combinations combinationsWithReplacement cartesianProduct powerset fromYield repeat repeatWith toVector');
assign('set','set toSet sinsert sremove scontains slength sisEmpty sunion sintersection sdifference');
for(const name of ['insert','remove','contains','length','isEmpty','union','intersection','difference'])put('set',name,'s'+name);
assign('dict','dict toDict counts countsBy values groupBy');
assign('option','');
aliases('option','o','map filter flatMap flatten zip');
assign('result','');
aliases('result','r','map flatMap flatten zip');
assign('text','chars bytes vchars vbytes split join parseFloat parseInt toNum');
assign('numeric','range int float byte char toInt toFloat toByte toChar fromInt fromFloat fromByte fromChar from max min');
assign('bits','testBit setBit clearBit xor');
assign('io','read put print');
assign('control','if when while loop iterate handle resume call compose dip');
assign('stack','nop dup drop swap over rot');
assign('borrow','readRef writeRef');
assign('core','tryAt updateAt tryUpdateAt');
put('borrow','mutref','mutref','data');
for(const name of builtinNames())if(!assigned.has(name))put('core',name);
for(const name of definitions.keys())if(!name.startsWith('__')&&!assigned.has(name))put('core',name);
for(const name of ['vector','deque','heap','stream','dict','set','range','option','result','int','float','byte','char','bool','string'])
  put(({deque:'deque',heap:'heap',vector:'vector',stream:'stream',dict:'dict',set:'set',range:'numeric',option:'option',result:'result',string:'text'})[name]||'numeric',name,name,'data');
for(const name of definitions.classes.keys())put(({slice:'vector',streem:'stream',indexGet:'vector',indexSet:'vector',bits:'bits',num:'numeric',into:'numeric'})[name]||'classes',name,name,'class');
for(const [name,op] of definitions.effects)if(!op.qualifiedName)put(['read','put'].includes(name)?'io':'effects',name,name,'effect');
for(const name of definitions.constructors.keys())put(['None','Some'].includes(name)?'option':'result',name,name,'constructor');
for(const [name,method] of definitions.methods)if(method.collectionQuery||!groups.get('classes')?.has(name)&&!assigned.has(name))put('classes',name,name,'method');

// The prelude source is parsed here, so its pub imports are the source of truth
// for unqualified standard names in the module loader.
const prelude=new Map();
const preludeSource=readFileSync(new URL('../../std/prelude.nyan',import.meta.url),'utf8');
for(const group of declarationGroups(lex(preludeSource,'<std.prelude>'))){
  if(group[0]?.value!=='pub'||group[1]?.value!=='import'||typeof group[2]?.value!=='string')throw new Error('Invalid std.prelude import');
  const module=group[2].value.slice(4),exports=groups.get(module);
  if(!group[2].value.startsWith('std.')||!exports)throw new Error('Unknown std.prelude module: '+group[2].value);
  for(let i=4;i<group.length-1;){
    const source=group[i++]?.value;if(!source)break;
    const name=group[i]?.value==='as'?(i++,group[i++]?.value):source;
    const original=exports.get(source);if(!original||!name)throw new Error('Invalid std.prelude export: '+module+'.'+source);
    const old=prelude.get(name);
    if(old&&old.internal!==original.internal)throw new Error('Conflicting std.prelude export: '+name);
    prelude.set(name,old?{...old,kinds:new Set([...old.kinds,...original.kinds]),access:new Map([...old.access,...original.access])}:{...original,name,sourceModule:module});
    if(group[i]?.kind===',')i++;
  }
}
groups.set('prelude',prelude);

export const standardModuleNames=()=>[...groups.keys()].map(name=>'std.'+name);
export function standardModule(specifier){
  const name=specifier.replaceAll('\\','/').replaceAll('/','.').replace(/^std\./,'');
  if(!groups.has(name))return null;
  if(!standard.has(name)){
    const exports=groups.get(name),mod={id:'std.'+name,dir:'std.'+name,prefix:'',files:[],symbols:exports,exports,standard:true};
    for(const symbol of exports.values())symbol.module=mod;
    standard.set(name,mod);
  }
  return standard.get(name);
}
