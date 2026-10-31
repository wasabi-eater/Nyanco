import test from 'node:test';
import assert from 'node:assert/strict';
import {compile,VM} from '../language.mjs';
import {transpileGo} from '../go-backend.mjs';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
const run=source=>{const p=compile(source),output=[],vm=new VM({...p,output:s=>output.push(s),warning:()=>{}});return {p,output,vm,stack:vm.evaluate('main')};};
const source=`effect ask : -> int
data one 'a = One 'a
instance streem (one 'a) where
  item : 'a
  each (One x) f = call x f
get xs = nth xs 1
main =
 print (nth (map [1,2,3] {* 2}) 1); print (nth ["a","b"] 0);
 print (nth (1 ..= 3) 2); print (nth (One 9) 0);
 print (nth [] 0); print (nth [1] 5); print (nth [1] -1);
 print (nth (iterate {0} {+ 1}) 100); print (get (map [1,2] {* 3}));
 print (handle {nth (fromYield {yield ask; yield 99}) 0} {ask: {-> k; resume 7 k}});
 print (catch {nth (fromYield {exn "source"}) 0});
 print (nth (fromYield {yield 1; cancel; yield 2}) 2);
 print (nth (map [1,2,3] {when ($ == 2) {drop; break}; nop}) 2);
 print (nth (fromYield {Some 42; break}) 9);
 0 -> mut count;
 fromYield {count ! + 1; yield 1; count ! + 1; yield 2; count ! + 100; yield 3} -> xs;
 print (nth xs 1); print count;
 print (nth (fromYield {count ! + 1000; yield 9}) -1); print count;
 print (nth (zip [1,2] [3,4]) 1);
 123; print (nth [7] 0); print`;
test('nth reads only through the selected item and supports all streem instances',()=>{const {output,vm}=run(source);assert.deepEqual(output,['(Some 4)','(Some "a")','(Some 3)','(Some 9)','None','None','None','(Some 100)','(Some 6)','(Some 7)','(Err "source")','None','None','(Some 42)','(Some 2)','2','None','2','(Some #(2 4))','(Some 7)','123']);assert.match(vm.infer('get'),/streem/);assert.doesNotMatch(vm.infer('nth [1] 0'),/exn/);});
test('nth rejects wrong source/index types and saved streams remain reusable',()=>{for(const source of ['nth True 0','nth [1] 1.0','nth [1] (toByte 0)'])assert.throws(()=>compile('main = '+source));const vm=new VM();vm.evaluate('map [1,2] {* 2} -> xs');assert.deepEqual(vm.evaluate('nth xs 1'),[{kind:'adt',typeName:'option',constructor:'Some',fields:[4]}]);assert.deepEqual(vm.evaluate('nth xs 0'),[{kind:'adt',typeName:'option',constructor:'Some',fields:[2]}]);});
test('native nth preserves effects, cancellation and early termination',()=>{const {p,output}=run(source),dir=mkdtempSync(join(tmpdir(),'nyanco-nth-'));try{const file=join(dir,'main.go'),exe=join(dir,'main.exe');writeFileSync(file,transpileGo(p));const b=spawnSync('go',['build','-o',exe,file],{encoding:'utf8',windowsHide:true,timeout:120000});assert.equal(b.status,0,b.stderr);const r=spawnSync(exe,[],{encoding:'utf8',windowsHide:true,timeout:20000});assert.equal(r.status,0,r.stderr);assert.equal(r.stdout,output.join('\n')+'\n');}finally{assert.equal(dirname(dir),tmpdir());assert.ok(dir.startsWith(join(tmpdir(),'nyanco-nth-')));rmSync(dir,{recursive:true,force:true});}});
