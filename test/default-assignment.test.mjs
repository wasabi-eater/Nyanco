import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {compile,VM,format} from '../language.mjs';
import {transpileGo} from '../go-backend.mjs';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';

const source=`main =
 [:] -> mut d
 d.[4] ??<- []
 print d
 0 -> mut calls
 d.[4] ??<- (calls ! + 100; [9])
 print calls
 d.[5] ??<- [1,2]
 print d
 {values: [:]} -> mut r
 r.values.[0] ??<- "hello"
 print r`;
test('conditional indexed reassignment inserts once and skips existing keys',()=>{
  const p=compile(source),output=[],vm=new VM({...p,output:s=>output.push(s)});vm.evaluate('main');
  assert.deepEqual(output,['[4: []]','0','[4: [], 5: [1, 2]]','{values: [0: "hello"]}']);
  assert.throws(()=>compile('main = [:] -> d; d.[4] ??<- []'),/immutable/i);
  assert.throws(()=>compile('main = 1 -> mut x; x ??<- 2'),/indexed|Unexpected/);
});
test('REPL and malformed operator sequences finish in bounded subprocesses',{timeout:15000},()=>{
  const repl=spawnSync(process.execPath,['--max-old-space-size=64','cli.mjs'],{input:'[:] -> mut d\nd.[4] ??<- []\nd\n:q\n',encoding:'utf8',timeout:5000,windowsHide:true});
  assert.equal(repl.status,0,repl.stderr);assert.match(repl.stdout,/\[4: \[\]\]/);
  for(const text of ['d.[4] ?? <- []','+ <- 1','?? ! []','+ mut x']){
    const result=spawnSync(process.execPath,['--max-old-space-size=64','cli.mjs','--eval',text],{encoding:'utf8',timeout:3000,windowsHide:true});
    assert.equal(result.status,1,`${text}: ${result.error||result.stderr}`);assert.match(result.stderr,/Error:/);assert.doesNotMatch(result.stderr,/heap|allocation|memory/i);
  }
});
test('Go conditional reassignment matches REPL behavior',()=>{
  const dir=mkdtempSync(join(tmpdir(),'nyanco-default-assignment-'));
  try{const file=join(dir,'main.go');writeFileSync(file,transpileGo(compile(source)));const result=spawnSync('go',['run',file],{encoding:'utf8',windowsHide:true,timeout:120000});assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,'[4: []]\n0\n[4: [], 5: [1, 2]]\n{values: [0: "hello"]}\n');}
  finally{assert.equal(dirname(dir),tmpdir());assert.ok(dir.startsWith(join(tmpdir(),'nyanco-default-assignment-')));rmSync(dir,{recursive:true,force:true});}
});
