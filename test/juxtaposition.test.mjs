import test from 'node:test';
import assert from 'node:assert/strict';
import {VM,compile,parseExpression,StaticTypeError} from '../migration/v037-adapter.mjs';

test('command sequences bind tighter than both sides of infix operators',()=>{
  const program=compile('x twice = x * 2\nx inc = x + 1');
  const vm=new VM(program);
  assert.deepEqual(vm.evaluate('3 twice + 4 inc'),[11]);
  assert.deepEqual(vm.evaluate('3 twice inc + 4 inc twice * 2 inc'),[37]);
  assert.deepEqual(vm.evaluate('(3 + 4) twice'),[14]);
  assert.deepEqual(vm.evaluate('3 + 4; twice'),[14]);
  const [node]=parseExpression('x f + a');
  assert.equal(node.kind,'binary');
  assert.deepEqual(node.left.map(n=>n.value),['x','f']);
  assert.deepEqual(node.right.map(n=>n.value),['a']);
});

test('lists require separators to keep independent outputs before infix expressions',()=>{
  assert.throws(()=>compile('n build = [n n + 1]'),StaticTypeError);
  const program=compile('n build = [n; n + 1]');
  assert.deepEqual(new VM(program).evaluate('4 build'),[[4,5]]);
  for(const checkTypes of [true,false]) {
    const vm=new VM({checkTypes});
    assert.throws(()=>vm.evaluate('3 -> n; [n n + 1]'),/operand|consume 0/);
    assert.deepEqual(vm.evaluate('99; 1 + 2; 4'),[99,3,4]);
  }
  assert.throws(()=>new VM().evaluate('[1\n2 + 3]'),StaticTypeError);
});

test('operand isolation and pre-execution type checks remain enforced',()=>{
  const output=[],vm=new VM({output:x=>output.push(x)});
  assert.throws(()=>vm.evaluate('3 + 2 print'),StaticTypeError);
  assert.deepEqual(output,[]);
  assert.deepEqual(vm.evaluate('3 + 2; print'),[]);
  assert.deepEqual(output,['5']);
  assert.throws(()=>vm.evaluate('99; dup + 1'),StaticTypeError);
  assert.deepEqual(vm.evaluate('3 4 5 (+ (*))'),[23]);
  assert.deepEqual(vm.evaluate('5; 4 +'),[9]);
});

test('high-priority calls work with constructors, updates and declaration boundaries',()=>{
  const vm=new VM(compile("data 'a option = None | 'a Some\nx inc = x + 1"));
  assert.deepEqual(vm.evaluate('1 Some == 1 Some'),[true]);
  assert.deepEqual(vm.evaluate('3 -> mut x; x ! inc + 2; x'),[6]);
  assert.deepEqual(vm.evaluate('1 2 -> mut y\ny + 3'),[1,5]);
  assert.deepEqual(vm.evaluate('[3] :: [1 2] length'),[[3,2]]);
});
