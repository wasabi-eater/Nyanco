import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { VM, compile, StaticTypeError, builtinNames } from '../migration/v037-adapter.mjs';
const run=(source,program={})=>new VM(program).evaluate(source);
test('infers operator constraints without annotations',()=>{
  const p=compile('x square = x * x');
  assert.equal(p.types.get('square'),"'a mul => ..s 'a -- ..s 'a");
  assert.deepEqual(run('3 + 2 square',p),[7]);
});
test('principal stack effects support polymorphic definitions at independent types',()=>{
  const p=compile('x identity = x\ncopy = dup');
  assert.equal(p.types.get('identity'),"..s 'a -- ..s 'a");
  assert.equal(p.types.get('copy'),"..s 'a -- ..s 'a 'a");
  assert.deepEqual(run('3 identity True identity "x" identity',p),[3,true,'x']);
});
test('polymorphic quotation bindings retain value polymorphism',()=>{
  assert.deepEqual(run('{dup} -> copy; 3 copy call True copy call'),[3,3,true,true]);
  const vm=new VM();vm.evaluate('{dup} -> copy;');
  assert.deepEqual(vm.evaluate('3 copy call True copy call'),[3,3,true,true]);
});
test('shared stack combinators infer accumulators',()=>{
  assert.deepEqual(run('0 [1 2 3] {+} each'),[6]);
  assert.deepEqual(run('0 [1 2 3] {+; dup} map'),[6,[1,3,6]]);
  assert.deepEqual(run('[1 2 3] 0 {+} fold'),[6]);
  assert.deepEqual(run('0 [1 2 3 4] {-> total x; total + x; x % 2 == 0} filter'),[10,[2,4]]);
});
test('inference handles recursive functions, forward references, and mutual recursion',()=>{
  const p=compile('n fact = n * ((n - 1) fact)\n0 unused = 0');
  assert.match(p.types.get('fact'),/int/);
  const recursive=compile('0 fact = 1\nn fact = n * ((n - 1) fact)\n0 even = True\nn even = (n - 1) odd\n0 odd = False\nn odd = (n - 1) even');
  assert.deepEqual(run('6 fact 10 even 9 odd',recursive),[720,true,true]);
  assert.deepEqual(run('"prefix" 6 fact',recursive),['prefix',720]);
});
test('recursive quotation factorial is inferred',()=>{
  const p=compile('fact = {dup (== 0) {drop 1} {dup (- 1) fact call (*)} if}');
  assert.deepEqual(run('8 fact call',p),[40320]);
});
test('recursive candidates are rechecked and cannot change value types',()=>{
  for(const source of ['0 f = 1\nn f = True f','0 f = 1\nn f = [n] f'])
    assert.throws(()=>compile(source),StaticTypeError,source);
  const p=compile('use = 1 identity True identity\nx identity = x');
  assert.deepEqual(run('use',p),[1,true]);
});
test('type checks all clauses and unreachable quotation code',()=>{
  for(const source of ['0 f = 1\nn f = True','f = False {unknown} when','f = True {1} {"x"} if'])
    assert.throws(()=>compile(source),StaticTypeError,source);
});
test('homogeneous lists support inferred empty lists, nesting, and list commands',()=>{
  assert.deepEqual(run('[] ++ [1 2]'),[[1,2]]);
  assert.deepEqual(run('[1 + 2; 4 dup]'),[[3,4,4]]);
  assert.deepEqual(run('[[1] [2 3]]'),[[[1],[2,3]]]);
  for(const source of ['[1 True]','[1] ++ ["x"]','1 [True] cons','[[1] [True]]'])
    assert.throws(()=>run(source),StaticTypeError,source);
});
test('type errors are detected before print or any stack/global mutation',()=>{
  const output=[],vm=new VM({output:s=>output.push(s)}),stack=[99];
  vm.evaluate('3 -> x;');
  assert.throws(()=>vm.evaluate('"should not print" print 4 -> x; True + 1',stack),StaticTypeError);
  assert.deepEqual(output,[]);assert.deepEqual(stack,[99]);assert.equal(vm.globals.get('x'),3);
});
test('loop stack shapes are invariant, while accumulator loops remain supported',()=>{
  assert.deepEqual(run('0 {dup; < 3} {+ 1} while'),[3]);
  assert.deepEqual(run('10 True {+ 1} when'),[11]);
  for(const source of ['True {1} when','0 {dup; < 3} {1 2} while','[1 2] {dup} each','[1 2] {dup} map'])
    assert.throws(()=>run(source),StaticTypeError,source);
});
test('type annotations are checked, including polymorphism and stack signatures',()=>{
  assert.equal(compile('f : int -> int\nf = dup (*)').types.get('f'),"..s int -- ..s int");
  assert.deepEqual(run('3 4 add',compile('add : (int int) -> int\nadd = (+)')),[7]);
  assert.deepEqual(run('3 same',compile('same : a -> a\nx same = x')),[3]);
  for(const source of ['f : bool -> bool\nf = (+ 1)','f : a -> a\nf = (+ 1)','f : Nope -> int\nf = 1'])
    assert.throws(()=>compile(source),StaticTypeError,source);
});
test('annotation constraints survive declaration merges and restrict callers',()=>{
  const p=compile('id : int -> int\nx id = x');
  assert.throws(()=>run('True id',p),StaticTypeError);
  assert.throws(()=>compile('main = True id','next.nyan',p.definitions),StaticTypeError);
});
test('quotation annotation syntax supports lists and effects',()=>{
  const p=compile('f : [int] -> [int]\nf = {+ 1} map\ninc : () -> {int -> int}\ninc = {+ 1}\napply = call');
  assert.deepEqual(run('[1 2] f 3 {+ 1} apply',p),[[2,3],4]);
});
test('static binary checking preserves nested missing operands and separators',()=>{
  assert.deepEqual(run('3 4 5 (+ (*))'),[23]);
  assert.deepEqual(run('3 4 5 -> x y z; x + y * z'),[23]);
  assert.deepEqual(run('5; 4 +'),[9]);
  for(const source of ['99 dup + 1','(1 2) + 3','3 (_ + _)'])assert.throws(()=>run(source),StaticTypeError);
});
test('mutable updates are type stable and runtime failure keeps bindings intact',()=>{
  const vm=new VM();vm.evaluate('3 -> mut x');
  assert.throws(()=>vm.evaluate('x := True'),StaticTypeError);
  assert.throws(()=>vm.evaluate('x := 4; 1 / 0'),/Division by zero/);
  assert.deepEqual(vm.evaluate('x'),[3]);
});
test('type inference is read-only and works with every builtin',()=>{
  const vm=new VM();
  for(const name of builtinNames()) {
    // Operators require section syntax to denote their full stack effect.
    const expr=/^[+*/%^<>=-]/.test(name)||['and','or'].includes(name)?`(${name})`:name;
    assert.match(vm.infer(expr),/ -- /,name);
  }
  assert.equal(vm.infer('dup'),"..s 'a -- ..s 'a 'a");
  assert.equal(vm.globals.size,0);
});
test('source locations are included in static errors',()=>{
  assert.throws(()=>compile('main = 1 + True','bad.nyan'),/bad.nyan:1:10: Type error/);
});
test('global quotations do not hide dependencies on redefined functions',()=>{
  const vm=new VM(compile('f = 1'));vm.evaluate('{f} -> q;');
  assert.throws(()=>compile('g = (q call) + 1\nf = True','redefined.nyan',new Map(),{globals:vm.globals}),StaticTypeError);
});
test('global rebinding cannot invalidate already-checked functions',()=>{
  const vm=new VM(compile('f = 1\ng = f + 1'));
  assert.throws(()=>vm.evaluate('True -> f; g'),StaticTypeError);
  const second=new VM();second.evaluate('{} -> q;');
  second.definitions=compile('g = 1 q call','g.nyan',new Map(),{globals:second.globals}).definitions;
  assert.throws(()=>second.evaluate('{not} -> q; g'),StaticTypeError);
  assert.deepEqual(second.evaluate('g'),[1]);
});
test('CLI exposes inference, static checking, and error exit codes',()=>{
  const cli=(args,input)=>spawnSync(process.execPath,[fileURLToPath(new URL('../migration/v037-cli.mjs',import.meta.url)),...args],{input,encoding:'utf8'});
  const type=cli(['--type','dup']);assert.equal(type.status,0);assert.equal(type.stdout.trim(),"..s 'a -- ..s 'a 'a");
  const silent=cli(['--type','"NOT_PRINTED" print']);assert.equal(silent.status,0);assert.doesNotMatch(silent.stdout,/NOT_PRINTED/);
  const bad=cli(['--eval','"NOT_PRINTED" print 1 + True']);assert.equal(bad.status,1);assert.equal(bad.stdout,'');assert.match(bad.stderr,/Type error/);
  const path=fileURLToPath(new URL('../examples/demo.nyan',import.meta.url));
  const checked=cli(['--check',path]);assert.equal(checked.status,0);assert.match(checked.stdout,/Types OK/);assert.doesNotMatch(checked.stdout,/Squares:/);
  const types=cli(['--types',path]);assert.equal(types.status,0);assert.match(types.stdout,/factorial : \.\.s int -- \.\.s int/);
  const repl=cli([], 'x same = x\n:type same\n:type "NOT_PRINTED" print\n3 -> x;\nTrue -> x;\nx\n:q\n');
  assert.equal(repl.status,0);assert.match(repl.stdout,/\.\.s 'a -- \.\.s 'a/);assert.doesNotMatch(repl.stdout,/NOT_PRINTED/);assert.match(repl.stdout,/Type error/);assert.match(repl.stdout,/\[3\]/);
});
