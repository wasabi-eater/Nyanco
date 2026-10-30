import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { VM, compile, StaticTypeError } from '../migration/v037-adapter.mjs';

test(': annotates types and :: constructs lists with sections and left associativity',()=>{
  const vm=new VM(compile('singleton : a -> [a]\nx singleton = [] :: x'));
  assert.deepEqual(vm.evaluate('3 singleton'),[[3]]);
  for(const source of ['[] :: 1 :: 2','[1] 2 (::)','[1] (:: 2)','2 ([1] ::)','[1]::2'])
    assert.deepEqual(vm.evaluate(source),[[1,2]],source);
  assert.deepEqual(vm.evaluate('[1] ++ [2] :: 1 + 2'),[[1,2,3]]);
  assert.deepEqual(vm.evaluate('([] :: 1) == [1]'),[true]);
  assert.throws(()=>vm.evaluate('True :: [1]'),StaticTypeError);
  assert.throws(()=>vm.evaluate('1 :: 2'),StaticTypeError);
  assert.throws(()=>compile('x :: int -> int\nx f = x'));
});

test('empty and Push patterns infer recursive homogeneous list functions',()=>{
  const program=compile('sum : [int] -> int\n[] sum = 0\n(xs :: x) sum = x + (xs sum)');
  const vm=new VM(program);
  assert.deepEqual(vm.evaluate('[] sum; [1 2 3] sum'),[0,6]);
  assert.throws(()=>vm.evaluate('[True] sum'),StaticTypeError);
  const size=compile('[] size = 0\n(xs :: _) size = 1 + (xs size)');
  assert.equal(size.types.get('size'),"'a1 num => ..s ['a] -- ..s 'a1 / {exn}");
  assert.deepEqual(new VM(size).evaluate('[True False] size'),[2]);
});

test('list patterns support exact length, nesting, wildcards and clause order',()=>{
  const program=compile('[] label = "empty"\n[0] label = "zero"\n[x] label = "one"\n([] :: x :: y) label = "two"\n(_ :: _) label = "many"\n[[x] [y]] unpack = x y');
  const vm=new VM(program);
  assert.deepEqual(vm.evaluate('[] label; [0] label; [4] label; [1 2] label; [1 2 3] label'),['empty','zero','one','two','many']);
  assert.deepEqual(vm.evaluate('[[3] [4]] unpack'),[3,4]);
  assert.throws(()=>vm.evaluate('[[3] []] unpack'),/No matching pattern/);
  assert.throws(()=>compile('[x x] f = x'),/Duplicate pattern/);
  assert.throws(()=>compile('(x :: x) f = x'),/Duplicate pattern/);
  assert.throws(()=>compile('[1 True] f = 0'),StaticTypeError);
  assert.throws(()=>compile('(1 :: x) f = x'),StaticTypeError);
  for(const source of ['(x ::) f = x','(:: xs) f = xs','[x f = x'])assert.throws(()=>compile(source));
});

test('list destructuring cooperates with ADTs and binds immutable locals',()=>{
  const vm=new VM(compile('data Maybe a = Nothing | Just a\n(_ :: (x Just)) first = x\n([x] Just) single = x\n(xs :: x) splitPattern = x xs'));
  assert.deepEqual(vm.evaluate('[(7 Just)] first; [9] Just single; [1 2 3] splitPattern'),[7,9,3,[1,2]]);
  assert.throws(()=>compile('(_ :: x) f = x := 2'),/immutable/);
  const program=compile('[] f = 0\n(_ :: x) f = x');
  assert.deepEqual(new VM({...program,checkTypes:false}).evaluate('[8] f; [] f'),[8,0]);
});

test(':: works with mutable updates and REPL dispatch uses : for annotations',()=>{
  const vm=new VM();
  assert.deepEqual(vm.evaluate('[2] -> mut xs; xs ! (:: 1); xs'),[[2,1]]);
  const result=spawnSync(process.execPath,['migration/v037-cli.mjs'],{cwd:new URL('..',import.meta.url),input:':{\nf : [int] -> int\n[] f = 0\n(_ :: x) f = x\n:}\n[] :: 1\nf\n:q\n',encoding:'utf8'});
  assert.equal(result.status,0);
  assert.doesNotMatch(result.stdout,/Error:/);
  assert.match(result.stdout,/\[\[1\]\]/);
  assert.match(result.stdout,/\[1\]/);
});
