import test from 'node:test';
import assert from 'node:assert/strict';
import {compile,VM} from '../migration/v037-adapter.mjs';
const box=`data 'a box = 'a Box
class 'c unpack where
  type item
  unpack : 'c -> item
instance ('a box) unpack where
  item : 'a
  (x Box) unpack = x
unwrap = unpack`;
const lmap=`data 'c 'a 'b lmap = 'c {'a -> 'b} LMap
instance 'c 'a each => ('c 'a 'b lmap) each where
  item : 'b
  (c f LMap) g each = c {f call; g call} each`;

test('user classes infer associated types and specialize each invocation independently',()=>{
  const p=compile(box),vm=new VM(p);
  assert.match(p.types.get('unwrap'),/'a 'a1 unpack =>/);
  assert.deepEqual(vm.evaluate('3 Box unwrap; True Box unwrap; [1 2] Box unwrap'),[3,true,[1,2]]);
  assert.throws(()=>vm.evaluate('3 unwrap'),/No instance/);
});

test('multiple associated types remain tied to the same instance across methods',()=>{
  const p=compile(`data 'a 'b pair = 'a 'b Pair
class 'c parts where
  type left
  type right
  getLeft : 'c -> left
  getRight : 'c -> right
instance ('a 'b pair) parts where
  left : 'a
  right : 'b
  (x y Pair) getLeft = x
  (x y Pair) getRight = y
both = dup getLeft; swap getRight
main = (1 "x" Pair) both`);
  assert.deepEqual(new VM(p).evaluate('main'),[1,'x']);
  assert.match(p.types.get('both'),/parts =>/);
});

test('associated result annotations enforce functional dependence and required assumptions',()=>{
  assert.doesNotThrow(()=>compile(box+"\nf : 'c 'a unpack => 'c -> 'a\nf = unpack"));
  assert.doesNotThrow(()=>compile(box+"\nf : 'c 'a unpack => 'c ->\nf = unpack drop"));
  assert.throws(()=>compile(box+"\nf : 'c -> 'a\nf = unpack"),/Missing constraint/);
  assert.throws(()=>compile(box+"\nf : ('a box) -> string\nf = unpack"),/Cannot unify/);
  const shared=compile(box+"\nf : 'c 'a unpack, 'c 'b unpack => 'c -> 'a 'b\nf = dup unpack; swap unpack");
  assert.deepEqual(new VM(shared).evaluate("3 Box f"),[3,3]);
  assert.match(shared.types.get("f"),/-- \.\.s 'a1 'a1$/);
});

test('associated types may be structured and contexts carry associated equalities',()=>{
  const p=compile(box+`
data 'c 'a wrapped = 'c Wrapped
instance 'c 'a unpack => ('c 'a wrapped) unpack where
  item : ['a]
  (x Wrapped) unpack = [x unpack]
main = 3 Box Wrapped unpack`);
  assert.deepEqual(new VM(p).evaluate('main'),[[3]]);
  assert.throws(()=>compile(box+`
data 'c 'a wrapped = 'c Wrapped
instance ('c 'a wrapped) unpack where
  item : ['a]
  (x Wrapped) unpack = [x unpack]`),/Missing constraint/);
});

test('associated type declarations reject omissions, duplicates, unknown variables and incorrect implementations',()=>{
  for(const [from,to] of [["  item : 'a\n",''],["  item : 'a", "  item : 'a\n  item : int"],["  item : 'a","  item : 'missing"],["  (x Box) unpack = x","  (x Box) unpack = True"],["  type item","  type item\n  type item"]])assert.throws(()=>compile(box.replace(from,to)),/associated type|undeclared|Cannot unify/);
});

test('lmap accepts each associated-type prerequisites and preserves accumulation',()=>{
  const p=compile(lmap),vm=new VM(p);
  assert.deepEqual(vm.evaluate('0 ([1 2 3] {+ 10} LMap) {+} each'),[36]);
  assert.deepEqual(vm.evaluate('[] ((1..=3) {show} LMap) {::} each'),[['1','2','3']]);
  assert.deepEqual(vm.evaluate('0 (([1 2] {+ 10} LMap) {* 2} LMap) {+} each'),[46]);
  assert.throws(()=>vm.evaluate('(3 {+ 1} LMap) {drop} each'),/No instance/);
  assert.throws(()=>vm.evaluate('([True] {+ 1} LMap) {drop} each'),/Cannot unify/);
});

test('associated declarations and instance relations survive REPL updates and quotation captures',()=>{
  const first=compile(box),next=compile('instance int unpack where\n  item : bool\n  unpack = drop True','<repl>',first.definitions),vm=new VM(next);
  assert.deepEqual(vm.evaluate('{unpack} -> q; 1 q call; "s" Box q call'),[true,'s']);
  assert.throws(()=>new VM(first).evaluate('1 unpack'),/No instance/);
});

test('associated types are class-scoped and may be unused by a method',()=>{
  const p=compile(box+`
class 'c measure where
  type item
  measure : 'c -> int
instance ('a box) measure where
  item : bool
  measure = drop 1
f = dup unpack; swap measure
main = "x" Box f`);
  assert.deepEqual(new VM(p).evaluate('main'),['x',1]);
  assert.match(p.types.get('measure'),/measure =>/);
});

test('related constraints survive mutable quotations and preserve effect checking',()=>{
  const vm=new VM(compile(box));
  assert.deepEqual(vm.evaluate('{unpack} -> mut q; 1 Box q call'),[1]);
  assert.throws(()=>vm.evaluate('True Box q call'),/Cannot unify/);
  const p=compile(box+`
effect log: string ->
class 'c send where
  type item
  send : 'c -> item / {log}
instance ('a box) send where
  item : 'a
  (x Box) send = "sent" log; x
main = {3 Box send} {log: {-> message k; k resume}} handle`);
  assert.deepEqual(new VM(p).evaluate('main'),[3]);
});
