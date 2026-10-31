import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {VM,compile} from '../migration/v037-adapter.mjs';
const vmFor=source=>new VM(compile(source));

test('equals defines a local stack function and calls it without call',()=>{
  const vm=vmFor('x =\n  y = +\n  y');
  assert.deepEqual(vm.evaluate('3 4 x'),[7]);
  assert.equal(vm.infer('x'),"'a add => ..s 'a 'a -> ..s 'a");
  assert.deepEqual(new VM().evaluate('f = dup; 2 f; True f'),[2,2,true,true]);
});

test('local function definitions defer execution and capture lexical variables',()=>{
  const output=[],vm=new VM({output:s=>output.push(s)});
  assert.deepEqual(vm.evaluate('f = "hello" print; 7'),[7]);
  assert.deepEqual(output,[]);vm.evaluate('f f');assert.deepEqual(output,['hello','hello']);
  const captured=vmFor('n make =\n  add = n +\n  {add}');
  assert.deepEqual(captured.evaluate('3 7 make call'),[10]);
  assert.deepEqual(new VM().evaluate('0 -> mut n; f = n; n := 4; f'),[4]);
  const global=vmFor('{add = +; add} -> q\nmain = 3 4 q call');
  assert.deepEqual(global.evaluate('main'),[7]);
});

test('local functions support parameters and recursive case bodies',()=>{
  const vm=vmFor(`main =
  n square = n * n
  fact = (case
    -> 0 then 1
    -> n then n * ((n - 1) fact)
  end)
  5 square 6 fact`);
  assert.deepEqual(vm.evaluate('main'),[25,720]);
  const clauses=vmFor(`main =
  0 factorial = 1
  n factorial = n * ((n - 1) factorial)
  absolute = case
    | dup; < 0 then 0 -
    otherwise nop
  6 factorial -3 absolute`);
  assert.deepEqual(clauses.evaluate('main'),[720,3]);
});

test('variables use arrows, legacy mut declarations fail, and scopes stay local',()=>{
  for(const source of ['mut n = 0','mut n := 0'])assert.throws(()=>new VM().evaluate(source),/-> mut/);
  assert.throws(()=>compile('mut n = 0\nmain = n'),/-> mut/);
  assert.deepEqual(new VM().evaluate('2 -> x; 0 -> mut n; n := x; n'),[2]);
  assert.throws(()=>new VM().evaluate('(f = 3; f); f'),/Unknown word/);
  assert.throws(()=>new VM().evaluate('f = 3; f := 4'),/immutable/);
});

test('REPL accepts the motivating multiline local definition',()=>{
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('../migration/v037-cli.mjs',import.meta.url))],{input:':{\nx =\n  y = +\n  y\n:}\n3 4 x\n:clear\n(f = +; 3 5 f)\n:clear\n{f = +; f} -> q\n3 6 q call\n:q\n',encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,result.stderr);assert.doesNotMatch(result.stdout,/Error:/);assert.match(result.stdout,/\[7\]/);
  assert.match(result.stdout,/\[8\]/);assert.match(result.stdout,/\[9\]/);
});
