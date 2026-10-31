import test from 'node:test';
import assert from 'node:assert/strict';
import {VM,compile,parseExpression} from '../migration/v037-adapter.mjs';

const run=source=>new VM().evaluate(source);

test('all four squared definitions infer and execute the same effect',()=>{
  for(const body of ['dup; *','$; *','* $','_ * _']) {
    const p=compile(`squared = ${body}`);
    const vm=new VM(p);
    assert.deepEqual(vm.evaluate('7 squared'),[49],body);
    assert.equal(vm.infer('squared'),"'a mul => ..s 'a -> ..s 'a");
  }
});

test('indexed references select the original clause stack and remove each index once',()=>{
  assert.deepEqual(run('10 20; _1'),[20,10]);
  assert.deepEqual(run('10 20; $1'),[10,20,10]);
  assert.deepEqual(run('10 20; $'),[10,20,20]);
  assert.deepEqual(run('10 20 30 40; _2 _0 _2'),[10,30,20,40,20]);
  assert.deepEqual(run('10 20 30; _1 $0 $2'),[10,30,20,30,10]);
  assert.deepEqual(run('5; _ _0'),[5,5]);
  assert.deepEqual(run('5; $ $0'),[5,5,5]);
});

test('parentheses are transparent and semicolons reset the clause snapshot',()=>{
  assert.deepEqual(run('7; 100 drop (_ * (_))'),[49]);
  assert.deepEqual(run('2; (_; 3) _'),[3,2]);
  assert.deepEqual(run('2; (_; 3) (_ * _)'),[3,4]);
  assert.deepEqual(run('2; $; _ * _'),[2,4]);
  assert.deepEqual(run('2; _\n_'),[2,2]);
  assert.throws(()=>run('2 (_ * _)'),/underflow/i);
});

test('explicit references bind before missing binary operands',()=>{
  assert.deepEqual(run('3; * $'),[9]);
  assert.deepEqual(run('10 3; _ -'),[-7]);
  assert.deepEqual(run('10 3; - _'),[7]);
  assert.deepEqual(run('3 4 5 (+ (*))'),[23]);
  assert.deepEqual(run('3 4 5; + (_1 * _)'),[23]);
});

test('quotations start their own clauses and list semicolons reset snapshots',()=>{
  assert.deepEqual(run('5 {_ * _} call'),[25]);
  assert.deepEqual(run('[1 2 3] {_ * _} map'),[[1,4,9]]);
  assert.deepEqual(run('0 [1 2 3] {_1 + _} each'),[6]);
  assert.deepEqual(run('[2; _ * _; $]'),[[4,4]]);
  assert.deepEqual(run('10; _ { _ * _ } call'),[100]);
  assert.throws(()=>run('9 [_]'),/underflow/i);
});

test('conflicts and invalid depths fail before effects or stack mutation',()=>{
  for(const source of ['_; $ _','_ $0','(_1) ($1)','1 -> mut _1','1 -> _2','_100001','_9007199254740992'])
    assert.throws(()=>parseExpression(source),undefined,source);
  const output=[],vm=new VM({output:s=>output.push(s)}),stack=[1];
  assert.throws(()=>vm.evaluate('"unexpected" print; _2',stack),/underflow/i);
  assert.deepEqual(output,[]);assert.deepEqual(stack,[1]);
  assert.throws(()=>run('True; _ + _'),/Type error/);
});

test('references work in initializers and patterns retain wildcard semantics',()=>{
  assert.deepEqual(run('3; _ * _ -> x; x'),[9]);
  const p=compile('_ ignore = 42\nmain = 8 ignore');
  assert.deepEqual(new VM(p).evaluate('main'),[42]);
});
