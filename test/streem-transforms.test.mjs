import test from 'node:test';
import assert from 'node:assert/strict';
import {compile,VM} from '../migration/v048-adapter.mjs';
import {transpileGo} from '../go-backend.mjs';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const run=source=>{const p=compile(source),output=[],vm=new VM({...p,output:s=>output.push(s)});return {p,output,stack:vm.evaluate('main')};};
const box=`data box 'a = Box ['a]
instance streem (box 'a) where
  item : 'a
  each (Box xs) f = each xs f
`;
test('streem is the constraint class and each remains its method',()=>{
 const p=compile(box+'collect xs = toList xs\nmain = toList (Box [1,2])');
 assert.ok(p.definitions.classes.has('streem'));assert.equal(p.definitions.classes.has('each'),false);
 assert.match(p.types.get('collect'),/^streem /);assert.deepEqual(new VM(p).evaluate('main'),[[1,2]]);
 assert.throws(()=>compile("instance each [int] where\n  item: int\n  each xs f = nop"),/Unknown class: each/);
 for(const old of ['lmap','lfilter'])assert.throws(()=>new VM().infer(old),/Unknown word/);
});
test('lazy transforms and list counterparts agree on values, boundaries, and empty sources',()=>{
 for(const [lazy,eager,args,expected] of [
  ['smap','map','[1,2,3] {* 2}',[2,4,6]],
  ['sfilter','filter','[1,2,3] {> 1}',[2,3]],
  ['stake','take','[1,2,3] 2',[1,2]],
  ['sskip','skip','[1,2,3] 2',[3]],
  ['stakeWhile','takeWhile','[1,2,3,1] {< 3}',[1,2]],
  ['sskipWhile','skipWhile','[1,2,3,1] {< 3}',[3,1]],
  ['sflatMap','flatMap','[1,2] {-> n; [n,n + 10]}',[1,11,2,12]],
  ['sflatten','flatten','[[1,2],[],[3]]',[1,2,3]],
 ]) {
  assert.deepEqual(run(`main = toList (${lazy} ${args}); ${eager} ${args}`).stack,[expected,expected]);
 }
 assert.deepEqual(run('main = take [] 3; skip [] 3; take [1,2] 0; skip [1,2] 0; take [1] 9; skip [1] 9; flatten []').stack,[[],[],[],[1,2],[1],[],[]]);
});
test('all transforms accept user streem instances and flatten their nested instances',()=>{
 const result=run(box+`main = toList (stake (Box [1,2,3]) 2); toList (sflatten (Box [Box [1,2],Box [3]])); flatMap (Box [1,2]) {-> n; Box [n,n + 1]}`);
 assert.deepEqual(result.stack,[[1,2],[1,2,3],[1,2,2,3]]);
});
test('take cancels immediately without overreading; zero take does not start source',()=>{
 const result=run(`main = fromYield {print "start"; yield 1; print "after1"; yield 2; print "after2"; yield 3} -> xs;
  toList (stake xs 0); toList (stake xs 1); takeWhile xs {< 2}`);
 assert.deepEqual(result.stack,[[],[1],[1]]);assert.deepEqual(result.output,['start','start','after1']);
});
test('skipWhile only calls the predicate until the first false result and restarts each traversal',()=>{
 const result=run(`main = 0 -> mut calls;
  sskipWhile [1,2,3,1] {calls ! (+ 1); < 3} -> xs;
  calls; toList xs; calls; toList xs; calls`);
 assert.deepEqual(result.stack,[0,[3,1],3,[3,1],6]);
});
test('transforms handle cancel locally and preserve partial results',()=>{
 for(const [lazy,eager,expected] of [['smap','map',[1]],['sfilter','filter',[1]],['stakeWhile','takeWhile',[1]],['sskipWhile','skipWhile',[]],['sflatMap','flatMap',[1,11]]]) {
  const body=`when ($ == 2) {cancel}; ${lazy==='sflatMap'?'-> n; [n,n + 10]':lazy==='smap'?'nop':'> 0'}`;
  assert.deepEqual(run(`main = toList (${lazy} [1,2,3] {${body}}); ${eager} [1,2,3] {${body}}`).stack,[expected,expected]);
 }
 for(const expression of ['stake (fromYield {yield 1; cancel; yield 2}) 5','sskip (fromYield {yield 1; cancel; yield 2}) 0','sflatten [fromYield {yield 1; cancel; yield 2},fromYield {yield 3}]'])
  assert.deepEqual(run(`main = toList (${expression})`).stack,[[1]]);
});
test('downstream breaks and labelled or masked breaks reach the intended operation',()=>{
 const result=run(`main =
  0; each (smap [1,2,3] {* 2}) {when ($ == 4) {cancel}; +};
  toList (@mapped smap [1,2,3] {when ($ == 2) {cancel@mapped}; * 2});
  @outer each [1] {drop; toList (stakeWhile [1,2] {drop; cancel@outer}); drop; print "bad"};
  toList (sflatMap [1,2] {-> n; smap [n,9] {when ($ == 9) {mask cancel {cancel}}; nop}})`);
 assert.deepEqual(result.stack,[2,[2],[1]]);assert.deepEqual(result.output,[]);
});
test('deferred source, mapper and flattened stream effects are inferred',()=>{
 const p=compile('make = sflatMap [1] {drop; fromYield {print "x"; yield 1}}\nmain = toList make');
 assert.match(p.types.get('make'),/stream int.*io/);assert.match(p.types.get('main'),/\/ \{io\}$/);
 assert.throws(()=>compile('main : -> [int] / {}\nmain = flatten [fromYield {print "x"; yield 1}]'),/Effect io is not allowed/);
 assert.throws(()=>compile('main = sflatMap [1] {+ 1}'),/No instance/);
 assert.throws(()=>compile('main = sflatten [1,2]'),/No instance/);
 assert.throws(()=>compile('main = stakeWhile [1] {+ 1}'),/Cannot unify/);
});
test('counts reject invalid numbers with exn and streams retain types in the REPL',()=>{
 for(const name of ['stake','sskip','take','skip'])for(const n of ['-1','9999999999999999']){
  assert.deepEqual(run(`main = handle {${name} [1,2] ${n}; drop} {exn: {-> message k; nop}}`).stack,[]);
 }
 const vm=new VM();vm.evaluate('stake (1 ..= 9) 2 -> xs');assert.deepEqual(vm.evaluate('toList xs'),[[1,2]]);
 vm.evaluate('sflatten [[1],[2]] -> flat');assert.deepEqual(vm.evaluate('toList flat'),[[1,2]]);
});
test('native new transforms, cancellation and cancel routing agree with interpreter',()=>{
 const source=box+`main =
  print (flatten []); print (toList (sflatten [])); print (flatMap [] {drop; []});
  print (toList (stake (smap (1 ..= 8) {* 2}) 3));
  print (toList (sskipWhile [1,2,3,1] {< 3}));
  print (takeWhile [1,2,3,1] {< 3}); print (skip [1,2,3] 2);
  print (toList (sflatten (Box [Box [1,2],Box [3]])));
  print (flatMap (Box [1,2]) {-> n; Box [n,n + 10]});
  fromYield {yield 1; print "after1"; yield 2; print "after2"} -> xs;
  print (toList (stake xs 0)); print (toList (stake xs 1)); print (takeWhile xs {< 2});
  print (toList (@mapped smap [1,2,3] {when ($ == 2) {cancel@mapped}; * 2}));
  @outer each [1] {drop; toList (stakeWhile [1,2] {drop; cancel@outer}); drop; print "bad"};
  0; each (smap [1,2,3] {* 2}) {when ($ == 4) {cancel}; +}; print;
  print (toList (sflatMap [1,2] {-> n; smap [n,9] {when ($ == 9) {mask cancel {cancel}}; nop}}));
  print (toList (sflatMap [1] {drop; cancel}));
  handle {take [1] -1; drop} {exn: {-> message k; print message}}`;
 const {output}=run(source),p=compile(source),dir=mkdtempSync(join(tmpdir(),'nyanco-streem-'));
 try{const file=join(dir,'main.go'),exe=join(dir,'main.exe');writeFileSync(file,transpileGo(p));const build=spawnSync('go',['build','-o',exe,file],{encoding:'utf8',windowsHide:true,timeout:120000});assert.equal(build.status,0,build.stderr);const result=spawnSync(exe,[],{encoding:'utf8',windowsHide:true,timeout:15000});assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,output.join('\n')+'\n');}finally{rmSync(dir,{recursive:true,force:true});}
});
