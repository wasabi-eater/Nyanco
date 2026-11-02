import test from 'node:test';
import assert from 'node:assert/strict';
import {compile,VM,lex} from '../language.mjs';
import {transpileGo} from '../go-backend.mjs';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const run=s=>{const p=compile(s),output=[],vm=new VM({...p,output:s=>output.push(s),warning:()=>{}});return {p,output,stack:vm.evaluate('main')};};

test('reassignment and modifying update include comma sequences in the RHS',()=>{
 assert.deepEqual(run('main = 3 -> mut x; x ! + 1, * 2; x').stack,[8]);
 assert.deepEqual(run('main = 0 -> mut x; x <<- 3, + 1, * 2; x').stack,[8]);
 assert.deepEqual(run('main = 3 -> mut x; x ! + 1, * 2\n  x').stack,[8]);
 assert.deepEqual(run('main = 0 -> mut x; (x <<- 3, + 1); x').stack,[4]);
 assert.deepEqual(run('main = 0 -> mut x; x<<--3; x').stack,[-3]);
 assert.deepEqual(run('main = 0 -> mut x; 10; x <<- _, + 2; x').stack,[12]);
 assert.deepEqual(run('main = 40; 3 -> mut x; x ! + 1, * 2; _, x').stack,[40,8]);
 assert.deepEqual(lex('x<<-1; x <= 2; x < 3; 4 -> y').filter(t=>t.kind==='word').map(t=>t.value),['x','<<-','x','<=','x','<','->','y']);
 assert.throws(()=>compile('main = 0 -> mut x; x := 1'),/removed.*<<-/);
 assert.deepEqual(run('main = ":="').stack,[':=']);
});

test('parallel targets use the same RHS precedence and preserve one capture snapshot',()=>{
 assert.deepEqual(run('main = 2 -> mut x; 3 -> mut y; x, y ! _1 + _, _1; x, y').stack,[5,2]);
 assert.deepEqual(run('main = 2 -> mut x; 3 -> mut y; x, y ! (_1 + _, _1); x, y').stack,[5,2]);
 assert.deepEqual(run('main = 2 -> mut x; 3 -> mut y; x, y <<- y, x + y; x, y').stack,[3,5]);
 assert.deepEqual(run('main = 1 -> mut x; 2 -> mut y; 3 -> mut z; x, y, z ! _1, _, _2; x, y, z').stack,[2,3,1]);
 assert.throws(()=>run('main = 3 -> mut x; x ! + 1, 2'),/produce 1/);
 assert.throws(()=>run('main = 0 -> x; x <<- 1, + 2'),/immutable/);
 const vm=new VM({warning:()=>{}});vm.evaluate('1 -> mut x; 2 -> mut y');
 assert.throws(()=>vm.evaluate('x, y <<- 3, 1 / 0'),/zero/);assert.deepEqual(vm.evaluate('x, y'),[1,2]);
});

test('field and index updates accept comma commands and preserve aliases',()=>{
 assert.deepEqual(run('main = {x: 3} -> mut r; r -> old; r.x ! + 1, * 2; old.x, r.x').stack,[3,8]);
 assert.deepEqual(run('main = {xs: [0,1]} -> mut r; r.xs.[1] <<- 3, + 1, * 2; r.xs.[1]').stack,[8]);
 assert.deepEqual(run('main = {x: 3, y: 4} with {.x ! + 1, * 2; .y = 5, + 2} -> r; r.x, r.y').stack,[8,7]);
 assert.deepEqual(run('main = #(1,2) -> mut t; t.0 ! + 1, * 3; t.0').stack,[6]);
});

test('Go and VM agree on uniform comma precedence for mutable updates',()=>{
 const source=`main =
  3 -> mut x; x ! + 1, * 2; print x;
  x <<- 4, + 2, * 3; print x;
  2 -> mut y; x, y ! _1 + _, _1; print (#(x,y));
  x, y <<- y, x + y; print (#(x,y));
  {xs: [1,2]} -> mut r; r -> old;
  r.xs.[1] ! + 1, * 2; print r; print old;
  r.xs.[0] <<- 3, * 4; print r;
  f mut z = z ! + 1, * 2; z;; print (f 5)`;
 const {p,output}=run(source),dir=mkdtempSync(join(tmpdir(),'nyanco-reassign-'));
 try{const file=join(dir,'main.go'),exe=join(dir,'main.exe');writeFileSync(file,transpileGo(p));const build=spawnSync('go',['build','-o',exe,file],{encoding:'utf8',windowsHide:true,timeout:120000});assert.equal(build.status,0,build.stderr);const result=spawnSync(exe,[],{encoding:'utf8',windowsHide:true,timeout:15000});assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,output.join('\n')+'\n');}finally{rmSync(dir,{recursive:true,force:true});}
});
