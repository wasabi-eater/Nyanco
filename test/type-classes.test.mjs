import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {compile,VM,format} from '../migration/v037-adapter.mjs';
const source=`class 'a describe where
  describe : 'a -> string
instance describe int where
  n describe = n show
instance describe bool where
  True describe = "yes"
  False describe = "no"
render = describe`;

test('classes infer constraints and dispatch multiple instances',()=>{
  const p=compile(source),vm=new VM(p);
  assert.deepEqual(vm.evaluate('3 render; True render; False describe'),['3','yes','no']);
  assert.equal(vm.infer('render'),"'a describe => ..s 'a -> ..s string");
  assert.match(p.types.get('describe'),/describe/);
  assert.ok([...p.types.keys()].every(n=>!n.startsWith('__tc_')));
  assert.throws(()=>vm.evaluate('"unsupported" render'),/No instance: describe string/);
});

test('constraints propagate through quotes, records, local functions and map',()=>{
  const vm=new VM(compile(source+`\nrenderAll = {describe} map
wrapped = {q: {describe}}
main =
  local = describe
  1 local; True local
  [1 2] renderAll
  False wrapped.q call`));
  assert.deepEqual(vm.evaluate('main'),['1','yes',['1','2'],'no']);
  assert.match(vm.infer('renderAll'),/each,.*describe =>.*\[string\]/);
  assert.throws(()=>vm.evaluate('["x"] renderAll'),/No instance/);
});

test('explicit constraints are checked rather than silently discarded',()=>{
  const vm=new VM(compile(source+`\nrender2 : 'a describe => 'a -> string
render2 = describe`));
  assert.deepEqual(vm.evaluate('7 render2'),['7']);
  assert.throws(()=>compile(source+"\nbad : 'a -> string\nbad = describe"),/Missing constraint/);
  assert.throws(()=>compile(source+"\nbad : Missing 'a => 'a -> string\nbad = describe"),/Unknown class/);
  assert.throws(()=>compile(source+"\nbad : 'b describe => 'a -> string\nbad = describe"),/Constraint must name/);
});

test('nominal ADTs and multi-input methods support patterns and guards',()=>{
  const vm=new VM(compile(`data color = Red | Blue
class 'a same where
  same : 'a 'a -> bool
  label : 'a -> string
instance same color where
  Red Red same = True
  Blue Blue same = True
  _ _ same = False
  Red label = "red"
  Blue label = "blue"
class 'a magnitude where
  magnitude : 'a -> int
instance magnitude int where
  n magnitude | n < 0 = 0 - n
              | otherwise = n
main = Red Blue same; Red Red same; Blue label; -3 magnitude`));
  assert.deepEqual(vm.evaluate('main'),[false,true,'blue',3]);
});

test('class and instance declarations reject incomplete, duplicate and invalid implementations',()=>{
  const base="class 'a c where\n  f : 'a -> int\n";
  for(const [suffix,pattern] of [
    ['instance c int where\n  g = 1',/must define a method/],
    ['instance c int where',/Missing instance method/],
    ['instance c int where\n  f = drop True',/Cannot unify/],
    ['instance c int where\n  f = drop 1\ninstance c int where\n  f = drop 2',/Duplicate instance/],
    ['instance Unknown int where\n  f = drop 1',/Unknown class/],
    ['f = 1',/Cannot redefine class method/],
  ])assert.throws(()=>compile(base+suffix),pattern);
  assert.doesNotThrow(()=>compile("class 'a c where\n  f : -> 'a"));
  assert.throws(()=>compile("class 'a c where\n  print : 'a -> int"),/already used/);
  assert.throws(()=>compile(base+"class 'a d where\n  f : 'a -> int"),/already used/);
});

test('multiple class constraints on one value are retained',()=>{
  const vm=new VM(compile(source+`\nclass 'a count where
  count : 'a -> int
instance count int where
  count = nop
both = dup describe; swap count`));
  assert.deepEqual(vm.evaluate('3 both'),['3',3]);
  assert.match(vm.infer('both'),/'a count, 'a describe =>/);
  assert.throws(()=>vm.evaluate('True both'),/No instance: count bool/);
});

test('REPL can add instances after class definitions without changing older programs',()=>{
  const initial=compile("class 'a c where\n  f : 'a -> string\nuse = f");
  const extended=compile('instance c int where\n  f = show','<repl>',initial.definitions);
  assert.deepEqual(new VM(extended).evaluate('3 use'),['3']);
  assert.equal(initial.definitions.classes.get('c').instances.size,0);
  assert.throws(()=>new VM(initial).evaluate('3 use'),/No instance/);
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('../migration/v037-cli.mjs',import.meta.url))],{
    input:":{\nclass 'a c where\n  f : 'a -> string\n:}\n:{\ninstance c int where\n  f = show\n:}\n3 f\n:words\n:q\n",encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,result.stderr);assert.doesNotMatch(result.stdout,/Error:|__tc_/);assert.match(result.stdout,/\["3"\]/);
});

test('REPL infers add for f = + without prior class declarations',()=>{
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('../migration/v037-cli.mjs',import.meta.url))],{
    input:'f = +\n:type f\n2 3 f\n:q\n',encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,result.stderr);
  assert.doesNotMatch(result.stdout,/Error:/);
  assert.match(result.stdout,/'a add => \.\.s 'a 'a -> \.\.s 'a/);
  assert.match(result.stdout,/\[5\]/);
});
