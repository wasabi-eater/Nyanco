import test from 'node:test';
import assert from 'node:assert/strict';
import {compile,VM} from '../language.mjs';
import {transpileGo} from '../go-backend.mjs';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
const run=source=>{const p=compile(source),output=[],vm=new VM({...p,output:s=>output.push(s),warning:()=>{}});return {p,output,vm,stack:vm.evaluate('main')};};
const source=`data choice = Empty | Full int
instance orElse choice where
  hasValue Empty = False
  hasValue (Full x) = True
  (||) Empty right = right
  (||) (Full x) right = Full x
fallback a b = a || b
main =
 print (None || Some 2); print (Some 1 || exn "skip");
 print (Err "a" || Ok 3); print (Ok 4 || exn "skip");
 print (Err "first" || Err "second");
 print (Some 1 .|. Some 2); print (None .|. Some 3);
 print (Err "a" .|. Ok 5); print (Ok 6 .|. Err "b");
 print (catch {Some 1 .|. (exn "eager")});
 print (fallback None (Some 8));
 print (Empty || Full 9); print (Full 10 || exn "skip");
 print (False || True); print (True || exn "skip");
 print (False && exn "skip"); print (3 .|. 4);
 0 -> mut count;
 Some 1 || (count ! + 1; Some 2); drop;
 None || (count ! + 1; Some 2); drop;
 Some 1 .|. (count ! + 1; Some 2); drop;
 print count`;
test('orElse preserves first success, strict or evaluates both sides, and custom instances work',()=>{const {output,vm}=run(source);assert.deepEqual(output,['(Some 2)','(Some 1)','(Ok 3)','(Ok 4)','(Err "second")','(Some 1)','(Some 3)','(Ok 5)','(Ok 6)','(Err "eager")','(Some 8)','(Full 9)','(Full 10)','True','True','False','7','2']);assert.match(vm.infer('fallback'),/orElse/);});
test('both operands are type checked and mixed result payloads are rejected',()=>{for(const expression of ['Some 1 || Some "bad"','None || True','Err "bad" .|. Some 1','Some 1 || missing'])assert.throws(()=>compile('main = '+expression),/unify|instance|Unknown word/i);});
test('native orElse short circuits and preserves custom dispatch',()=>{const {p,output}=run(source),dir=mkdtempSync(join(tmpdir(),'nyanco-orelse-'));try{const file=join(dir,'main.go'),exe=join(dir,'main.exe');writeFileSync(file,transpileGo(p));const build=spawnSync('go',['build','-o',exe,file],{encoding:'utf8',windowsHide:true,timeout:120000});assert.equal(build.status,0,build.stderr);const r=spawnSync(exe,[],{encoding:'utf8',windowsHide:true,timeout:15000});assert.equal(r.status,0,r.stderr);assert.equal(r.stdout,output.join('\n')+'\n');}finally{assert.equal(dirname(dir),tmpdir());assert.ok(dir.startsWith(join(tmpdir(),'nyanco-orelse-')));rmSync(dir,{recursive:true,force:true});}});
