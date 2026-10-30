import test from 'node:test';
import assert from 'node:assert/strict';
import {compile,VM} from '../migration/v037-adapter.mjs';
test('classes, constraints and generic instances accept postfix spelling',()=>{
  const p=compile(`data 'a box = 'a Box
class 'a describe where
  describe : 'a -> string
instance num describe where
  describe = show
instance 'a describe => ('a box) describe where
  (x Box) describe = x describe
instance 'a add => ('a box) add where
  (x Box) (y Box) + = (x + y) Box
f : 'a describe => 'a -> string
f = describe`);
  const vm=new VM(p);assert.deepEqual(vm.evaluate('3 Box f'),['3']);
  assert.equal(p.types.get('f'),"'a describe => ..s 'a -- ..s string");
  assert.deepEqual(vm.evaluate('(1 Box) + (2 Box)')[0].fields,[3]);
  assert.match(vm.infer('+'),/^'a add =>/);
});
test('polymorphic yield can handle unrelated types in one computation',()=>{
  const output=[],vm=new VM({...compile(`effect 'a yield: 'a ->
withHandlers = handle
emit = yield
main = {1 emit; True yield; "hi" yield; [1 2] yield; 42} {yield: {-> x k; x print; k resume}} withHandlers`),output:x=>output.push(x)});
  assert.deepEqual(vm.evaluate('main'),[42]);assert.deepEqual(output,['1','True','hi','[1, 2]']);
});
test('polymorphic operation inputs and resumed outputs share their type variables',()=>{
  const vm=new VM(compile(`effect 'a identity: 'a -> 'a
main = {3 identity; True identity; #( _1 _ )} {identity: {-> x k; x k resume}} handle`));
  assert.deepEqual(vm.evaluate('main')[0].items,[3,true]);
  assert.throws(()=>compile(`effect 'a identity: 'a -> 'a
main = {True identity} {identity: {-> x k; 0 k resume}} handle`),/Type error/);
});
test('handlers must be generic and cannot leak an operation type into results or mutable captures',()=>{
  const sources=[
    '{1 yield; 0} {yield: {-> x k; (x + 1) print; k resume}} handle',
    '{1 yield; 0} {yield: {-> x k; x}} handle',
    '[] -> mut xs; {1 yield; 0} {yield: {-> x k; xs := xs :: x; k resume}} handle',
  ];
  for(const body of sources)assert.throws(()=>compile("effect 'a yield: 'a ->\nmain = "+body),/Type error/);
  assert.throws(()=>compile("effect 'a read: -> 'a\nmain = {read} {read: {-> k; 0 k resume}} handle"),/Type error/);
});
test('generic effects support multiple parameters, structured types and bottom returns',()=>{
  const vm=new VM(compile(`effect 'a 'b pair: 'a 'b -> #('a 'b)
effect 'a fail: 'a -> !
main = {1 "ok" pair} {pair: {-> a b k; #(a b) k resume}} handle;
  {True fail} {fail: {-> reason k; 7}} handle`));
  const result=vm.evaluate('main');assert.deepEqual(result[0].items,[1,'ok']);assert.equal(result[1],7);
});
test('effect parameter declarations reject duplicates, undeclared and unused parameters',()=>{
  for(const source of ["effect 'a 'a x: 'a ->", "effect 'a x: 'b ->", "effect 'a x: num ->", "effect x: 'a ->"])
    assert.throws(()=>compile(source));
});
test('polymorphic handler values can be reused and declarations persist across REPL compilations',()=>{
  const first=compile("effect 'a yield: 'a ->"),p=compile(`h = {yield: {-> x k; k resume}}
main = {1 yield; 2} h handle; {True yield; "ok"} h handle`,'<repl>',first.definitions);
  assert.deepEqual(new VM(p).evaluate('main'),[2,'ok']);
});

test('handler factories cannot hide mutable captures from universal checking',()=>{
  const body=`effect 'a yield : 'a ->
make = [] -> mut xs; {yield: {-> x k; xs := xs :: x; k resume}}
main = {1 yield; True yield; 0} make handle`;
  assert.throws(()=>compile(body),/escapes/);
  const annotated=`effect 'a yield : 'a ->
make : -> {yield: {'a 'k -> num}}
make = [] -> mut xs; {yield: {-> x k; xs := xs :: x; 0}}
main = {1 yield; 0} make handle`;
  assert.throws(()=>compile(annotated),/escapes/);
  const vm=new VM(compile(`effect 'a yield : 'a ->
main = {1 yield; True yield; 0} {yield: {-> x k; {x drop} call; k resume}} handle`));
  assert.deepEqual(vm.evaluate('main'),[0]);
});

test('polymorphic effects retain list elements and record row kinds',()=>{
  const vm=new VM(compile(`effect 'a first : ['a] -> 'a
effect 'r getX : {x: num | 'r} -> num
main = {([1] first); ([True] first); #( _1 _ )} {first: {-> xs k; xs head k resume}} handle;
  {{x: 3, name: "n"} getX} {getX: {-> record k; record.x k resume}} handle`));
  const values=vm.evaluate('main');assert.deepEqual(values[0].items,[1,true]);assert.equal(values[1],3);
});
