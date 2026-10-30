import test from 'node:test';
import assert from 'node:assert/strict';
import {VM,compile} from '../migration/v037-adapter.mjs';
const run=source=>new VM().evaluate(source);

test('comparisons chain adjacent values, including equality and arithmetic operands',()=>{
  assert.deepEqual(run('3 -> x; 2 < x <= 3'),[true]);
  assert.deepEqual(run('4 -> x; 3 < x <= 4'),[true]);
  assert.deepEqual(run('3 < 3 <= 4'),[false]);
  assert.deepEqual(run('3 < 5 <= 4'),[false]);
  assert.deepEqual(run('5 > 4 >= 4 == 4 /= 3'),[true]);
  assert.deepEqual(run('1 == 1 < 2'),[true]);
  assert.deepEqual(run('1 + 2 < 2 * 2 <= 5 and True'),[true]);
  assert.deepEqual(run('False or 1 < 2 < 3'),[true]);
  assert.deepEqual(run('(1 < 2) == True'),[true]);
  assert.deepEqual(run('"a" == "a" /= "b"'),[true]);
});

test('missing middle operands bind once and after clause references',()=>{
  const vm=new VM(compile('f = 4'));
  assert.deepEqual(vm.evaluate('f; 3 < <= 4'),[true]);
  assert.deepEqual(run('3; 3 < <= 4'),[false]);
  assert.deepEqual(run('3 4; < <= 4'),[true]);
  assert.deepEqual(run('1 2 3; < <'),[true]);
  assert.deepEqual(run('4; 3 < _ <= 4'),[true]);
  assert.deepEqual(run('4; 3 < $ <= 4'),[4,true]);
  assert.deepEqual(run('2 3; _1 < < 4'),[true]);
  assert.deepEqual(run('2 3; (1 < <= (+ 1))'),[true]);
  assert.deepEqual(run('[2 3 4 5] {3 < <= 4} filter'),[[4]]);
});

test('middle operands run once and false chains short-circuit later operands',()=>{
  const output=[],vm=new VM({output:s=>output.push(s)});
  assert.deepEqual(vm.evaluate('3 < ("middle" print 4) <= ("last" print 4)'),[true]);
  assert.deepEqual(output,['middle','last']);output.length=0;
  assert.deepEqual(vm.evaluate('5 < ("middle" print 4) <= ("last" print 4)'),[false]);
  assert.deepEqual(output,['middle']);
  assert.deepEqual(run('5 < 4 < (1 / 0)'),[false]);
  assert.deepEqual(run('0 -> mut n; 3 < (n ! (+ 1); 4) <= 4; n'),[true,1]);
});

test('all operands and missing slots are checked even in a skipped tail',()=>{
  for(const source of ['5 < 4 < True','5 < 4 < unknown','5 < 4 <','1 < + 2','1 + < 2','1 < (2 3) < 4'])
    assert.throws(()=>run(source),undefined,source);
  const output=[],vm=new VM({output:s=>output.push(s)});
  assert.throws(()=>vm.evaluate('"unexpected" print; 5 < 4 < True'));
  assert.deepEqual(output,[]);
  assert.throws(()=>run('(3 < 2 < (1; _)) drop _'),/binding may be skipped/);
});

test('function dependencies inside chains participate in type inference',()=>{
  const p=compile('within = 3 < four <= 4\nfour = 4');
  assert.deepEqual(new VM(p).evaluate('within'),[true]);
});
