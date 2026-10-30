import test from 'node:test';
import assert from 'node:assert/strict';
import {VM,compile} from '../migration/v037-adapter.mjs';
const run=s=>new VM().evaluate(s);
test('adjacent operators fill missing operands in source order with normal precedence',()=>{
  assert.deepEqual(run('3 4 5; + +'),[12]);
  assert.deepEqual(run('3 4 5; + *'),[23]);
  assert.deepEqual(run('3 4 5; * +'),[17]);
  assert.deepEqual(run('20 5 2; - -'),[13]);
  assert.deepEqual(run('2 3 2; ^ ^'),[512]);
  assert.deepEqual(run('[] 1 2; :: ::'),[[1,2]]);
  assert.deepEqual(run('2 3 4 5; + * -'),[9]);
});
test('adjacent operators compose with explicit operands, clauses and captures',()=>{
  assert.deepEqual(run('3 4; + * 5'),[23]);
  assert.deepEqual(run('4 5; 3 + *'),[23]);
  assert.deepEqual(run('3 4 5; + * _'),[23]);
  assert.deepEqual(run('3 4 5; (+) *'),[35]);
  assert.deepEqual(run('3 4 5; +; *'),[27]);
  assert.deepEqual(run('3 4 5 {+ *} call'),[23]);
  assert.deepEqual(run('[3 4 5; + *]'),[[23]]);
  assert.throws(()=>run('3; + *'),/underflow/);
});
test('comparison chains and ranges combine with adjacent arithmetic operators',()=>{
  assert.deepEqual(run('1 2 4; + <'),[true]);
  assert.deepEqual(run('1 2 4; < +'),[true]);
  assert.deepEqual(run('1 2 3 4; < + <='),[false]);
  assert.deepEqual(run('[] (1 2 4; + ..=) {Push} each'),[[3,4]]);
  assert.deepEqual(run('True False True; or and'),[true]);
  const output=[],vm=new VM({output:x=>output.push(x)});
  assert.deepEqual(vm.evaluate('5 1 2; < + < ("unexpected" print; 10)'),[false]);
  assert.deepEqual(output,[]);
});
test('operator sequences infer constraints and dispatch ADT instances',()=>{
  const p=compile(`data amount = int Amount
instance add amount where
  (x Amount) (y Amount) + = (x + y) Amount
instance mul amount where
  (x Amount) (y Amount) * = (x * y) Amount
f = + *`),vm=new VM(p);
  assert.equal(vm.infer('f'),"'a add, 'a mul => ..s 'a 'a 'a -- ..s 'a");
  assert.equal(vm.evaluate('(3 Amount) (4 Amount) (5 Amount) f')[0].fields[0],23);
});
