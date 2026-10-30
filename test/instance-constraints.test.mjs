import test from 'node:test';
import assert from 'node:assert/strict';
import {compile,VM} from '../migration/v037-adapter.mjs';
const base=`data 'a box = 'a Box
class 'a describe where
  describe : 'a -> string
instance int describe where
  describe = show
instance 'a describe => ('a box) describe where
  (x Box) describe = x describe
instance 'a describe => ['a] describe where
  describe = {describe} map show
render = describe`;

test('postfix instance contexts propagate through nested ADTs, lists and inferred functions',()=>{
  const p=compile(base+'\nboxed = Box describe'),vm=new VM(p);
  assert.match(p.types.get('boxed'),/'a describe =>/);
  assert.deepEqual(vm.evaluate('3 Box Box render; [1 Box 2 Box] render; 4 boxed'),['3','["1", "2"]','4']);
  for(const code of ['True Box render','[True Box] render','True boxed','{True Box render} call','[True] {Box render} map'])assert.throws(()=>vm.evaluate(code),/No instance: describe bool/);
});

test('instance assumptions are required even when the implementation does not use them',()=>{
  const vm=new VM(compile(base.replace('(x Box) describe = x describe','(x Box) describe = "constant"')));
  assert.deepEqual(vm.evaluate('3 Box describe'),['constant']);
  assert.throws(()=>vm.evaluate('True Box describe'),/No instance: describe bool/);
});

test('multiple instance constraints are checked independently for different head parameters',()=>{
  const p=compile(base+`
data 'a 'b pair = 'a 'b Pair
instance 'a describe, 'b add => ('a 'b pair) describe where
  (x y Pair) describe = x describe
both = Pair describe`),vm=new VM(p);
  assert.match(p.types.get('both'),/describe/);assert.match(p.types.get('both'),/add/);
  assert.deepEqual(vm.evaluate('1 2 both'),['1']);
  assert.throws(()=>vm.evaluate('True 2 both'),/describe bool/);
  assert.throws(()=>vm.evaluate('1 True both'),/add bool/);
});

test('instance bodies and caller annotations cannot omit required constraints',()=>{
  assert.throws(()=>compile(base.replace("instance 'a describe => ('a box)","instance ('a box)")),/Missing constraint/);
  assert.throws(()=>compile(base+"\nf : 'a -> string\nf = Box describe"),/Missing constraint/);
  assert.doesNotThrow(()=>compile(base+"\nf : 'a describe => 'a -> string\nf = Box describe"));
  assert.throws(()=>compile(base.replace("instance 'a describe => ('a box)","instance 'a missing => ('a box)")),/Unknown class/);
});

test('conditional each instances check their context before executing callbacks',()=>{
  const vm=new VM(compile(base+`
instance 'a describe => ('a box) each where
  (x Box) q each = x q call
walk = each`));
  assert.deepEqual(vm.evaluate('10 (2 Box) {+} walk'),[12]);
  assert.throws(()=>vm.evaluate('(True Box) {drop} walk'),/No instance: describe bool/);
});

test('instance constraints remain distinct from algebraic effect rows',()=>{
  const p=compile(`effect 'a yield: 'a ->
data 'a box = 'a Box
class 'a emit where
  emit : 'a -> / {string yield}
instance int emit where
  emit = show yield
instance 'a emit => ('a box) emit where
  (x Box) emit = x emit
f = Box emit`),vm=new VM(p);
  assert.match(p.types.get('f'),/'a emit =>/);assert.match(p.types.get('f'),/string yield/);
  assert.deepEqual(vm.evaluate('{1 Box emit} {yield: {-> x k; k resume}} handle'),[]);
  assert.throws(()=>vm.evaluate('{True Box emit} {yield: {-> x k; k resume}} handle'),/emit bool/);
});

test('REPL instance extension preserves old contexts and rejects errors before side effects',()=>{
  const initial=compile(base),extended=compile('instance bool describe where\n  describe = show','<repl>',initial.definitions);
  assert.deepEqual(new VM(extended).evaluate('True Box Box render'),['True']);
  const output=[],vm=new VM({...initial,output:x=>output.push(x)});
  assert.throws(()=>vm.evaluate('"must not print" print; True Box render'),/describe bool/);
  assert.deepEqual(output,[]);
});
