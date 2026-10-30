import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// Runtime-only regression tests also exercise intentionally ill-typed code.
// Static checking is tested separately using the default public API.
import { VM as CheckedVM, compile as checkedCompile, parseExpression, LanguageError } from '../migration/v037-adapter.mjs';
class VM extends CheckedVM { constructor(options={}) { super({...options,checkTypes:false}); } }
const compile=(source,file,previous)=>checkedCompile(source,file,previous,{checkTypes:false});

const run = (s, definitions) => new VM({ definitions }).evaluate(s);
test('when executes only for True and shares the caller stack', () => {
  assert.deepEqual(run('10 True {+ 2} when'), [12]);
  assert.deepEqual(run('10 False {missing} when'), [10]);
  assert.deepEqual(run('True {1 2} when'), [1,2]);
  assert.deepEqual(run('True {} when'), []);
});
test('when validates both operands and propagates body errors', () => {
  assert.throws(()=>run('1 {} when'), /Expected boolean/);
  assert.throws(()=>run('False 1 when'), /Expected quotation/);
  assert.throws(()=>run('True when'), /underflow/);
  assert.throws(()=>run('True {missing} when'), /Unknown word/);
});
test('while tests before each iteration and preserves stack state', () => {
  assert.deepEqual(run('0 {dup; < 3} {+ 1} while'), [3]);
  assert.deepEqual(run('99 0 {dup; < 3} {+ 1} while'), [99,3]);
  assert.deepEqual(run('99 {False} {missing} while'), [99]);
  assert.deepEqual(run('0 1 {dup; <= 3} {-> sum n; sum + n; n + 1} while'), [6,4]);
});
test('while consumes only the condition boolean and preserves other effects', () => {
  const output=[],vm=new VM({output:s=>output.push(s)});
  assert.deepEqual(vm.evaluate('0 {dup print; dup; < 2} {+ 1} while'), [2]);
  assert.deepEqual(output,['0','1','2']);
  assert.deepEqual(run('{42 False} {} while'), [42]);
});
test('when and while respect captured bindings and compose with each', () => {
  assert.deepEqual(run('3 -> limit; 0 {dup; < limit} {+ 1} while'), [3]);
  assert.deepEqual(run('0 [1 2 3 4] {dup; % 2 == 0; {+} {drop} if} each'), [6]);
  const output=[],vm=new VM({output:s=>output.push(s)});
  vm.evaluate('[1 2 3 4] {dup; % 2 == 0; {dup print} when; drop} each');
  assert.deepEqual(output,['2','4']);
});
test('while validates quotations and condition results', () => {
  for(const source of ['1 {} while','{False} 1 while']) assert.throws(()=>run(source), /Expected quotation/);
  assert.throws(()=>run('{} {} while'), /underflow/);
  assert.throws(()=>run('{1} {} while'), /Expected boolean/);
  assert.throws(()=>run('{True} {missing} while'), /Unknown word/);
  assert.throws(()=>run('{missing} {} while'), /Unknown word/);
});
test('while is iterative, bounded by step budget, and allows VM reuse', () => {
  const vm=new VM({maxDepth:4});
  assert.deepEqual(vm.evaluate('0 {dup; < 1000} {+ 1} while'), [1000]);
  const bounded=new VM({maxSteps:30});
  assert.throws(()=>bounded.evaluate('{True} {} while'), /step limit/);
  assert.deepEqual(bounded.evaluate('42'), [42]);
});
test('++ concatenates lists and accepts sections and compact syntax', () => {
  for (const source of ['[1 2] ++ [3 4]', '[1 2] [3 4] (++)', '[1 2]; ++ [3 4]', '[3 4]; [1 2] ++'])
    assert.deepEqual(run(source), [[1,2,3,4]],source);
  assert.deepEqual(run('[1]++[2]++[3]'), [[1,2,3]]);
  assert.deepEqual(run('[] ++ []'), [[]]);
  assert.deepEqual(run('[[1]] ++ [[2]]'), [[[1],[2]]]);
  assert.deepEqual(run('[1] ++ [2] == [1 2]'), [true]);
  assert.deepEqual(run('([1] ++ [2]) length'), [2]);
});
test('++ preserves inputs, rejects non-lists, and leaves compose unchanged', () => {
  assert.deepEqual(run('[1 2] -> xs; xs ++ [3]; xs'), [[1,2,3],[1,2]]);
  assert.deepEqual(run('[1] [2] concat'), [[1,2]]);
  assert.deepEqual(run('3 {+ 1} {* 2} compose call'), [8]);
  for(const source of ['1 ++ [2]', '[1] ++ 2', '{} ++ {}'])
    assert.throws(()=>run(source), /Expected vector/,source);
});
test('each runs in list order and retains quotation results', () => {
  const output=[],vm=new VM({output:s=>output.push(s)});
  assert.deepEqual(vm.evaluate('99 [1 2 3] {print} each'), [99]);
  assert.deepEqual(output,['1','2','3']);
  assert.deepEqual(vm.evaluate('[] {missing} each'), []);
  assert.deepEqual(vm.evaluate('[1 2] {dup} each'), [1,1,2,2]);
  assert.deepEqual(vm.evaluate('[1 2] {drop} each'), []);
});
test('each shares the caller stack while supporting captured bindings', () => {
  const output=[],vm=new VM({output:s=>output.push(s)});
  vm.evaluate('10 -> offset; [1 2] {(_ + offset) print} each');
  assert.deepEqual(output,['11','12']);
  assert.deepEqual(run('99 [1 2] {swap} each'), [1,2,99]);
  assert.throws(()=>run('1 {print} each'), /Expected vector/);
  assert.throws(()=>run('[1] 2 each'), /Expected quotation/);
  assert.throws(()=>new VM({maxSteps:5}).evaluate('[1 2 3] {dup} each'), /step limit/);
});
test('each can fold one or several accumulators on the shared stack', () => {
  assert.deepEqual(run('0 [1 2 3] {+} each'), [6]);
  assert.deepEqual(run('99 0 [1 2 3] {+} each'), [99,6]);
  assert.deepEqual(run('0 0 [1 2 3] {-> sum count x; sum + x; count + 1} each'), [6,3]);
  assert.deepEqual(run('10 [] {missing} each'), [10]);
  assert.deepEqual(run('0 [[1 2] [3]] {{+} each} each'), [6]);
});
test('map and filter retain shared state and collect only the top result', () => {
  assert.deepEqual(run('0 [1 2 3] {+; dup} map'), [6,[1,3,6]]);
  assert.deepEqual(run('0 [1 2 3 4] {-> total x; total + x; x % 2 == 0} filter'), [10,[2,4]]);
  assert.deepEqual(run('[1 2] {dup} map'), [1,2,[1,2]]);
  assert.deepEqual(run('99 [] {} map'), [99,[]]);
  assert.deepEqual(run('99 [] {} filter'), [99,[]]);
});
test('fold can update extra state on the shared stack', () => {
  assert.deepEqual(run('0 [1 2 3] 0 {-> count acc x; count + 1; acc + x} fold'), [3,6]);
  assert.deepEqual(run('99 [] 10 {} fold'), [99,10]);
  for(const source of ['[1] {drop} map','[1] {drop} filter','[1] 0 {drop drop} fold'])
    assert.throws(()=>run(source), /underflow/);
});
test('each propagates errors and stops before the next element', () => {
  const output=[],vm=new VM({output:s=>output.push(s)});
  assert.throws(()=>vm.evaluate('[1 0 2] {dup print; 10 /} each'), /Division by zero/);
  assert.deepEqual(output,['1','0']);
});
test('semicolon separates expressions without clearing the stack', () => {
  assert.deepEqual(run('5; 4 +'), [9]);
  assert.deepEqual(run('5;4-;'), [-1]);
  assert.deepEqual(run('3 4 5; + (*)'), [23]);
  assert.deepEqual(run('5; + 4; * 2'), [18]);
  assert.deepEqual(run(';;1;;2;;'), [1,2]);
  assert.deepEqual(run('1;-2'), [1,-2]);
  assert.deepEqual(run('[5; 4 +]'), [[9]]);
});
test('arrow consumes values and binds variables in source order', () => {
  assert.deepEqual(run('99 3 4 5 -> x y z; x y z'), [99,3,4,5]);
  assert.deepEqual(run('3 4 5->x y z;x + y * z'), [23]);
  assert.deepEqual(run('3 -> mut x; x := x + 1; x'), [4]);
  assert.deepEqual(run('5; 4 + -> result; result'), [9]);
});
test('assignments work in functions, lists and grouped expressions', () => {
  const p=compile('build = 3 4 5 -> x y z; [x y z]\nn next = n + 1 -> result; result');
  assert.deepEqual(run('build 5 next',p.definitions), [[3,4,5],6]);
  assert.deepEqual(run('[3 4 -> x y; x * y]'), [[12]]);
  assert.deepEqual(run('(3 -> x; x) + 2'), [5]);
});
test('nested scopes shadow variables without leaking bindings', () => {
  assert.deepEqual(run('3 -> x; (4 -> x; x) x'), [4,3]);
  assert.deepEqual(run('3 -> x; [4 -> x; x] x'), [[4],3]);
  assert.deepEqual(run('3 -> x; {4 -> x; x} call x'), [4,3]);
  assert.throws(()=>run('(4 -> local; local) local'), /Unknown word: local/);
});
test('quotations capture assignment values and keep call-local rebinding', () => {
  assert.deepEqual(run('3 -> x; {x} -> q; (4 -> x; q call x)'), [3,4]);
  assert.deepEqual(run('3 -> x; {x + 1 -> x; x} -> q; q call q call x'), [4,4,3]);
});
test('VM globals persist between evaluations and rollback on failure', () => {
  const vm=new VM({...compile('readx = x\nlocal = 9 -> x; x')});
  assert.deepEqual(vm.evaluate('3 -> mut x;'), []);
  assert.deepEqual(vm.evaluate('readx local x'), [3,9,3]);
  assert.throws(()=>vm.evaluate('x := 4; 8 -> fresh; missing'), /Unknown word/);
  assert.deepEqual(vm.evaluate('x'), [3]);
  assert.throws(()=>vm.evaluate('fresh'), /Unknown word/);
});
test('invalid assignments fail before consuming or changing bindings', () => {
  for (const s of ['3 -> mut', '3 -> mut;', '3 ->;', '3 -> x x;', '3 -> dup;'])
    assert.throws(()=>parseExpression(s), LanguageError, s);
  const vm=new VM(),stack=[3];
  assert.throws(()=>vm.evaluate('-> x y;', stack), /need 2, have 1/);
  assert.deepEqual(stack,[3]);
  assert.equal(vm.globals.size,0);
});
test('four requested operator forms', () => {
  for (const source of ['3 2 (+)', '3 (+ 2)', '3 (2 +)', '3 + 2'])
    assert.deepEqual(run(source), [5], source);
});
test('left and right sections retain operand order', () => {
  assert.deepEqual(run('10 3 (-)'), [7]);
  assert.deepEqual(run('10 (- 3)'), [7]);
  assert.deepEqual(run('10 (3 -)'), [-7]);
  assert.deepEqual(run('10 3; (_1 - _)'), [7]);
  assert.deepEqual(run('10 3 { _1 - _ } call'), [7]);
});
test('operator precedence, associativity, and adjacent tokens', () => {
  assert.deepEqual(run('3+2*4'), [11]);
  assert.deepEqual(run('(3+2)*4'), [20]);
  assert.deepEqual(run('20-3-2'), [15]);
  assert.deepEqual(run('2^3^2'), [512]);
  assert.deepEqual(run('3+2==5 and 8%3==2'), [true]);
  assert.deepEqual(run('3 + 2; 9'), [5,9]);
  assert.deepEqual(run('99; 3 + 2'), [99,5]);
});
test('function calls bind tighter than binary operators', () => {
  const p=compile('x square = x * x\nx inc = x + 1');
  assert.deepEqual(run('3 + 2 square',p.definitions), [7]);
  assert.deepEqual(run('(3 square) + (2 square)',p.definitions), [13]);
  assert.deepEqual(run('3 + 2 inc square',p.definitions), [12]);
  assert.deepEqual(run('(3 + 2) square',p.definitions), [25]);
  assert.deepEqual(run('3 square + 2 square',p.definitions), [13]);
  const output=[];
  assert.deepEqual(new VM({output:s=>output.push(s)}).evaluate('(3 + 2) print'), []);
  assert.deepEqual(output,['5']);
});
test('semicolons separate adjacent values from binary expressions', () => {
  const p=compile('n next = n; n + 1\nn list = [n; n + 1]');
  assert.deepEqual(run('5 next',p.definitions), [5,6]);
  assert.deepEqual(run('5 list',p.definitions), [[5,6]]);
});
test('binary operands accept zero-input single-output functions and groups', () => {
  const p=compile('one = 1\ntwo = 2\nx square = x * x');
  assert.deepEqual(run('one + two',p.definitions), [3]);
  assert.deepEqual(run('(3 square) + 2',p.definitions), [11]);
  assert.deepEqual(run('(1 drop 4) * 2'), [8]);
  assert.deepEqual(run('100; one + two',p.definitions), [100,3]);
});
test('binary operands cannot borrow from the outer stack or each other', () => {
  const p=compile('x inc = x + 1\nborrow = drop 1 2');
  for(const source of ['99; inc + 1','99 88; borrow + 1','99; dup + 1','99; 1 + drop','99; (drop 1) + 2']) {
    assert.throws(()=>run(source,p.definitions), /underflow/,source);
  }
  const stack=[99];
  assert.throws(()=>new VM().evaluate('1 + drop',stack), /underflow/);
  assert.deepEqual(stack,[99]);
});
test('each binary operand must produce exactly one value', () => {
  const p=compile('none =\npair = 1 2');
  for (const source of ['none + 1','pair + 1','1 + none','1 + pair','(1 2) + 3','3 + ()'])
    assert.throws(()=>run(source,p.definitions), /must consume 0 and produce 1 value/,source);
  assert.deepEqual(run('[1 2] == [1 2]'), [true]);
});
test('indexed references bind before missing operands, independently of precedence', () => {
  assert.deepEqual(run('2 3 4; (_2 + _1 * _)'), [14]);
  assert.deepEqual(run('2 3 4 { _2 + _1 * _ } call'), [14]);
  assert.deepEqual(run('2 3; (+ _)'), [5]);
  assert.deepEqual(run('10 3; (_ -)'), [-7]);
});
test('expression binds all missing operands before evaluating either side', () => {
  const output=[]; const vm=new VM({output:s=>output.push(s)});
  assert.throws(()=>vm.evaluate('10 (("must not print" print 1) + (*))'), /underflow/);
  assert.deepEqual(output,[]);
  assert.deepEqual(run('10 (dup; _ + 1)'), [10,11]);
  assert.deepEqual(run('10 { dup; _ + 1 } call'), [10,11]);
  assert.deepEqual(run('100 200 10 20 (swap; _1 + _)'), [100,200,30]);
});
test('nested expressions share placeholders while quotations remain separate', () => {
  assert.deepEqual(run('10 20; (_1 (1 + _))'), [10,21]);
  assert.deepEqual(run('3 (+ 2) (* 4)'), [20]);
  assert.deepEqual(run('3 ((+ 2) * 4)'), [20]);
  assert.deepEqual(run('10 { { _ + 1 } } call call'), [11]);
  assert.deepEqual(run('10; (_ { _ + 1 }) call'), [11]);
});
test('quotation placeholders are consumed at call time, not creation', () => {
  const values=run('{ _ + _ }'); assert.equal(values.length,1);
  assert.deepEqual(run('{ _ + 1 } 10 swap call'), [11]);
  assert.deepEqual(run('[1 2 3 4] {_ % 2 == 0} filter'), [[2,4]]);
  assert.deepEqual(run('[1 2 3] 0 {_1 + _} fold'), [6]);
});
test('scope syntax errors and underflow are controlled', () => {
  for (const source of ['_', '3 +', '+ 3', '(1 + * 2)', '(_', '(1]', '[(_)]'])
    assert.throws(()=>run(source),LanguageError,source);
  assert.throws(()=>run('3; (_1 + _)'), /need 2, have 1/);
  assert.deepEqual(run('()'),[]);
});
test('quotation factorial with sections', () => {
  const p=compile('fact = {dup (== 0) { drop 1 } { dup (- 1) fact call (*) } if}');
  assert.deepEqual(run('10 fact call',p.definitions),[3628800]);
  assert.deepEqual(run('0 fact call',p.definitions),[1]);
});
test('infix arithmetic and operand order', () => {
  assert.deepEqual(run('(10 - 3) * 2 / 7'), [2]);
  assert.deepEqual(run('(-2 ^ 3) (2 <= 3 and True)'), [-8, true]);
});
test('stack permutations', () => {
  assert.deepEqual(run('1 2 3 rot'), [2,3,1]);
  assert.deepEqual(run('1 2 over swap dup drop'), [1,1,2]);
});
test('recursive literal patterns', () => {
  const { definitions } = compile('0 fact = 1\nn fact = n * ((n - 1) fact)');
  assert.deepEqual(run('8 fact', definitions), [40320]);
});
test('multiple arguments bind left to right', () => {
  assert.deepEqual(run('10 3 sub', compile('a b sub = a - b').definitions), [7]);
});
test('string, boolean, wildcard patterns and clause order', () => {
  const p = compile('"yes" choose = True\n_ choose = False');
  assert.deepEqual(run('"yes" choose "no" choose',p.definitions),[true,false]);
});
test('captured environment survives function return', () => {
  const p = compile('n add = { _ + n }');
  assert.deepEqual(run('10 7 add call',p.definitions),[17]);
  assert.deepEqual(run('1 2 add 3 add compose call',p.definitions),[6]);
});
test('if evaluates only selected branch', () => {
  assert.deepEqual(run('True { 42 } { missing } if'),[42]);
});
test('functional collection operators', () => {
  assert.deepEqual(run('1 10 range { _ % 2 == 0 } filter { dup (*) } map 0 { + } fold'),[220]);
  assert.deepEqual(run('3 1 range'),[[3,2,1]]);
  assert.deepEqual(run('[] { dup (*) } map [] 9 { + } fold'),[[],9]);
});
test('list operations preserve shared values', () => {
  assert.deepEqual(run('[1 2] dup tail'),[[1,2],[2]]);
  assert.deepEqual(run('0 [1 2] cons [3] concat'),[[0,1,2,3]]);
  assert.deepEqual(run('[[1] [2]] == [[1] [2]]'),[true]);
});
test('list bodies execute commands and collect the entire resulting stack', () => {
  assert.deepEqual(run('[1 + 2; 4 dup]'), [[3,4,4]]);
  assert.deepEqual(run('[1 2 swap]'), [[2,1]]);
  assert.deepEqual(run('[1 drop] []'), [[],[]]);
  assert.deepEqual(run('[3 2 (+) 10; (_ * 2)]'), [[5,20]]);
});
test('list evaluation uses an empty stack without consuming outer values', () => {
  assert.deepEqual(run('99 [1 2 (+)]'), [99,[3]]);
  const stack=[99];
  assert.throws(()=>new VM().evaluate('[dup]',stack), /underflow/);
  assert.deepEqual(stack,[99]);
  assert.throws(()=>run('99 [(+ 1)]'), /underflow/);
});
test('nested lists have independent stacks and do not flatten results', () => {
  assert.deepEqual(run('[1 [2 + 3] 4]'), [[1,[5],4]]);
  assert.deepEqual(run('[1 3 range]'), [[[1,2,3]]]);
  assert.throws(()=>run('[1 [dup]]'), /underflow/);
});
test('list commands can access lexical bindings and user functions', () => {
  const p=compile('x square = x * x\nn build = [n; n square; n + 1]');
  assert.deepEqual(run('5 build',p.definitions), [[5,25,6]]);
  assert.deepEqual(run('[2 3] { 10 (+) } map'), [[12,13]]);
});
test('lists can return captured quotations or execute them inside the list', () => {
  const p=compile('n adderList = [{ _ + n }]');
  assert.deepEqual(run('10 7 adderList head call',p.definitions), [17]);
  assert.deepEqual(run('[3 {_ + 2} call]'), [[5]]);
  assert.deepEqual(run('10 { [3; (_ + 1)] _ } call'), [10,[4],3]);
});
test('list evaluation preserves effects and shares execution limits', () => {
  const output=[],vm=new VM({output:s=>output.push(s)});
  assert.deepEqual(vm.evaluate('["hello" print 42]'), [[42]]);
  assert.deepEqual(output,['hello']);
  assert.throws(()=>new VM({maxSteps:3}).evaluate('[1 2 3]'), /step limit/);
  assert.throws(()=>new VM({...compile('loop = [loop]'),maxDepth:10}).evaluate('loop'), /depth limit/);
  assert.throws(()=>vm.evaluate('[1 / 0]', [], 'list.hst'), /list.hst:1:4: Division by zero/);
});
test('dip hides and restores top value', () => assert.deepEqual(run('2 99 { + 3 } dip'),[5,99]));
test('comments and escaped strings', () => assert.deepEqual(run('"a\\n--b" -- comment\n 2'),['a\n--b',2]));
test('multiline declaration and annotation', () => {
  const p=compile('square : num -> num\nx square =\n  x * x\nmain = 5 square');
  assert.equal(p.signatures.get('square'),'num -> num');
  assert.deepEqual(run('main',p.definitions),[25]);
});
test('syntax errors have source locations', () => {
  assert.throws(()=>parseExpression('{ 1','broken.hst'),/broken.hst:1:1: Missing/);
  for (const s of [']','"oops','[1 }']) assert.throws(()=>parseExpression(s),LanguageError);
  assert.throws(()=>run('[1 +]'), /underflow/);
  for (const s of ['x x f = x','0 f = 1\nf = 2','dup = 2','f : num','[x x] f = x']) assert.throws(()=>compile(s),LanguageError);
});
test('runtime errors are controlled', () => {
  for (const s of ['(+)', '1 / 0', '"a" + 2', '1 { 2 } { 3 } if', '[] head', '[1] { drop } map', '[1] { 1 } filter', '1e999', '2 ^ 9999', '1 call'])
    assert.throws(()=>run(s),LanguageError,s);
  assert.throws(()=>run('1 only',compile('0 only = 1').definitions),/No matching pattern/);
  assert.throws(()=>run('missing'),/Unknown word/);
});
test('execution limits and VM reuse', () => {
  const vm=new VM({...compile('loop = loop'),maxDepth:20});
  assert.throws(()=>vm.evaluate('loop'),/depth limit/);
  assert.deepEqual(vm.evaluate('42'),[42]);
  assert.throws(()=>new VM({maxSteps:3}).evaluate('1 2 3 4'),/step limit/);
});
test('redefinition is atomic and leaves prior map intact', () => {
  const old=compile('f = 1').definitions;
  const next=compile('f = 2', '<new>',old).definitions;
  assert.deepEqual(run('f',old),[1]); assert.deepEqual(run('f',next),[2]);
  assert.throws(()=>compile('f = 3\nbad', '<new>',old));
  assert.deepEqual(run('f',old),[1]);
});
test('demo output', () => {
  const file=new URL('../examples/demo.hst',import.meta.url),output=[];
  new VM({...compile(readFileSync(file,'utf8')),output:s=>output.push(s)}).evaluate('main');
  assert.deepEqual(output,['Squares:','[1, 4, 9, 16, 25]','Factorial 6:','720','Even numbers in 1..10:','[2, 4, 6, 8, 10]','Sum 1..100:','5050','Closure (10 + 7):','17']);
});
const cli = (args=[],input) => spawnSync(process.execPath,[fileURLToPath(new URL('../migration/v037-cli.mjs',import.meta.url)),...args],{input,encoding:'utf8'});
test('CLI eval and errors use meaningful exit status', () => {
  const ok=cli(['--eval','2 + 3']); assert.equal(ok.status,0); assert.equal(ok.stdout.trim(),'[5]');
  const bad=cli(['--eval','drop']); assert.equal(bad.status,1); assert.match(bad.stderr,/underflow/);
  assert.equal(cli(['--eval']).status,1);
  const list=cli(['--eval','99 [1 + 2; 4 dup]']);
  assert.equal(list.status,0); assert.equal(list.stdout.trim(),'[99, [3, 4, 4]]');
  const nested=cli(['--eval','3 4 5 (+ (*))']);
  assert.equal(nested.status,0); assert.equal(nested.stdout.trim(),'[23]');
  const binding=cli(['--eval','3 4 5 -> x y z; x + y * z']);
  assert.equal(binding.status,0); assert.equal(binding.stdout.trim(),'[23]');
});
test('REPL retains variables and rolls them back with the failed line', () => {
  const result=cli([], '3 -> mut x\nx\nx := 4; missing\n:clear\nx\n:clear\n5; 4 +\n:q\n');
  assert.equal(result.status,0);
  assert.equal((result.stdout.match(/\[3\]/g)||[]).length,2);
  assert.match(result.stdout,/Unknown word: missing/);
  assert.match(result.stdout,/\[9\]/);
});
test('missing operands bind across the entire nested binary expression', () => {
  assert.deepEqual(run('3 4 5 (+ (*))'), [23]);
  assert.deepEqual(run('99 3 4 5 (+ (*))'), [99,23]);
  assert.deepEqual(run('20 9 2 (- (-))'), [13]);
  assert.deepEqual(run('2 3 4 5 ((+) * (+))'), [45]);
  assert.deepEqual(run('3 4 5; (_2 + (_1 * _))'), [23]);
  assert.deepEqual(run('3 4 5; (+ ((_1 * _)))'), [23]);
});
test('missing operands also work in unparenthesized expressions', () => {
  assert.deepEqual(run('3 4; 5 + (*)'), [17]);
  assert.deepEqual(run('10; 3 -'), [-7]);
});
test('command sequences provide their own values before evaluating sections', () => {
  assert.deepEqual(run('(3 4 5 (+ (*)))'), [23]);
  assert.deepEqual(run('3 + (4 (+ 2))'), [9]);
  assert.deepEqual(run('[3 4 5 (+ (*))]'), [[23]]);
  assert.deepEqual(run('3 4 5 {+ (*)} call'), [23]);
  assert.throws(()=>run('3 4 5 [(+ (*))]'), /underflow/);
});
test('nested expression binding checks total arity without partially popping', () => {
  const stack=[3,4];
  assert.throws(()=>new VM().evaluate('(+ (*))',stack), /need 3, have 2/);
  assert.deepEqual(stack,[3,4]);
});
test('REPL definitions, block clauses and stack rollback', () => {
  const result=cli([], 'x square = x * x\n5 square\n(/ 0)\n:stack\n:clear\n:{\n0 f = 10\nn f = n\n:}\n0 f\n:quit\n');
  assert.equal(result.status,0); assert.match(result.stdout,/Division by zero/);
  assert.equal((result.stdout.match(/\[25\]/g)||[]).length,2);
  assert.match(result.stdout,/\[10\]/);
});
test('file execution, syntax check, eval with definitions, and REPL load', () => {
  const path=fileURLToPath(new URL('../examples/demo.hst',import.meta.url));
  assert.equal(cli(['--check',path]).status,0);
  assert.equal(cli([path,'--stack']).stdout.trim().split('\n').at(-1),'[]');
  assert.equal(cli([path,'--eval','5 factorial']).stdout.trim(),'[120]');
  assert.match(cli([],`:load ${path}\n5 square\n:q\n`).stdout,/\[25\]/);
  const fizz=cli([fileURLToPath(new URL('../examples/fizzbuzz.hst',import.meta.url))]);
  assert.equal(fizz.status,0); assert.match(fizz.stdout,/"1", "2", "Fizz", "4", "Buzz"/);
});
