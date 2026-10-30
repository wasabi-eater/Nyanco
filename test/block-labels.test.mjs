import test from 'node:test';
import assert from 'node:assert/strict';
import {compile,VM} from '../language.mjs';
import {transpileGo} from '../go-backend.mjs';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const run=source=>{const p=compile(source),output=[],vm=new VM({...p,output:s=>output.push(s),warning:()=>{}});return {p,output,vm,stack:vm.evaluate('main')};};
const ask='effect ask : -> num\n';
test('labelled blocks work through a user loop wrapper',()=>{
 const {stack,output,p}=run('loop = while {True} _\nmain = 1; loop @a {* 2; print $; when ($ > 2000) {break@a}}');
 assert.deepEqual(output,Array.from({length:11},(_,i)=>String(2**(i+1))));assert.deepEqual(stack,[1024]);assert.doesNotMatch(p.types.get('main'),/break/);
});
test('outer and inner block contexts select the intended handler and resume in place',()=>{
 const result=run(ask+'main = handle @outer {handle @inner {ask@inner; ask@outer; ask} {ask: {-> k; resume 20 k}}; ask@outer} {ask: {-> k; resume 10 k}}');
 assert.deepEqual(result.stack,[20,10,20,10]);assert.doesNotMatch(result.p.types.get('main'),/ask/);
});
test('labels bind at each invocation, including stored blocks and wrapper functions',()=>{
 const source=ask+'invoke action = call action\nmain = @h {ask@h} -> q; handle {invoke q} {ask: {-> k; resume 10 k}}; handle {invoke q} {ask: {-> k; resume 20 k}}';
 assert.deepEqual(run(source).stack,[10,20]);
 const vm=new VM(compile(ask));vm.evaluate('@h {ask@h} -> q');assert.deepEqual(vm.evaluate('handle {call q} {ask: {-> k; resume 7 k}}'),[7]);assert.deepEqual(vm.evaluate('handle {call q} {ask: {-> k; resume 9 k}}'),[9]);
});
test('inner loops cannot intercept a break routed to the outer block context',()=>{
 assert.deepEqual(run('main = 0; each [1,2] @outer {drop; each [3,4] @inner {drop; + 1; break@outer}; print "bad"}').stack,[0]);
 const result=run('main = each [1,2] @outer {-> n; each [3,4] @inner {drop; break@inner}; print n}');assert.deepEqual(result.output,['1','2']);
});
test('one block label can name multiple operations with different enclosing handlers',()=>{
 const source='effect ask : -> num\neffect tell : num ->\nmain = handle {handle @h {tell@h (ask@h)} {ask: {-> k; resume 12 k}}} {tell: {-> n k; print n; resume k}}';
 assert.deepEqual(run(source).output,['12']);
});
test('recursion and shadowing give each activation its own label identity',()=>{
 const source=ask+'f n = handle @a {when (n > 0) {f (n - 1); print}; ask@a} {ask: {-> k; resume n k}}\nmain = f 2';
 assert.deepEqual(run(source).stack,[2]);assert.deepEqual(run(source).output,['0','1']);
 assert.deepEqual(run(ask+'main = handle @a {handle @a {ask@a} {ask: {-> k; resume 2 k}}; ask@a} {ask: {-> k; resume 1 k}}').stack,[2,1]);
});
test('labels work in deferred streams and mask retains its routing semantics',()=>{
 assert.deepEqual(run('main = toVector (fromYield @a {yield@a 1; yield@a 2})').stack,[[1,2]]);
 assert.deepEqual(run('main = toVector (map [1,2,3] @a {when ($ == 2) {break@a}; * 2})').stack,[[2]]);
 assert.deepEqual(run('stop = break\nmain = each [1] @a {drop; each [2] {drop; mask break@a {stop}}; print "bad"}').stack,[]);
 assert.deepEqual(run('main = each [1] @a {drop; each [2] {drop; mask break {break}}; print "bad"}').stack,[]);
});
test('labelled blocks cannot leak their active label through results, cells, streams or effect payloads',()=>{
 for(const src of ['main = call @a {{break@a}}','main = call @a {fromYield {yield 1; break@a}}','effect send : {-> ! / {break}} ->\nmain = call @a {send {break@a}}','main = {nop} -> mut saved; call @a {saved := {break@a}}'])assert.throws(()=>compile(src),/escape|Effect|Cannot unify/i,src);
 assert.throws(()=>compile('main = call @a {nop}; break@a'),/Unknown effect label/);
 assert.deepEqual(run('main = call @a {fromYield @b {yield@b 1}}; toVector').stack,[[1]]);
});
test('missing handlers stay effects and host IO routing works with async calls',async()=>{
 const p=compile('f = call @a {break@a}');assert.match(p.types.get('f'),/break/);assert.throws(()=>new VM(p).evaluate('f'),/Unhandled effect: break/);
 const output=[],vm=new VM({input:async()=> 'hello',output:s=>output.push(s)});
 assert.deepEqual(await vm.evaluateAsync('call @a {read@a; put@a}'),[]);assert.deepEqual(output,['hello']);
});
test('block labels survive type-directed class dispatch',()=>{
 const source=ask+"class zero 'a where\n  zero : -> 'a\ninstance zero num where\n  zero = 0\nmain = handle @h {ask@h; + 1} {ask: {-> k; resume zero k}}";
 assert.deepEqual(run(source).stack,[1]);
});
test('Go block labels agree with VM across wrappers, reentry, streams and effects',()=>{
 const source=ask+`class zero 'a where
  zero : -> 'a
instance zero num where
  zero = 0
loop = while {True} _
invoke q = call q
f n = handle @a {when (n > 0) {f (n - 1); print}; ask@a} {ask: {-> k; resume n k}}
main =
  1; loop @a {* 2; print $; when ($ > 8) {break@a}}; print;
  handle @outer {handle @inner {print ask@inner; print ask@outer} {ask: {-> k; resume 20 k}}} {ask: {-> k; resume 10 k}};
  @h {ask@h} -> q;
  handle {print (invoke q)} {ask: {-> k; resume 7 k}};
  handle {print (invoke q)} {ask: {-> k; resume 9 k}};
  print (f 2);
  each [1] @outer {drop; each [2] @inner {drop; break@outer}; print "bad"};
  print (toVector (fromYield @a {yield@a 1; yield@a 2}));
  print (toVector (map [1,2,3] @a {when ($ == 2) {break@a}; * 2}));
  print (handle @h {ask@h; + 1} {ask: {-> k; resume zero k}})`;
 const {p,output}=run(source),dir=mkdtempSync(join(tmpdir(),'hst-block-label-'));
 try{const file=join(dir,'main.go'),exe=join(dir,'main.exe');writeFileSync(file,transpileGo(p));const build=spawnSync('go',['build','-o',exe,file],{encoding:'utf8',windowsHide:true,timeout:120000});assert.equal(build.status,0,build.stderr);const result=spawnSync(exe,[],{encoding:'utf8',windowsHide:true,timeout:15000});assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,output.join('\n')+'\n');}finally{rmSync(dir,{recursive:true,force:true});}
});
