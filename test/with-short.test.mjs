import test from 'node:test';
import assert from 'node:assert/strict';
import {compile,VM} from '../language.mjs';
import {transpileGo} from '../go-backend.mjs';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
const source=`bump = with x ! + 2
main =
 [:] -> d
 7 -> n
 d with [1] ??= []; with [1] ! push n -> mut x
 print x
 x ! with {[1] = [], [2] = []}
 print x
 print ({x: {y: [1,2,3]}} with x.y[2] ! + 10)
 print (#(1,2) with 1 = "hello")
 print ([1,2] with ?[9] ! + 10)
 print ({x: 1, y: 2} with {x ! + 1, y = 10})
 print ({x: 1} with x = 2 + 3 * 4)
 print (bump {x: 3})
 print ([0: [1]] with [0] ! push 2, push 3)`;
const run=s=>{const p=compile(s),output=[],vm=new VM({...p,output:s=>output.push(s)});vm.evaluate('main');return {p,output};};
test('short with updates cover index, field, tuple, nested paths and mutable binding',()=>{
  assert.deepEqual(run(source).output,['[1: [7]]','[1: [], 2: []]','{x: {y: [1, 2, 13]}}','#(1 "hello")','[1, 2]','{x: 2, y: 10}','{x: 14}','{x: 5}','[0: [1, 2, 3]]']);
  const {p}=run('{x: 1} with x = 3 -> r\nmain = print r');assert.ok(p.definitions.initializers.length);
  for(const s of ['main = [1] with [0] =','main = [1] with [0]','main = {x: 1} with {x = 2, y =}','main = [1] with [0] ! -> x'])assert.throws(()=>compile(s));
});
test('REPL recognizes short record updates as expressions',()=>{
  const result=spawnSync(process.execPath,['cli.mjs'],{input:'{x: 1} -> r\nr with x = 3\n:q\n',encoding:'utf8',timeout:5000,windowsHide:true});
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/\{x: 3\}/);assert.doesNotMatch(result.stdout,/Error:/);
});
test('Go short updates match the interpreter',()=>{
  const {p,output}=run(source),dir=mkdtempSync(join(tmpdir(),'nyanco-with-short-'));
  try{const file=join(dir,'main.go');writeFileSync(file,transpileGo(p));const result=spawnSync('go',['run',file],{encoding:'utf8',windowsHide:true,timeout:120000});assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,output.join('\n')+'\n');}
  finally{assert.equal(dirname(dir),tmpdir());assert.ok(dir.startsWith(join(tmpdir(),'nyanco-with-short-')));rmSync(dir,{recursive:true,force:true});}
});
