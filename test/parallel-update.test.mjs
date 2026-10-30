import test from 'node:test';
import assert from 'node:assert/strict';
import {compile,VM} from '../migration/v048-adapter.mjs';
import {transpileGo} from '../go-backend.mjs';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const run=source=>{const p=compile(source),output=[],vm=new VM({...p,output:s=>output.push(s),warning:()=>{}});return {p,vm,output,stack:vm.evaluate('main')};};
test('update starts a fresh capture clause on the old values',()=>{
 assert.deepEqual(run('main = 3 -> mut x; x ! _ * _; x').stack,[9]);
 assert.deepEqual(run('main = 3 -> mut x; x ! ($; *); x').stack,[9]);
 assert.deepEqual(run('main = 3 -> mut x; 8; x ! _ + 1; _ + x').stack,[12]);
 assert.throws(()=>run('main = 3 -> mut x; x ! _ + $'),/Cannot mix/);
 assert.throws(()=>run('main = 3 -> mut x; x ! _1'),/underflow/i);
});
test('parallel assignment evaluates all results before replacing any target',()=>{
 assert.deepEqual(run('main = 2 -> mut x; 3 -> mut y; x, y := y, x + y; x, y').stack,[3,5]);
 assert.deepEqual(run('main = 2 -> mut x; 3 -> mut y; x, y := y, x; x, y').stack,[3,2]);
 assert.deepEqual(run('main = 1 -> mut x; 2 -> mut y; 3 -> mut z; x, y, z := z, x, y; x, y, z').stack,[3,1,2]);
 assert.deepEqual(run('main = 9; 2 -> mut x; 3 -> mut y; x, y := y, x; x, y').stack,[9,3,2]);
});
test('parallel update captures old target values in declaration order',()=>{
 assert.deepEqual(run('main = 2 -> mut x; 3 -> mut y; x, y ! _, _1 + _; x, y').stack,[3,5]);
 assert.deepEqual(run('main = 2 -> mut x; 3 -> mut y; x, y ! swap; x, y').stack,[3,2]);
 assert.deepEqual(run('main = 0 -> mut x; 1 -> mut y; each (1 ..= 6) {drop; x, y ! _, _1 + _}; x, y').stack,[8,13]);
});
test('parallel updates reject immutable targets, duplicates, type and arity changes and roll back failures',()=>{
 for(const body of ['x, x := 1, 2','x, y := 1','x, y := 1, 2, 3','x, y := "bad", 2','x, missing := 1, 2'])assert.throws(()=>run('main = 1 -> mut x; 2 -> mut y; '+body),/Duplicate|produce 2|Cannot unify|Unknown/);
 assert.throws(()=>run('main = 1 -> mut x; 2 -> y; x, y := 3, 4'),/immutable/);
 const vm=new VM({warning:()=>{}});vm.evaluate('1 -> mut x; 2 -> mut y');assert.throws(()=>vm.evaluate('x, y := 3, 1 // 0'),/zero/);assert.deepEqual(vm.evaluate('x, y'),[1,2]);
});
test('mutable parameters work in functions, local functions, patterns and guards',()=>{
 assert.deepEqual(run('square mut x = x ! _ * _; x;; main = square 5').stack,[25]);
 assert.deepEqual(run('main = f mut x = x ! + 1; x;; f 4').stack,[5]);
 assert.deepEqual(run('f (Some mut x) = x ! + 1; x;; main = f (Some 3)').stack,[4]);
 assert.deepEqual(run('f mut x | x < 0 = x ! 0 - _; x\n        | otherwise = x\nmain = f -3; f 2').stack,[3,2]);
 assert.throws(()=>run('f x = x ! + 1; x;; main = f 3'),/immutable/);
 assert.throws(()=>compile('f mut _ = 1'),/mut parameter/);
 assert.deepEqual(run('counter mut x = {x ! + 1; x};; main = counter 0 -> c; call c; call c').stack,[1,2]);
 assert.deepEqual(run("data box 'a = Box ['a]\ninstance streem (box 'a) where\n  item : 'a\n  each (Box xs) mut f = each xs f\nmain = toList (Box [1,2])").stack,[[1,2]]);
});
test('double semicolons separate definitions and preserve semicolons inside explicit local bodies',()=>{
 assert.deepEqual(run('f = 1;; g = 2;; main = f, g;;').stack,[1,2]);
 assert.deepEqual(run('main = f = 1; 2;; f').stack,[1,2]);
 assert.deepEqual(run('main = (f = 3;; g = 4;; f, g)').stack,[3,4]);
 assert.deepEqual(run('f : -> num;; f = 2;; main = f').stack,[2]);
});
test('floor division rounds toward negative infinity and supports operator instances',()=>{
 assert.deepEqual(run('main = 7 // 3; -7 // 3; 7 // -3; -7 // -3; 5.5 // 2; 8; // 3').stack,[2,-3,-3,2,2,2]);
 assert.throws(()=>run('main = 1 // 0'),/zero/);
 assert.deepEqual(run('data box = Box num\ninstance floorDiv box where\n  // (Box x) (Box y) = Box (x // y)\nmain = (Box -7) // (Box 3)').stack,[{kind:'adt',typeName:'box',constructor:'Box',fields:[-3]}]);
});
test('Go and VM agree for parallel updates, mutable parameters and floor division',()=>{
 const source=`fib mut x mut y = each (1 ..= 6) {drop; x, y ! _, _1 + _}; #(x,y);;
flip mut x mut y = x, y := y, x; #(x,y);;
counter mut x = {x ! _ + 1; x};;
main = print (fib 0 1); print (flip 2 3); print (-7 // 3);
  counter 0 -> c; print (call c); print (call c);
  f mut x = x ! _ * _; x;; print (f 4)`;
 const {p,output}=run(source),dir=mkdtempSync(join(tmpdir(),'nyanco-updates-'));
 try{const file=join(dir,'main.go'),exe=join(dir,'main.exe');writeFileSync(file,transpileGo(p));const build=spawnSync('go',['build','-o',exe,file],{encoding:'utf8',windowsHide:true,timeout:120000});assert.equal(build.status,0,build.stderr);const result=spawnSync(exe,[],{encoding:'utf8',windowsHide:true,timeout:15000});assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,output.join('\n')+'\n');}finally{rmSync(dir,{recursive:true,force:true});}
});
