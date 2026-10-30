import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { VM, compile, parseExpression } from '../migration/v037-adapter.mjs';

test('declarations are immutable and updates require an existing mutable name', () => {
  assert.deepEqual(new VM().evaluate('["mut" "=" ":=" "->"]'), [['mut', '=', ':=', '->']]);
  assert.deepEqual(new VM(compile('"mut" label = 1')).evaluate('"mut" label'), [1]);
  for (const checkTypes of [true, false]) {
    const run = s => new VM({checkTypes}).evaluate(s);
    assert.deepEqual(run('0 -> x; x'), [0]);
    for (const s of ['x = 0; x := 1', '0 -> x; x := 1', 'x := 1', '0 -> x; 1 -> x', '0 -> mut x; 1 -> mut x'])
      assert.throws(() => run(s), /immutable|Unknown variable|already declared/);
    assert.deepEqual(run('0 -> mut x; x := x + 1; x'), [1]);
    assert.deepEqual(run('0 -> mut y; y := 2; y'), [2]);
  }
});

test('arrow ends at newline, EOF, and closing delimiters', () => {
  const vm = new VM();
  assert.deepEqual(vm.evaluate('3 4 5 -> x mut y z\ny := x + z\nx y z'), [3,8,5]);
  assert.deepEqual(vm.evaluate('0 -> mut a'), []);
  assert.deepEqual(vm.evaluate('(1 -> b) [2 -> c] {3 -> d} call'), [[]]);
  assert.deepEqual(vm.evaluate('8 -> e -- a comment\ne'), [8]);
  assert.deepEqual(vm.evaluate('9 -> f\r\nf'), [9]);
  for (const s of ['0 -> mut', '0 -> mut;', '0 -> mut\nx', 'mut x := 0', '0 -> mut mut'])
    assert.throws(() => parseExpression(s));
});

test('arrow initializers use the current stack and update RHS is isolated', () => {
  const vm = new VM(compile('n twice = n * 2'));
  assert.deepEqual(vm.evaluate('99; ((3 twice) + 1) -> mut x; x := x twice; x'), [99,14]);
  assert.deepEqual(vm.evaluate('[1\n2 3] -> mut ys; ys'), [[1,2,3]]);
  for (const s of ['1 -> mut a 2', 'drop -> mut a', '0 -> mut a; a := 1 2'])
    assert.throws(() => new VM().evaluate(s), /operand|underflow/);
});

test('shadowing declares a new variable; updates traverse captured environments', () => {
  const vm = new VM();
  assert.deepEqual(vm.evaluate('0 -> mut x; (x := 1); {x := x + 1} -> inc; inc call inc call x'), [3]);
  assert.deepEqual(vm.evaluate('(True -> x; x) x'), [true,3]);
  assert.deepEqual(vm.evaluate('(9 -> mut x; x := 10; x) x'), [10,3]);
  assert.deepEqual(vm.evaluate('inc call x'), [4]);
});

test('each and while can accumulate into mutable captures', () => {
  const vm = new VM();
  assert.deepEqual(vm.evaluate('0 -> mut total; [1 2 3] {-> n; total := total + n} each; total'), [6]);
  assert.deepEqual(vm.evaluate('{total < 10} {total := total + 1} while total'), [10]);
});

test('escaped mutable cells survive function return and rollback through closures', () => {
  const vm = new VM(compile('counter = 0 -> mut n; {n := n + 1; n}'));
  vm.evaluate('counter -> next');
  assert.deepEqual(vm.evaluate('next call'), [1]);
  assert.throws(() => vm.evaluate('next call drop; 1 / 0'), /Division by zero/);
  assert.deepEqual(vm.evaluate('next call'), [2]);
});

test('static errors precede output and mutable updates', () => {
  const output = [], vm = new VM({output:x=>output.push(x)});
  vm.evaluate('0 -> mut x');
  assert.throws(() => vm.evaluate('"bad" print; x := 1; x := True'), /Cannot unify/);
  assert.deepEqual(output, []);
  assert.deepEqual(vm.evaluate('x'), [0]);
});

test('mutable weak types persist across REPL inputs, empty values and inference', () => {
  const vm = new VM();
  vm.evaluate('[] -> mut xs');
  vm.infer('xs := [True]'); // Read-only queries must not specialize the cell.
  vm.evaluate('xs := [1]; xs := []');
  assert.throws(() => vm.evaluate('xs := [True]'), /Cannot unify/);
  assert.deepEqual(vm.evaluate('xs'), [[]]);
  const second = new VM();
  second.evaluate('[] -> mut xs');
  assert.throws(() => second.evaluate('xs := [True]; 1 / 0'), /Division by zero/);
  assert.deepEqual(second.evaluate('xs := [1]; xs'), [[1]]);
});

test('mutable quotations cannot be generalized via immutable aliases', () => {
  assert.throws(() => new VM().evaluate('{} -> mut q; {q call} -> f; q := {not}; 1 f call'), /Cannot unify/);
  const vm = new VM();
  vm.evaluate('{} -> mut q; {q call} -> f');
  vm.evaluate('q := {not}');
  assert.throws(() => vm.evaluate('1 f call'), /Cannot unify/);
  assert.deepEqual(vm.evaluate('True f call'), [false]);
});

test('top-level mutable declarations initialize once and are visible to functions', () => {
  const program = compile('0 -> mut x\n0 -> mut y\ninc = x := x + 1; y := y + 2\nmain = inc x y');
  const vm = new VM(program);
  assert.deepEqual(vm.evaluate('main'), [1,2]);
  assert.deepEqual(vm.evaluate('main'), [2,4]);
  assert.throws(() => compile('0 -> mut x\nmain = x := True'), /Cannot unify/);
});

test('CLI REPL supports mut declarations and reassignment', () => {
  const result = spawnSync(process.execPath, ['migration/v037-cli.mjs'], {cwd:new URL('..',import.meta.url), input:'0 -> mut x\nx := x + 1\nx\n0 -> mut y\ny := 2\ny\n:q\n',encoding:'utf8'});
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stdout, /Error:/);
  assert.match(result.stdout, /\[1\]/);
  assert.match(result.stdout, /\[1, 2\]/);
});

test('function redefinition validates quotations stored in mutable cells', () => {
  const vm = new VM(compile('f = 1'));
  vm.evaluate('{f} -> mut q; (1 + (q call)) drop');
  assert.throws(() => compile('f = True', 'changed.nyan', vm.definitions, {globals:vm.globals}), /Cannot unify/);
});

test('file type checks never execute global initializers', () => {
  const output=[], vm=new VM({...compile('("initializing" print 0) -> mut x\nmain = x'), output:x=>output.push(x)});
  assert.deepEqual(output, []);
  vm.infer('main');
  assert.deepEqual(output, []);
  assert.deepEqual(vm.evaluate('main'), [0]);
  assert.deepEqual(vm.evaluate('main'), [0]);
  assert.deepEqual(output, ['initializing']);
});
