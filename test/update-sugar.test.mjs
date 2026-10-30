import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { VM, compile, parseExpression } from '../migration/v037-adapter.mjs';

test('! behaves exactly like := with the current value prepended', () => {
  for (const checkTypes of [true, false]) {
    const program=compile('n double = n * 2', '<test>', new Map(), {checkTypes});
    for (const rhs of ['double', 'double double', '(+ 1)', '+ 1 double', '{+ 1} call']) {
      const run=op=>new VM({...program,checkTypes}).evaluate(`99; 3 -> mut x; x ${op} ${rhs}; x`);
      assert.deepEqual(run('!'),run(':= x'),rhs);
    }
    assert.deepEqual(new VM({...program,checkTypes}).evaluate('3 -> mut x; x!double; x'), [6]);
  }
});

test('! terminates like := and updates captured mutable cells', () => {
  const vm=new VM();
  assert.deepEqual(vm.evaluate('0 -> mut x\n{x ! (+ 1)} -> inc\ninc call; (x ! (+ 2)); x'),[3]);
  assert.deepEqual(vm.evaluate('x ! (+ 1)'),[]);
  assert.deepEqual(vm.evaluate('x'),[4]);
  assert.throws(()=>vm.evaluate('x ! (+ 1); 1 / 0'),/Division by zero/);
  assert.deepEqual(vm.evaluate('x'),[4]);
});

test('! preserves immutable, type and stack-effect checks', () => {
  for (const checkTypes of [true,false]) {
    for (const source of ['3 -> x; x ! (+ 1)','x ! (+ 1)'])
      assert.throws(()=>new VM({checkTypes}).evaluate(source),/immutable|Unknown variable/);
  }
  const output=[],vm=new VM({output:x=>output.push(x)});
  vm.evaluate('3 -> mut x');
  for (const rhs of ['drop True','dup','drop'])
    assert.throws(()=>vm.evaluate(`"bad" print; x ! ${rhs}`),/Cannot unify|operand/);
  assert.deepEqual(output,[]);
  assert.deepEqual(vm.evaluate('x'),[3]);
  for (const source of ['x !','x !;','x !\nf','mut x ! f','! f','3 ! f'])
    assert.throws(()=>parseExpression(source));
  assert.deepEqual(vm.evaluate('"!"'),['!']);
});

test('! works in file definitions and REPL input', () => {
  const program=compile('n double = n * 2\nmain = 3 -> mut x; x ! double; x');
  assert.deepEqual(new VM(program).evaluate('main'),[6]);
  const result=spawnSync(process.execPath,['migration/v037-cli.mjs'],{cwd:new URL('..',import.meta.url),input:'n double = n * 2\n3 -> mut x\nx ! double\nx\n:q\n',encoding:'utf8'});
  assert.equal(result.status,0);
  assert.doesNotMatch(result.stdout,/Error:/);
  assert.match(result.stdout,/\[6\]/);
});
