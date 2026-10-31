import test from 'node:test';
import assert from 'node:assert/strict';
import {VM,compile,format} from '../migration/v037-adapter.mjs';
const generic=`data 'a box = 'a Box
class 'a describe where
  describe : 'a -> string
instance describe int where
  describe = show
instance 'a describe => describe ('a box) where
  (x Box) describe = x describe
instance 'a describe => describe ['a] where
  describe = {describe} map show
instance each ('a box) where
  (x Box) q each = x q call
walk = each`;
test('generic instances substitute their head parameters and enforce context constraints',()=>{
  const vm=new VM(compile(generic));
  assert.deepEqual(vm.evaluate('3 Box describe; [1 2] describe; 4 Box Box describe'),['3','["1", "2"]','4']);
  assert.throws(()=>vm.evaluate('True Box describe'),/No instance: describe bool/);
  assert.throws(()=>compile(generic.replace("instance 'a describe => describe ('a box)","instance describe ('a box)")),/Missing constraint/);
});
test('each supports generic user containers and threads the ambient stack',()=>{
  const vm=new VM(compile(generic));
  assert.deepEqual(vm.evaluate('10 (2 Box) {+} walk; 0 (1..=4) {+} walk; 0 [2 3] {+} walk'),[12,10,5]);
  assert.deepEqual(vm.evaluate('"prefix" 10 (2 Box) {+} each'),['prefix',12]);
  assert.match(vm.infer('walk'),/^'b 'a each =>/);
  assert.throws(()=>vm.evaluate('0 (True Box) {+} walk'),/Cannot unify/);
  assert.throws(()=>vm.evaluate('3 {drop} each'),/No instance: streem int/);
  assert.throws(()=>vm.evaluate('(3 Box) {dup} each'),/Infinite type|shape|underflow/);
});
test('nonparametric each instances declare an item type',()=>{
  const vm=new VM(compile(`data pair = int int Pair
instance each pair where
  item : int
  (x y Pair) q each = x q call; y q call`));
  assert.deepEqual(vm.evaluate('0 (2 3 Pair) {+} each'),[5]);
  assert.throws(()=>compile(`data unit = Unit
instance each unit where
  each = drop drop`),/requires item/);
});
test('generic operator instances retain constraints on element types',()=>{
  const p=compile(`data 'a box = 'a Box
instance 'a add => add ('a box) where
  (x Box) (y Box) + = (x + y) Box
f = +`),vm=new VM(p);
  assert.equal(format(vm.evaluate('(2 Box) + (3 Box)')),'[(Box 5)]');
  assert.equal(format(vm.evaluate('(2 Box Box) (3 Box Box) f')),'[(Box (Box 5))]');
  assert.throws(()=>vm.evaluate('(True Box) + (False Box)'),/No instance: add bool/);
});
test('instance heads reject duplicates, invalid variables and builtin each overrides',()=>{
  assert.throws(()=>compile(generic+`\ninstance each ('a box) where\n  each = drop drop`),/Duplicate instance/);
  assert.throws(()=>compile(`instance each [int] where\n  each = drop drop`),/Built-in each/);
  assert.throws(()=>compile(generic+`\ninstance 'z describe => describe range where\n  describe = show`),/variable must occur/);
});
test('range values persist in REPL stacks and each works through captured quotations',()=>{
  const vm=new VM(compile(generic));const stack=vm.evaluate('1..=4');
  assert.deepEqual(vm.evaluate('0 swap {+} each',stack),[10]);
  assert.deepEqual(vm.evaluate('{each} -> walkq; 0 (1..=4) {+} walkq call'),[10]);
});
test('legacy uppercase type aliases print canonical lowercase names',()=>{
  const p=compile(`data Legacy = Legacy int
f : Legacy -> int
(x Legacy) f = x`);
  assert.equal(p.types.get('f'),'..s legacy -> ..s int');
  assert.equal(new VM().infer('1 True "s"'),'..s -> ..s int bool string');
});

test('recursive each instances visit trees using the same accumulator',()=>{
  const vm=new VM(compile(`data 'a tree = 'a Leaf | ('a tree) ('a tree) Node
instance each ('a tree) where
  (x Leaf) q each = x q call
  (l r Node) q each = l q each; r q each`));
  assert.deepEqual(vm.evaluate('0 ((1 Leaf) ((2 Leaf) (3 Leaf) Node) Node) {+} each'),[6]);
});
test('conditional equality instances enforce their element constraints',()=>{
  const vm=new VM(compile(`data 'a box = 'a Box
instance 'a add, 'a eq => eq ('a box) where
  (x Box) (y Box) == = (x + y) == x
  (x Box) (y Box) /= = (x + y) /= x
same = ==`));
  assert.deepEqual(vm.evaluate('(1 Box) (0 Box) same'),[true]);
  assert.throws(()=>vm.evaluate('(True Box) (False Box) same'),/No instance: add bool/);
});
