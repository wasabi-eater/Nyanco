import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { VM, compile, format, StaticTypeError } from '../migration/v037-adapter.mjs';

const maybe='data Maybe a = Nothing | Just a';
const fromMaybe='fallback Nothing fromMaybe = fallback\n_ (value Just) fromMaybe = value';
const vmFor=source=>new VM(compile(source));

test('ADT constructors are polymorphic stack functions with readable values',()=>{
  const program=compile(maybe),vm=new VM(program);
  assert.equal(program.types.get('Just'),"..s 'a -- ..s ('a maybe)");
  assert.equal(program.types.get('Nothing'),"..s -- ..s ('a maybe)");
  assert.equal(format(vm.evaluate('99; 3 Just; True Just; Nothing')),'[99, (Just 3), (Just True), Nothing]');
  assert.equal(vm.infer('1 Just'),"..s -- ..s (int maybe)");
  assert.throws(()=>vm.evaluate('Just'),/underflow/);
});

test('constructor patterns bind fields and preserve fallback clause order',()=>{
  const vm=vmFor(`${maybe}\n${fromMaybe}`);
  assert.deepEqual(vm.evaluate('0 (42 Just) fromMaybe; 9 Nothing fromMaybe; False (True Just) fromMaybe'),[42,9,true]);
  assert.throws(()=>vm.evaluate('True (42 Just) fromMaybe'),StaticTypeError);
  const ordered=vmFor(`${maybe}\n(0 Just) label = "zero"\n(_ Just) label = "some"\n_ label = "none"`);
  assert.deepEqual(ordered.evaluate('(0 Just) label; (1 Just) label; Nothing label'),['zero','some','none']);
});

test('nested patterns and multiple field constructors use source order',()=>{
  const vm=vmFor(`${maybe}\ndata Pair a b = Pair a b\n((x Just) y Pair) extract = x y`);
  assert.deepEqual(vm.evaluate('(3 Just) True Pair extract'),[3,true]);
  assert.throws(()=>vm.evaluate('Nothing True Pair extract'),/No matching pattern/);
  const program=compile(`${maybe}\n(x Just) unwrap = x`);
  for(const checkTypes of [true,false])assert.throws(()=>new VM({...program,checkTypes}).evaluate('Nothing unwrap'),/No matching pattern/);
});

test('recursive ADTs and recursive functions infer their stack effects',()=>{
  const program=compile('data Tree a = Leaf a | Node (Tree a) (Tree a)\n(x Leaf) sum = x\n(l r Node) sum = (l sum) + (r sum)');
  assert.equal(program.types.get('sum'),"'a add => ..s ('a tree) -- ..s 'a");
  assert.deepEqual(new VM(program).evaluate('(1 Leaf) ((2 Leaf) (3 Leaf) Node) Node sum'),[6]);
  assert.throws(()=>new VM(program).evaluate('(True Leaf) (2 Leaf) Node'),StaticTypeError);
});

test('forward and mutually recursive type references are resolved together',()=>{
  const vm=vmFor('data A = End | A B\ndata B = B A\n((End B) A) matched = True');
  assert.deepEqual(vm.evaluate('End B A matched'),[true]);
});

test('ADT equality is structural and distinct nominal types cannot unify',()=>{
  const vm=vmFor(`${maybe}\ndata Other a = Other a`);
  assert.deepEqual(vm.evaluate('(1 Just) == (1 Just); (1 Just) /= (2 Just); Nothing == Nothing; [1 Just] == [1 Just]'),[true,true,true,true]);
  assert.throws(()=>vm.evaluate('(1 Just) == (1 Other)'),StaticTypeError);
  assert.throws(()=>vm.evaluate('[Nothing 1 Other]'),StaticTypeError);
});

test('ADT fields support lists, nested ADTs, and quotation types',()=>{
  const vm=vmFor(`${maybe}\ndata Box a = Box [Maybe a]\ndata Action a = Action {a -> a}\n(q Action) perform = q call`);
  assert.equal(format(vm.evaluate('[Nothing (3 Just)] Box')),'[(Box [Nothing, (Just 3)])]');
  assert.deepEqual(vm.evaluate('3 {+ 1} Action perform'),[4]);
  assert.throws(()=>vm.evaluate('{drop} Action'),StaticTypeError);
});

test('ADT annotations validate parameter arity and polymorphic contracts',()=>{
  const program=compile(`${maybe}\nfromMaybe : (a (Maybe a)) -> a\n${fromMaybe}`);
  assert.deepEqual(new VM(program).evaluate('0 Nothing fromMaybe'),[0]);
  for(const signature of ['Maybe -> int','Maybe int -> bool','Unknown -> int','Maybe a -> a']) {
    assert.throws(()=>compile(`${maybe}\nf : ${signature}\n_ f = 1`),StaticTypeError,signature);
  }
  assert.throws(()=>compile(`${maybe}\nNothing f = 0\n(x Just) f = True`),StaticTypeError);
});

test('mutable ADTs preserve weak parameter types across empty variants',()=>{
  const vm=vmFor(maybe);
  vm.evaluate('Nothing -> mut x');
  vm.infer('x := True Just');
  vm.evaluate('x := 3 Just; x := Nothing');
  assert.throws(()=>vm.evaluate('x := True Just'),StaticTypeError);
  assert.equal(format(vm.evaluate('x')),'[Nothing]');
  assert.throws(()=>vm.evaluate('x := 4 Just; 1 / 0'),/Division by zero/);
  assert.equal(format(vm.evaluate('x')),'[Nothing]');
});

test('constructor names and invalid ADT declarations are rejected atomically',()=>{
  const previous=compile(maybe).definitions;
  for(const source of [
    maybe, 'data Other = Just', 'data int = N', 'data bad = good', 'data Bad A = Good',
    'data Bad a a = Good', 'data Bad a = Good b', 'data Bad = Good Unknown',
    'data Bad =', 'data Bad = Good |', 'data Bad = Good | Good',
    'data Bad = Good "int"', 'Just = 1', '(x x Just) f = x',
    '(x Missing) f = x', 'Just f = 1', 'data Bad = Good (Maybe)',
  ])assert.throws(()=>compile(source,'bad.nyan',previous),undefined,source);
  assert.equal(previous.constructors.size,2);
  const vm=new VM({definitions:previous});
  assert.throws(()=>vm.evaluate('1 -> Just'),/constructor/i);
  assert.throws(()=>vm.evaluate('1 -> mut Nothing'),/pattern variable/);
  assert.throws(()=>compile('data Other = Captured','bad.nyan',previous,{globals:new Map([['Captured',1]])}),/already used/);
});

test('REPL definitions retain ADTs and inspect constructors',()=>{
  const result=spawnSync(process.execPath,['migration/v037-cli.mjs'],{cwd:new URL('..',import.meta.url),input:`${maybe}\n(x Just) unwrap = x\n3 Just unwrap\n:type Just\n:words\n:q\n`,encoding:'utf8'});
  assert.equal(result.status,0);
  assert.doesNotMatch(result.stdout,/Error:/);
  assert.match(result.stdout,/\[3\]/);
  assert.match(result.stdout,/'a maybe/);
  assert.match(result.stdout,/Nothing Just/);
});

test('ADT example executes and CLI types include constructors',()=>{
  const cli=args=>spawnSync(process.execPath,['migration/v037-cli.mjs',...args],{cwd:new URL('..',import.meta.url),encoding:'utf8'});
  const executed=cli(['examples/adt.nyan']);
  assert.equal(executed.status,0,executed.stderr);
  assert.equal(executed.stdout.trim(),'42\n0\n6\n[1, 0, 3]\nTrue\n(Some 7)');
  const checked=cli(['--check','examples/adt.nyan']);assert.equal(checked.status,0,checked.stderr);
  const types=cli(['--types','examples/adt.nyan']);assert.equal(types.status,0,types.stderr);assert.match(types.stdout,/Some : .*option/);
});
