import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {compile,VM,parseExpression} from '../migration/v048-adapter.mjs';
import {migrateSource,migrateExpression} from '../migration/v037.mjs';
const vm=(source='',options={})=>new VM({...compile(source),warning:()=>{},...options});

test('prefix application executes arguments left to right, then the head, across separators',()=>{
  const output=[],v=vm(`x = print "x"
y = print "y"
f = print "f"
x2 = print "x2"
y2 = print "y2"
f2 = print "f2"`,{output:x=>output.push(x)});
  v.evaluate('f x y; f2 x2 y2');assert.deepEqual(output,['x','y','f','x2','y2','f2']);
  output.length=0;v.evaluate('f x y, f2 x2 y2');assert.deepEqual(output,['x','y','f','x2','y2','f2']);
});

test('all heads including literals, variables and parenthesized expressions execute last',()=>{
  const v=vm();assert.deepEqual(v.evaluate('1 2 3'),[2,3,1]);
  assert.deepEqual(v.evaluate('1, 2, 3'),[1,2,3]);
  assert.deepEqual(v.evaluate('1, 2 -> x y; x y'),[2,1]);
  assert.deepEqual(v.evaluate('(1 + 2) 4 5'),[4,5,3]);
  assert.deepEqual(v.evaluate('[1 2 3]'),[[2,3,1]]);
  assert.deepEqual(v.evaluate('#(1 "x" True)')[0].items,['x',true,1]);
});

test('commas share captures while semicolons start new clauses',()=>{
  const v=vm();assert.deepEqual(v.evaluate('3 4; _, _'),[4,3,3]);
  assert.deepEqual(v.evaluate('3, 4; _, _'),[3,4,4]);
  assert.deepEqual(v.evaluate('3, 4; _; _'),[3,4]);
  assert.deepEqual(v.evaluate('3, 4; _1, _'),[3,4]);
  assert.deepEqual(v.evaluate('3, 4; $, $'),[3,4,4,4]);
  assert.throws(()=>v.evaluate('3; _, $'),/Cannot mix/);
});

test('captures remain shared through parentheses, lists and records',()=>{
  const v=vm();assert.deepEqual(v.evaluate('3; [_], _'),[[3],3]);
  assert.deepEqual(v.evaluate('3; (_), _'),[3,3]);
  assert.deepEqual({...v.evaluate('3; {x: _}, _')[0].fields},{x:3});
  assert.deepEqual(v.evaluate('3, 4; [_; _]'),[3,[4]]);
});

test('function and local definitions use name first, with prefix patterns',()=>{
  const v=vm(`data pair = Pair int string
pick (Pair n s) = n
sum xs = 0; each xs {+}
sum2 xs = 0, xs; each {+}
local x =
  double y = y * 2
  double x`);
  assert.deepEqual(v.evaluate('sum [1, 2, 3]; sum2 [1, 2, 3]; local 4; pick (Pair 5 "s")'),[6,6,8,5]);
});

test('both abs forms and normal infix precedence work',()=>{
  const v=vm(`abs = $ < 0; when {0 -}
abs2 = when ($ < 0) {0 -}
square n = n * n`);
  assert.deepEqual(v.evaluate('abs -5; abs2 -6; abs 7; square 3 + 1'),[5,6,7,10]);
  assert.deepEqual(v.evaluate('3, 4, 5; + *'),[23]);
});

test('attached field accesses stay atomic and standalone accessors apply in prefix order',()=>{
  const v=vm();assert.deepEqual(v.evaluate('{x: 3} -> r; r.x; .x r'),[3,3]);
  assert.deepEqual(v.evaluate('#(3, "x") -> t; t.0; .1 t'),[3,'x']);
  assert.deepEqual(v.evaluate('{x: {y: 4}}.x.y'),[4]);
});

test('prefix ADTs, type applications, classes, instances and related constraints',()=>{
  const v=vm(`data box 'a = Box 'a
class unpack 'c where
  type item
  unpack : 'c -> item
instance unpack (box 'a) where
  item : 'a
  unpack (Box x) = x
unwrap : unpack 'c 'a => 'c -> 'a
unwrap = unpack
instance add 'a => add (box 'a) where
  + (Box x) (Box y) = Box (x + y)`);
  assert.deepEqual(v.evaluate('unwrap (Box 3); unwrap (Box True)'),[3,true]);
  assert.deepEqual(v.evaluate('(Box 2) + (Box 3)')[0].fields,[5]);
  assert.match(v.infer('Box 3'),/\(box int\)/);
  assert.match(v.infer('unwrap'),/^unpack /);
});

test('prefix effects, effect-row annotations and multiple handler results',()=>{
  const output=[],v=vm(`effect yield 'a: 'a ->
effect ask: -> int
emit : int -> / {yield int}
emit = yield
main : -> int string / {io}
main = handle {emit 1; ask; "done"} {yield: {-> x k; print x; resume k}, ask: {-> k; resume 42 k}}`,{output:x=>output.push(x)});
  assert.deepEqual(v.evaluate('main'),[42,'done']);assert.deepEqual(output,['1']);
  assert.match(v.infer('yield 1'),/\{yield int\}/);
});

test('prefix constructor patterns work in case, arrow and list Push patterns',()=>{
  const v=vm(`data option 'a = None | Some 'a
get = case
  -> Some x then x
  -> None then 0
last = case
  -> Push xs x then x
  -> [] then 0`);
  assert.deepEqual(v.evaluate('get (Some 3); get None; last [1, 2, 3]'),[3,0,3]);
  assert.deepEqual(v.evaluate('Some 8 -> Some x; x'),[8]);
});

test('mutable updates and comma-separated declarations keep their scope',()=>{
  const v=vm();assert.deepEqual(v.evaluate('0 -> mut x, x := 3, x ! (+ 2), x'),[5]);
});

test('value-headed sequences warn without changing evaluation, callable heads do not',()=>{
  const warnings=[],v=vm('id x = x',{warning:w=>warnings.push(w)});
  assert.deepEqual(v.evaluate('3 4'),[4,3]);assert.equal(warnings.length,1);assert.equal(warnings[0].code,'W001');assert.equal(warnings[0].col,1);
  warnings.length=0;v.evaluate('3, 4; _, _');assert.equal(warnings.length,0);
  warnings.length=0;v.evaluate('1, 2 -> x y; x y');assert.equal(warnings.length,1);
  warnings.length=0;v.evaluate('id 3');assert.equal(warnings.length,0);
  assert.equal(compile('f x y = x y').warnings.length,1);
  assert.equal(compile('f x y = x, y').warnings.length,0);
});

test('CLI and REPL report nonfatal warnings and accept prefix declarations',()=>{
  const cli=spawnSync(process.execPath,['cli.mjs','--eval','3 4'],{cwd:new URL('..',import.meta.url),encoding:'utf8',windowsHide:true});
  assert.equal(cli.status,0);assert.match(cli.stdout,/\[4, 3\]/);assert.match(cli.stderr,/Warning \[W001\]/);
  const repl=spawnSync(process.execPath,['cli.mjs'],{cwd:new URL('..',import.meta.url),input:'double x = x * 2\ndouble 3\n1 2\n:q\n',encoding:'utf8',windowsHide:true});
  assert.equal(repl.status,0);assert.match(repl.stdout,/\[6\]/);assert.match(repl.stderr,/Warning/);
});

test('explicit migration retains old sequencing and function declarations',()=>{
  const old='x double = x * 2\nmain = 3 double; 4 double';
  const source=migrateSource(old).source;
  assert.match(source,/double x =/);assert.deepEqual(vm(source).evaluate('main'),[6,8]);
  assert.deepEqual(vm().evaluate(migrateExpression('3 4; _ _')),[3,4,4]);
});


test('REPL updates do not repeat warnings from unchanged definitions',()=>{
  const first=compile('f x y = x y');assert.equal(first.warnings.length,1);
  const second=compile('g = 1','<repl>',first.definitions);assert.equal(second.warnings.length,0);
  const third=compile('f x y = x y','<repl>',second.definitions);assert.equal(third.warnings.length,1);
});
