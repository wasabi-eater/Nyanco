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
main =
 print (vzip [1,2] ["a"]); print (toVector (zip (1 ..= 3) [4,5]));
 print (vzip [] [1]); print (vzip [1] []);
 print (toVector (take (zip (iterate {0} {+ 1}) (iterate {10} {+ 1})) 3));
 print (toVector (zip (fromYield {yield 1; cancel}) [3,4]));
 print (toVector (zip (map [1,2,3] {when ($ == 2) {drop; break}; nop}) [3,4]));
 print (handle {vzip (fromYield {yield ask}) [9]} {ask: {-> k; resume 8 k}});
 print (catch {vzip (fromYield {exn "source"}) [1]});
 print (0; each (zip [1,2,3] [4,5,6]) {-> pair; + pair.0; when ($ > 2) {break}});
 0 -> mut count;
 zip (fromYield {count ! + 1; yield 1; count ! + 1; yield 2}) [3,4] -> stream;
 print count; print (toVector (take stream 1)); print count;
 print (vzip [] (fromYield {count ! + 100; yield 1})); print count;
 print (omap (Some 2) {+ 1}); print (omap None {exn "unused"});
 print (ofilter (Some 2) {> 1}); print (ofilter (Some 2) {> 3});
 print (ofilter None {exn "unused"});
 print (oflatten (Some (Some 3))); print (oflatten (Some None));
 print (ozip (Some 1) (Some "a")); print (ozip None (Some 3));
 print (oflatMap (Some 2) {Some (_ + 1)});
 print (rmap (Ok 2) {+ 1}); print (rmap (Err "old") {exn "unused"});
 print (rflatten (Ok (Ok 3))); print (rflatten (Ok (Err "inner")));
 print (rflatten (Err "outer"));
 print (rzip (Ok 1) (Ok "a")); print (rzip (Err "left") (Err "right"));
 print (rflatMap (Ok 2) {Ok (_ + 1)});
 print (catch {omap (Some 1) {exn "callback"}});
 print (handle {rmap (Ok 1) {drop; ask}} {ask: {-> k; resume 7 k}});
 print (None ?? 1 + 2); print (Some 4 ?? exn "unused"); print (Err "bad" ?? 5); print (None ?? None ?? 7)`;
test('zip and container transforms preserve values, effects and lazy traversal',()=>{
 const {output}=run(source);assert.deepEqual(output,['[#(1 "a")]','[#(1 4), #(2 5)]','[]','[]','[#(0 10), #(1 11), #(2 12)]','[#(1 3)]','[#(1 3)]','[#(8 9)]','(Err "source")','3','0','[#(1 3)]','1','[]','1','(Some 3)','None','(Some 2)','None','None','(Some 3)','None','(Some #(1 "a"))','None','(Some 3)','(Ok 3)','(Err "old")','(Ok 3)','(Err "inner")','(Err "outer")','(Ok #(1 "a"))','(Err "left")','(Ok 3)','(Err "callback")','(Ok 7)','3','4','5','7']);
});
test('saved zip streams retain their type, and invalid callbacks are rejected',()=>{
 const vm=new VM();vm.evaluate('zip [1,2] ["a","b"] -> pairs');assert.equal(vm.evaluate('toVector pairs')[0].length,2);
 for(const expression of ['vzip True []','omap (Some 1) {"extra"}','ofilter (Some 1) {+ 1}','oflatten (Some 1)','rflatten (Ok 1)','oflatMap (Some 1) {+ 1}','rfilter (Ok 1) {True} "no"'])assert.throws(()=>compile('main = '+expression));
});
test('native zip cursors forward effects and stop without eager collection',()=>{
 const {p,output}=run(source),dir=mkdtempSync(join(tmpdir(),'nyanco-zip-'));try{const file=join(dir,'main.go'),exe=join(dir,'main.exe');writeFileSync(file,transpileGo(p));const b=spawnSync('go',['build','-o',exe,file],{encoding:'utf8',windowsHide:true,timeout:120000});assert.equal(b.status,0,b.stderr);const r=spawnSync(exe,[],{encoding:'utf8',windowsHide:true,timeout:20000});assert.equal(r.status,0,r.stderr);assert.equal(r.stdout,output.join('\n')+'\n');}finally{assert.equal(dirname(dir),tmpdir());assert.ok(dir.startsWith(join(tmpdir(),'nyanco-zip-')));rmSync(dir,{recursive:true,force:true});}
});

test('double question wraps its right operand in a lazy block with fresh captures',()=>{
 const source='main = print (None ?? 1 + 2); print (Some 4 ?? exn "unused"); print (Err "bad" ?? 5); print (Ok 6 ?? exn "unused"); print (None ?? None ?? 7); 9; print (None ?? $$); print';
 assert.deepEqual(run(source).output,['3','4','5','6','7','9','9']);
 assert.throws(()=>compile('main = None ??'),/fallback expression/);
 assert.throws(()=>compile('main = Some 1 ?? "bad"'),/unify|instance/i);
});
