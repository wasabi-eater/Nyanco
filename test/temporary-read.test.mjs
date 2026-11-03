import test from 'node:test';
import assert from 'node:assert/strict';
import {compile,VM} from '../language.mjs';
import {transpileGo} from '../go-backend.mjs';
import {verifyTypedIR} from '../typed-ir.mjs';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
function run(source,optimizeVectors=true){const p=compile(source),out=[],vm=new VM({...p,optimizeVectors,output:s=>out.push(s),warning:()=>{}});const stack=vm.evaluate('main');return {p,out,vm,stack};}
const example=condition=>`main =
 v <- [0, 1, 2]
 when (length v ${condition} 2) {print "{v.[0]}, {v.[1]}"}
 v; vpush 3; print
`;

test('conditional temporary reads do not escape the vector; last use updates in place',()=>{
 for(const condition of ['<','>']){
  const fast=run(example(condition)),copy=run(example(condition),false);
  assert.deepEqual(fast.out,copy.out);assert.deepEqual(fast.stack,copy.stack);
  assert.equal(fast.vm.vectorUpdates.inPlace,1);assert.equal(fast.vm.vectorUpdates.copied,0);
  let ir;transpileGo(fast.p,{onIR:x=>ir=x});assert.ok(verifyTypedIR(ir));
  const main=ir.regions.find(r=>r.owner?.name==='main');
  assert.equal(main.instructions.find(i=>i.name==='vpush').ownership.mode,'move');
  assert.equal(main.instructions.find(i=>i.name==='when').borrowing.reason,'synchronous-non-retaining-callback');
  assert.ok(ir.regions.some(r=>r.captures?.length&&r.retention.safe));
 }
});

test('reader callbacks may be called synchronously or held in a dead local closure',()=>{
 for(const body of [
  'when True {print v}',
  'when True {(v <- 9; print v)}',
  'if True {print v} {print (length v)}',
  'call {print (head v)}',
  'q <- {print v}; when True q',
  'alias <- v; when True {print (length alias)}',
  'when True {when True {print v}}',
  '0; each [1,2] {+; print v}; drop',
 ]){
  // Allocate iteration input before v: constructing aggregates conservatively
  // escapes existing allocations in the current analysis.
  const source=body.startsWith('0; each')?'main = items <- [1,2]; v <- [0,1,2]; 0; each items {+; print v}; drop; vpush v 3; print':`main = v <- [0,1,2]; ${body}; vpush v 3; print`;
  const fast=run(source),copy=run(source,false);assert.deepEqual(fast.out,copy.out,body);assert.equal(fast.vm.vectorUpdates.inPlace,1,body);
 }
});

test('saved aliases, live closures, lazy streams and unknown consumers still force copies',()=>{
 const programs=[
  'main = v <- [0,1,2]; alias <- v; when True {print v}; vpush v 3; print; print alias',
  'main = v <- [0,1,2]; q <- {print v}; when True q; vpush v 3; print; call q',
  'mut saved <- []\nmain = v <- [0,1,2]; when True {saved <<- v}; vpush v 3; print; print saved',
  'mut saved <- []\nremember xs = saved <<- xs\nmain = v <- [0,1,2]; when True {remember v}; vpush v 3; print; print saved',
  'main = v <- [0,1,2]; stream <- map v {nop}; when True {print v}; vpush v 3; print; print (toVector stream)',
 ];
 for(const source of programs){const fast=run(source),copy=run(source,false);assert.deepEqual(fast.out,copy.out,source);assert.equal(fast.vm.vectorUpdates.inPlace,0,source);}
});

test('custom show implementations are not assumed to be non-retaining',()=>{
 const source=`mut saved <- []
instance show [int] where
 show xs = saved <<- xs; "shown"
main = v <- [0,1,2]; when True {print "{v}"}; vpush v 3; print; print saved`;
 const fast=run(source),copy=run(source,false);assert.deepEqual(fast.out,['shown','[0, 1, 2, 3]','[0, 1, 2]']);assert.deepEqual(fast.out,copy.out);assert.equal(fast.vm.vectorUpdates.inPlace,0);
});

test('self concatenation and persistent callback results retain correct alias information',()=>{
 for(const source of [
  'main = v <- [1,2]; concat v v; print',
  'main = v <- [1,2]; q <- {v}; vpush v 3; print; print (call q)',
  'main = v <- [1,2]; placeholder <- {[]}; placeholder; when True {drop; {v}}; vpush v 3; print; call; print',
 ]){const fast=run(source),copy=run(source,false);assert.deepEqual(fast.out,copy.out);}
});

test('optimized and copying native builds agree for temporary and retained captures',()=>{
 const source=`mut saved <- []
main =
 v <- [0,1,2]; when (length v > 2) {print "{v.[0]}, {v.[1]}"}; vpush v 3; print
 w <- [4,5]; when True {saved <<- w}; vpush w 6; print; print saved
 z <- [7,8]; q <- {print z}; when True q; vpush z 9; print; call q
`;
 const expected=run(source),dir=mkdtempSync(join(tmpdir(),'nyanco-read-borrow-'));
 try{for(const optimized of [true,false]){
  let ir;const code=transpileGo(expected.p,{optimizeVectors:optimized,onIR:x=>ir=x});assert.ok(verifyTypedIR(ir));
  if(optimized)assert.match(code,/vectorAppend\(v\d+,v\d+,false,/);else assert.doesNotMatch(code,/vectorAppend\(v\d+,v\d+,false,/);
  const file=join(dir,'main.go');writeFileSync(file,code);const result=spawnSync('go',['run',file],{encoding:'utf8',timeout:120000});assert.equal(result.status,0,result.stderr);assert.equal(result.stdout.trim(),expected.out.join('\n'));
 }}finally{rmSync(dir,{recursive:true,force:true});}
});
