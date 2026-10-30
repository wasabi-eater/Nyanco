import test from 'node:test';
import assert from 'node:assert/strict';
import {VM,format,compile} from '../migration/v037-adapter.mjs';
const run=s=>format(new VM().evaluate(s));
test('lists, records and parentheses share the enclosing clause references',()=>{
  assert.equal(run('3; [_]'),'[[3]]');
  assert.equal(run('3; {x: _}'),'[{x: 3}]');
  assert.equal(run('3; ([_])'),'[[3]]');
  assert.equal(run('3; [_] _'),'[[3], 3]');
  assert.equal(run('3; {x: _, y: _} _'),'[{x: 3, y: 3}, 3]');
  assert.equal(run('3; [[$]]'),'[3, [[3]]]');
  assert.equal(run('2 3; [{x: _1, y: _}]'),'[[{x: 2, y: 3}]]');
  assert.throws(()=>run('3; [_] $'),/Cannot mix/);
  assert.throws(()=>run('3; {x: $, y: _}'),/Cannot mix/);
  assert.throws(()=>run('3 [_]'),/underflow/);
});
test('semicolons inside containers start clauses and remain active after closing',()=>{
  assert.equal(run('3; [_; _ * _]'),'[[9]]');
  assert.equal(run('3; (_; _ * _)'),'[9]');
  assert.equal(run('3; {x: (_; _ * _)}'),'[{x: 9}]');
  assert.equal(run('3; [4; _] _'),'[3, [4], 4]');
  assert.equal(run('3; {x: 4; _, y: _} _'),'[3, {x: 4, y: 4}, 4]');
  assert.equal(run('3; [_; 4; _] _'),'[[3, 4], 4]');
  assert.throws(()=>run('3; [; _]'),/underflow/);
});
test('empty record fields consume missing values after explicit captures',()=>{
  assert.equal(run('3 {x:}'),'[{x: 3}]');
  assert.equal(run('2 3 {x:, y:}'),'[{x: 2, y: 3}]');
  assert.equal(run('2 3; {x: _, y:}'),'[{x: 3, y: 2}]');
  assert.equal(run('3; {x: $, y:}'),'[{x: 3, y: 3}]');
  assert.equal(run('3; {x:}.x + 1'),'[4]');
  assert.throws(()=>run('{x:}'),/underflow/);
});
test('quotation clauses stay deferred and container references infer function inputs',()=>{
  assert.equal(run('3 {[_]} call'),'[[3]]');
  const vm=new VM(compile('pack = [_]\nrecord = {x: _}'));
  assert.match(vm.infer('pack'),/-- .*\[/);
  assert.equal(format(vm.evaluate('3 pack; True record')),'[[3], {x: True}]');
  assert.equal(run('[1 2; +]'),'[[3]]');
});

