import test from 'node:test';
import assert from 'node:assert/strict';
import {compile,VM} from '../language.mjs';
import {LanguageService} from '../lsp.mjs';
import {transpileGo} from '../go-backend.mjs';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const run=source=>{const p=compile(source),output=[];const vm=new VM({...p,output:s=>output.push(s)});return {stack:vm.evaluate('main'),output};};

test('newlines sequence commands and fix the print and binding example',()=>{
  const source='main =\n    print "Hello, world"\n    0 -> x; print x';
  assert.deepEqual(run(source),{stack:[],output:['Hello, world','0']});
  const service=new LanguageService(),uri='file:///newline.nyan';service.update(uri,source,1);
  const text=service.request('textDocument/hover',{textDocument:{uri},position:{line:1,character:5}}).contents.value;
  assert.match(text,/'a = string/);assert.doesNotMatch(text,/'a = int/);
  assert.deepEqual(run('main =\r\n  1 -- comment\r\n\r\n  2\r\n  +').stack,[3]);
});
test('newlines start capture clauses within parentheses, vectors, records and quotations',()=>{
  assert.deepEqual(run('main = 3\n _ + 1').stack,[4]);
  assert.deepEqual(run('main = 3,\n _ + 1').stack,[4]);
  assert.equal(run('main = {x: 1,\n y: 2}').stack[0].fields.y,2);
  assert.deepEqual(run('main = (3\n _ + 1)').stack,[4]);
  assert.deepEqual(run('main = [3\n _ + 1]').stack,[[4]]);
  assert.equal(run('main = {x: 3\n _ + 1}').stack[0].fields.x,4);
  assert.deepEqual(run('main = call {3\n _ + 1}').stack,[4]);
});
test('layout still accepts multiline declarations, guards and case branches',()=>{
  const source=`f x =
  local y =
    y + 1
  local x
abs n
  | n < 0 = 0 - n
  | otherwise = n
choose = case
  -> Some x ?
    f x
  -> None ?
    0
main =
  print (choose (Some 2))
  print (choose None)
  print (abs -3)`;
  assert.deepEqual(run(source).output,['3','0','3']);
});

test('Go execution uses the same newline sequencing and captures',()=>{
  const source=`main =
  print "Hello, world"
  0 -> x
  print x
  3
  _ + 1
  print`;
  const dir=mkdtempSync(join(tmpdir(),'nyanco-newline-'));
  try{
    const sourceFile=join(dir,'main.nyan');writeFileSync(sourceFile,source);
    const cli=spawnSync(process.execPath,[fileURLToPath(new URL('../cli.mjs',import.meta.url)),sourceFile],{encoding:'utf8',windowsHide:true,timeout:15000});
    assert.equal(cli.status,0,cli.stderr);assert.equal(cli.stdout,'Hello, world\n0\n4\n');
    const file=join(dir,'main.go');writeFileSync(file,transpileGo(compile(source)));
    const result=spawnSync('go',['run',file],{encoding:'utf8',windowsHide:true,timeout:120000});
    assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,'Hello, world\n0\n4\n');
  }finally{
    assert.equal(dirname(dir),tmpdir());assert.ok(dir.startsWith(join(tmpdir(),'nyanco-newline-')));
    rmSync(dir,{recursive:true,force:true});
  }
});
