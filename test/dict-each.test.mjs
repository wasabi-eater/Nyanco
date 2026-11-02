import test from 'node:test';
import assert from 'node:assert/strict';
import {compile,VM} from '../language.mjs';
import {transpileGo} from '../go-backend.mjs';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
const source=`pairs : dict int string -> [#(int string)]
pairs = toVector
collect xs = toVector xs
main =
 print (sortBy (pairs [1: "b", 0: "a"]) {.0})
 print (sortBy (collect [2: "c", 0: "a"]) {.0})
 print (toVector [:])
 0; each [1: 10, 2: 20] {-> #(key value); + (key + value)}; print
 print (fold [1: 10, 2: 20] 0 {-> #(key value); + (key + value)})
 print (sortBy (map [0: "a", 1: "b"] {.1}) {.[0]})
 print (sortBy (filter [0: 10, 1: 20, 2: 30] {.0; > 0}) {.0})
 0 -> mut calls
 each [0: "a", 1: "b"] {drop; calls ! + 1; cancel}
 print calls
 0; each [0: 10, 1: 20] @done {drop; drop; 5; break@done}; print
 [0: "a"] -> mut d
 map d {nop} -> saved
 d.[1] <<- "b"
 print (toVector saved)`;
const expected=['[#(0 "a"), #(1 "b")]','[#(0 "a"), #(2 "c")]','[]','33','33','["a", "b"]','[#(1 20), #(2 30)]','1','5','[#(0 "a")]'];
const run=()=>{const p=compile(source),output=[],vm=new VM({...p,output:s=>output.push(s)});vm.evaluate('main');return {p,output};};
test('dictionaries implement streem of key/value tuples without an ordering contract',()=>{assert.deepEqual(run().output,expected);});
test('Go dictionary iteration supports generic consumers, effects and cancellation',()=>{
  const {p}=run(),dir=mkdtempSync(join(tmpdir(),'nyanco-dict-each-'));
  try{const file=join(dir,'main.go');writeFileSync(file,transpileGo(p));const r=spawnSync('go',['run',file],{encoding:'utf8',windowsHide:true,timeout:120000});assert.equal(r.status,0,r.stderr);assert.equal(r.stdout,expected.join('\n')+'\n');}
  finally{assert.equal(dirname(dir),tmpdir());assert.ok(dir.startsWith(join(tmpdir(),'nyanco-dict-each-')));rmSync(dir,{recursive:true,force:true});}
});
