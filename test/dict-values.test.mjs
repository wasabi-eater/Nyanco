import test from 'node:test';
import assert from 'node:assert/strict';
import {compile,VM,format} from '../language.mjs';
import {transpileGo} from '../go-backend.mjs';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
const source=`main =
 print (toVector (values [0: "a", 1: "b", 0: "c"]))
 print (toVector (values [:]))
 print (toVector (map (values [0: 1, 1: 2]) {* 2}))
 print (fold (values [0: 1, 1: 2]) 0 {+})
 print (nth (values [0: "a", 1: "b"]) 1)
 print (toVector (take (values [0: 1, 1: 2]) 1))
 0 -> mut count
 each (values [0: 1, 1: 2, 2: 3]) {count ! + 1; drop; cancel}
 print count
 0; each (values [0: 1, 1: 2]) {+; break}; print
 [0: 10] -> mut d
 values d -> saved
 d.[1] <- 20
 print (toVector saved)
 print (toVector (values d))
 print (toVector saved)`;
const expected=['["c", "b"]','[]','[2, 4]','3','(Some "b")','[1]','1','1','[10]','[10, 20]','[10]'];
const run=()=>{const p=compile(source),output=[],vm=new VM({...p,output:s=>output.push(s)});vm.evaluate('main');return {p,output};};
test('values streams preserve dictionary order, snapshots and consumer effects',()=>{
  assert.deepEqual(run().output,expected);
  assert.throws(()=>compile('main = values [1,2]'),/Cannot unify|mismatch/i);
  const vm=new VM();vm.evaluate('values [0: "a"] -> saved');assert.equal(format(vm.evaluate('toVector saved')[0]),'["a"]');assert.equal(format(vm.evaluate('toVector saved')[0]),'["a"]');
  assert.match(vm.infer('values'),/dict 'a 'b.*stream 'b/);assert.doesNotMatch(vm.infer('values'),/exn/);
});
test('Go values streams agree with VM',()=>{
  const {p}=run(),dir=mkdtempSync(join(tmpdir(),'nyanco-values-'));
  try{const file=join(dir,'main.go');writeFileSync(file,transpileGo(p));const result=spawnSync('go',['run',file],{encoding:'utf8',windowsHide:true,timeout:120000});assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,expected.join('\n')+'\n');}
  finally{assert.equal(dirname(dir),tmpdir());assert.ok(dir.startsWith(join(tmpdir(),'nyanco-values-')));rmSync(dir,{recursive:true,force:true});}
});
