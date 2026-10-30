import test from 'node:test';
import assert from 'node:assert/strict';
import {compile,VM,format} from '../migration/v037-adapter.mjs';
const run=s=>new VM().evaluate(s);
test('tuple literals have heterogeneous elements, empty and singleton forms',()=>{
  const vm=new VM(compile('a : #(int string [int])\na = #(0 "Hoge" [])'));
  assert.deepEqual(vm.evaluate('a.0; a.1; a.2'),[0,'Hoge',[]]);
  assert.equal(format(run('#(); #(1); #(1 "x" [2])')),'[#(), #(1), #(1 "x" [2])]');
  assert.deepEqual(run('#(1.5 2).0'),[1.5]);
  assert.deepEqual(run('#(#(1 "nested") {x: 3}).0.1; #({x: 3}).0.x'),['nested',3]);
  assert.deepEqual(run('1.5; 1..3'),[1.5,{kind:'range',start:1,end:3,inclusive:false}]);
});
test('tuple index functions infer prefix rows and compose with higher order calls',()=>{
  const vm=new VM(compile('first = .0\nthird = .2'));
  assert.equal(vm.infer('first'),"..s #('a | 't) -- ..s 'a");
  assert.deepEqual(vm.evaluate('#(1) first; #(True "x") first'),[1,true]);
  assert.deepEqual(vm.evaluate('[#(1 "a"); #(2 "b")] {.1} map'),[['a','b']]);
  assert.deepEqual(vm.evaluate('#(1 True "last" 4) third'),['last']);
  assert.deepEqual(vm.evaluate('#(1 "x" True) -> t; t.0; t.2'),[1,true]);
});
test('tuple elements execute commands and share clauses with their surroundings',()=>{
  assert.equal(format(run('3; #(_ "x")')),'[#(3 "x")]');
  assert.equal(format(run('#(2 3; +; "sum")')),'[#(5 "sum")]');
  assert.equal(format(run('#(4; _) _')),'[#(4), 4]');
  assert.throws(()=>run('3 #(_)'),/underflow/);
  assert.deepEqual(run('#(f = +; 3 4 f).0'),[7]);
});
test('tuple annotations check exact shape, elements and open prefixes',()=>{
  const vm=new VM(compile("first : #('a | 't) -> 'a\nfirst = .0\na : #(int string)\na = #(1 \"x\")"));
  assert.deepEqual(vm.evaluate('a first'),[1]);
  for(const source of ['a : #(int string)\na = #(1 True)','a : #(int string)\na = #(1)',
    'a : #(int)\na = #(1 2)'])assert.throws(()=>compile(source),/Type error/);
  for(const s of ['#().0','#(1).1','[1].0','{x: 1}.0','#(1) .x','[#(1); #(1 2)]','[#(1); #(True)]'])
    assert.throws(()=>run(s),/Type error/);
  assert.throws(()=>run('#(1).100001'),/Tuple index/);
  assert.throws(()=>run('#(1) -> mut x; x := #(True)'),/Type error/);
  assert.throws(()=>compile('a : #(Int)\na = #(1)'),/Unknown type/);
});
test('tuples support structural equality and exact patterns in declarations, case and arrow',()=>{
  const vm=new VM(compile(`data wrapped = #(int string) Wrapped
#(x y) unpack = x y
choose = case
  -> #(0 _) then "zero"
  -> #(n s) then s
main = #(3 "ok") unpack; #(0 "ignored") choose`));
  assert.deepEqual(vm.evaluate('main'),[3,'ok','zero']);
  assert.deepEqual(vm.evaluate('#(2 "x") -> #(n s); n s'),[2,'x']);
  assert.deepEqual(vm.evaluate('#(1 [2]) == #(1 [2])'),[true]);
  assert.throws(()=>vm.evaluate('#(1) unpack'),/arity mismatch/);
  assert.throws(()=>vm.evaluate('#(1 "x") -> #(0 other); other'),/pattern did not match/);
  assert.throws(()=>compile('#(x x) f = x'),/Duplicate pattern/);
});
test('tuple closures retain constraints and dependencies',()=>{
  const vm=new VM(compile('wrapped = #({later})\nlater = +\nmain = 3 4 wrapped.0 call'));
  assert.deepEqual(vm.evaluate('main'),[7]);
  assert.deepEqual(run('#({nop}) -> t; 1 t.0 call; True t.0 call'),[1,true]);
});
