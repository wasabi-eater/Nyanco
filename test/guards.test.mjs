import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {VM,compile} from '../migration/v037-adapter.mjs';
const vmFor=source=>new VM(compile(source));

test('guards choose the first true condition and otherwise is a fallback',()=>{
  const vm=vmFor(`n sign
  | n < 0 = -1
  | n == 0 = 0
  | otherwise = 1
x bounded | 3 < x <= 4 = True | otherwise = False`);
  assert.deepEqual(vm.evaluate('-4 sign 0 sign 8 sign 4 bounded 5 bounded'),[-1,0,1,true,false]);
  assert.equal(vm.infer('sign'),'..s int -- ..s int');
});

test('pattern failures and false guards fall through in source order',()=>{
  const vm=vmFor(`data 'a option = None | 'a Some
(x Some) describe | x > 0 = "positive" | x == 0 = "zero"
_ describe = "other"
[] total = 0
(xs :: x) total | x >= 0 = x + (xs total) | otherwise = xs total`);
  assert.deepEqual(vm.evaluate('2 Some describe; -1 Some describe; None describe; [1 -2 3] total'),['positive','other','other',4]);
});

test('guard conditions execute once, preserve ambient values and isolate bindings',()=>{
  const output=[],vm=new VM({...compile(`n choose
  | ("first" print False) = 999
  | ("second" print n > 0) = n
  | ("skipped" print True) = 0
n scoped | (1 -> temporary; True) = n`),output:s=>output.push(s)});
  assert.deepEqual(vm.evaluate('99 5 choose 3 scoped'),[99,5,3]);
  assert.deepEqual(output,['first','second']);
  assert.throws(()=>compile('n bad | (1 -> temporary; True) = temporary'),/Unknown word/);
});

test('guards require a top bool and all result types agree',()=>{
  for(const source of [
    'x bad | 1 = x','x bad | True = 1 | otherwise = False',
    'x bad | = x','x bad | True x','x bad | True =',
  ])assert.throws(()=>compile(source),undefined,source);
  assert.throws(()=>vmFor('x positive | x > 0 = x').evaluate('0 positive'),/No matching pattern/);
});

test('guard dependencies and recursive guarded functions infer correctly',()=>{
  const vm=vmFor(`n fact | n == 0 = 1 | otherwise = n * ((n - 1) fact)
n accepts | n allowed = n | otherwise = 0
n allowed = n > 3`);
  assert.deepEqual(vm.evaluate('6 fact 4 accepts 2 accepts'),[720,4,0]);
});

test('REPL accepts inline guards and multiline guard blocks',()=>{
  const cli=new URL('../migration/v037-cli.mjs',import.meta.url);
  const result=spawnSync(process.execPath,[fileURLToPath(cli)],{input:'x abs | x < 0 = 0 - x | otherwise = x\n-3 abs\n:{\nx sign\n| x == 0 = 0\n| otherwise = 1\n:}\n0 sign\n:q\n',encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,result.stderr);assert.doesNotMatch(result.stdout,/Error:/);
  assert.match(result.stdout,/\[3\]/);assert.match(result.stdout,/\[3, 0\]/);
});
