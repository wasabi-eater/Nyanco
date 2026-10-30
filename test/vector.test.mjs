import test from 'node:test';
import assert from 'node:assert/strict';
import {compile,VM,format} from '../language.mjs';
import {transpileGo} from '../go-backend.mjs';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
function run(source,optimizeVectors=true){const p=compile(source),out=[],vm=new VM({...p,optimizeVectors,output:s=>out.push(s),warning:()=>{}});return {p,vm,out,stack:vm.evaluate('main')};}
test('vector push has array order and reuses uniquely owned temporary storage',()=>{
 const {stack,vm}=run('main = [0,1,2]; push 3; push 4');assert.deepEqual(stack,[[0,1,2,3,4]]);assert.equal(vm.vectorUpdates.inPlace,2);assert.equal(vm.vectorUpdates.copied,0);
 assert.equal(run('main = [1] -> xs; push xs 2').vm.vectorUpdates.inPlace,1);
 assert.equal(run('main = [1]; concat [2,3]').vm.vectorUpdates.inPlace,1);
 assert.equal(run('main = [1,2] with {.[0] ! + 2}').vm.vectorUpdates.inPlace,1);
});
test('aliases, closures, records, streams and mutable cells preserve persistent values',()=>{
 const programs=[
  'main = [1] -> xs; push xs 2; xs',
  'main = [1]; dup; push 2',
  'main = [1] -> xs; {xs} -> q; push xs 2; call q',
  'main = [1] -> xs; {x: xs} -> r; push xs 2; r.x',
  'main = [1] -> xs; map xs {+ 1} -> ys; push xs 9; toVector ys',
  'main = [1] -> mut xs; xs -> old; xs ! push 2; old; xs',
  'main = [1,2] -> xs; xs with {.[0] = 9}; xs',
  'main = [1] -> xs; [xs] -> nested; push xs 2; nested',
 ];
 for(const source of programs){const a=run(source),b=run(source,false);assert.deepEqual(a.stack,b.stack,source);assert.equal(a.vm.vectorUpdates.inPlace,0,source);}
});
test('REPL and host-provided values never transfer ownership without proof',()=>{
 const vm=new VM({warning:()=>{}});vm.evaluate('[1] -> xs');assert.deepEqual(vm.evaluate('push xs 2'),[[1,2]]);assert.deepEqual(vm.evaluate('xs'),[[1]]);assert.equal(vm.vectorUpdates.inPlace,0);
 const external=[1];assert.deepEqual(vm.evaluate('push 2',[external]),[[1,2]]);assert.deepEqual(external,[1]);
});
test('unprefixed transforms are lazy, vector transforms eager, and collection is explicit',()=>{
 const a=run('main = map [1,2] {dup; print; * 2}');assert.equal(a.stack[0].kind,'stream');assert.deepEqual(a.out,[]);
 assert.deepEqual(run('main = map [1,2] {* 2}; toVector').stack,[[2,4]]);
 assert.deepEqual(run('main = vmap [1,2] {dup; print; * 2}').out,['1','2']);
 for(const [name,args,result] of [['filter','[1,2,3] {> 1}',[2,3]],['take','[1,2,3] 2',[1,2]],['skip','[1,2,3] 1',[2,3]],['takeWhile','[1,2,3] {< 3}',[1,2]],['skipWhile','[1,2,3] {< 2}',[2,3]],['flatMap','[1,2] {-> n; [n,n]}',[1,1,2,2]],['flatten','[[1],[2]]',[1,2]]]){
  assert.deepEqual(run(`main = toVector (${name} ${args})`).stack,[result]);assert.deepEqual(run(`main = v${name} ${args}`).stack,[result]);
 }
 assert.throws(()=>new VM().infer('smap'),/Unknown word/);
});
test('vector type spelling, constraints and break continue to work',()=>{
 assert.deepEqual(run('f : vector num -> [num]\nf = push 3\nmain = f [1,2]').stack,[[1,2,3]]);
 assert.deepEqual(run('main = toVector (map [1,2,3] {when ($ == 2) {break}; * 2})').stack,[[2]]);
 assert.deepEqual(run('main = vfilter [1,2,3] {when ($ == 3) {break}; > 1}').stack,[[2]]);
 assert.deepEqual(run('main = [1,2] :: 3').stack,[[1,2,3]]);
});
test('Go performs proven updates directly and matches the copying implementation',()=>{
 const source=`main = [0,1,2]; push 3; push 4; print;
 [1] -> unique; push unique 2; print;
 [1] -> shared; print (push shared 2); print shared;
 [1,2] with {.[0] ! + 5}; print;
 print (toVector (take (map (1 ..= 5) {* 2}) 3)); print (vfilter [1,2,3] {> 1});
 ([1] -> xs; {xs} -> q; print (push xs 2); print (call q));
 ([1] -> xs; map xs {+ 1} -> ys; print (push xs 9); print (toVector ys));
 ([1] -> mut xs; xs -> old; xs ! push 2; print old; print xs);
 ([1] -> xs; [xs] -> nested; print (push xs 2); print nested)`;
 const {p,out}=run(source),code=transpileGo(p),slow=transpileGo(p,{optimizeVectors:false});
 assert.match(code,/vectorAppend\(v\d+,v\d+,false,/);assert.doesNotMatch(slow,/vectorAppend\(v\d+,v\d+,false,/);
 const dir=mkdtempSync(join(tmpdir(),'nyanco-vector-'));
 try{for(const [name,text] of [['fast',code],['copy',slow]]){const file=join(dir,name+'.go'),exe=join(dir,name+'.exe');writeFileSync(file,text);const build=spawnSync('go',['build','-o',exe,file],{encoding:'utf8',windowsHide:true,timeout:120000});assert.equal(build.status,0,build.stderr);const result=spawnSync(exe,[],{encoding:'utf8',windowsHide:true,timeout:15000});assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,out.join('\n')+'\n');}}finally{rmSync(dir,{recursive:true,force:true});}
});

test('prefix source migration preserves eager and lazy meanings without overwriting files',()=>{
 const dir=mkdtempSync(join(tmpdir(),'nyanco-vector-migrate-'));
 try{const input=join(dir,'old.nyan'),output=join(dir,'new.nyan');
  const source='main = map [1,2] {* 2}; toList (smap [2,3] {+ 1})';writeFileSync(input,source);
  const result=spawnSync(process.execPath,['migrate-v048.mjs',input,output],{encoding:'utf8',windowsHide:true});assert.equal(result.status,0,result.stderr);
  assert.equal(readFileSync(input,'utf8'),source);const converted=readFileSync(output,'utf8');assert.deepEqual(run(converted).stack,[[2,4],[3,4]]);
  const retry=spawnSync(process.execPath,['migrate-v048.mjs',input,output],{encoding:'utf8',windowsHide:true});assert.notEqual(retry.status,0);assert.equal(readFileSync(output,'utf8'),converted);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
