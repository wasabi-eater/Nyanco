import test from 'node:test';
import assert from 'node:assert/strict';
import {VM,compile,format} from '../migration/v037-adapter.mjs';

test('records have expression fields, lexical scope, nesting and deterministic display',()=>{
  const vm=new VM();
  assert.deepEqual(vm.evaluate('3 -> x; {b: x + 1, a: {c: [1 2]}} -> r; r.b; r.a.c'),[4,[1,2]]);
  assert.equal(format(vm.evaluate('{z: 2, a: "hi"}')[0]),'{a: "hi", z: 2}');
  assert.equal(format(vm.evaluate('{:}')[0]),'{:}');
  assert.deepEqual(vm.evaluate('({a: 1, b: True} == {b: True, a: 1}); ({:} == {:})'),[true,true]);
  assert.deepEqual(vm.evaluate('{__proto__: 7, constructor: 8} .__proto__'),[7]);
});

test('field access infers open rows and merges requirements on the same record',()=>{
  const vm=new VM(compile(`get = .name
r total = r.x + r.y
main = {name: "Alice", age: 20} get; {name: 42, active: True} get; {y: 4, x: 3, z: 9} total`));
  assert.deepEqual(vm.evaluate('main'),['Alice',42,7]);
  assert.match(vm.infer('get'),/name: 'a.*\| 'r/);
  assert.match(vm.infer('total'),/'a add =>.*x: 'a, y: 'a.*\| 'r/);
  assert.deepEqual(vm.evaluate('[{name: "A", age: 1}; {age: 2, name: "B"}] {.name} map'),[['A','B']]);
  assert.deepEqual(vm.evaluate('{child: {x: 4, z: True}, extra: 0}.child.x'),[4]);
});

test('record rows reject absent fields, incompatible shapes and field types before execution',()=>{
  for(const expr of ['{a: 1}.b','1 .a','{:}.a','[{a: 1}; {b: 2}]','{a: 1, a: 2}','{a: }','{a: 1 2}','{a: dup}'])
    assert.throws(()=>new VM().evaluate(expr),/Type error|Duplicate record|requires a value/);
  const vm=new VM(compile('r total = r.x + r.y'));
  assert.throws(()=>vm.evaluate('{x: 1, y: True} total'),/Type error/);
  assert.throws(()=>vm.evaluate('{x: 1} total'),/Type error/);
  assert.throws(()=>vm.evaluate('{x: 1} -> mut r; r := {y: 2}'),/Type error/);
});

test('record effect annotations accept open and closed rows',()=>{
  const vm=new VM(compile(`get : {name: 'a | 'r} -> 'a
get = .name
exact : {x: int, y: bool} -> int
exact = .x
main = {name: 2, z: True} get; {x: 4, y: False} exact`));
  assert.deepEqual(vm.evaluate('main'),[2,4]);
  assert.throws(()=>vm.evaluate('{x: 1, y: True, z: 0} exact'),/Type error/);
  assert.throws(()=>compile("bad : {x: 'a | 'r} -> int\nbad = .y"),/Type error/);
});

test('record fields contain closures, local functions and ADTs with forward dependencies',()=>{
  const vm=new VM(compile(`data box = {value: int} Box
make = {q: {later}, data: ({value: 5} Box)}
later = + 1
main = 4 make.q call; {x: (f = 8; f)}.x`));
  assert.deepEqual(vm.evaluate('main'),[5,8]);
  assert.deepEqual(new VM().evaluate('{x: 2} -> r; r.x'),[2]);
});

test('row variables preserve the complete shape across inputs and outputs',()=>{
  const vm=new VM(compile(`keep : {x: int | 'r} -> {x: int | 'r}
keep = nop
anyRecord : {| 'r} -> {| 'r}
anyRecord = nop`));
  assert.deepEqual(vm.evaluate('{x: 2, extra: "kept"} keep.extra; {:} anyRecord'),['kept',{kind:'record',fields:Object.create(null)}]);
  assert.throws(()=>vm.evaluate('3 anyRecord'),/Type error/);
  assert.throws(()=>compile("bad : {x: int | 'r} -> {y: int | 'r}\nbad = nop"),/Type error/);
  assert.throws(()=>compile("bad : {x: int | 'r} -> 'r\nbad = .x"),/Type error/);
});

test('field expressions run in source order and do not leak declarations',()=>{
  const output=[],vm=new VM({output:s=>output.push(s)});
  vm.evaluate('{z: ("first" print; 1), a: ("second" print; 2)}');
  assert.deepEqual(output,['first','second']);
  assert.throws(()=>vm.evaluate('{a: (3 -> hidden; hidden), b: hidden}'),/Unknown word/);
  assert.equal(format(vm.evaluate('3; {a: _}')),'[{a: 3}]');
  assert.deepEqual(vm.evaluate('{q: {nop}} -> r; 4 r.q call; True r.q call'),[4,true]);
});
