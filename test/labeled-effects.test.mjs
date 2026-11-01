import test from 'node:test';
import assert from 'node:assert/strict';
import {compile,VM} from '../migration/v048-adapter.mjs';
import {transpileGo} from '../go-backend.mjs';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const run=source=>{const p=compile(source),output=[],vm=new VM({...p,output:s=>output.push(s)});return {p,output,stack:vm.evaluate('main')};};
test('cancel leaves last completed loop state and handles producer breaks',()=>{
 const result=run(`main =
  0; each [1,2,3] {when ($ == 2) {cancel}; +};
  0; while {$ < 5} {+ 1; when ($ == 3) {cancel}};
  map [1,2,3] {when ($ == 2) {cancel}; * 10};
  filter [1,2,3] {when ($ == 3) {cancel}; > 0};
  fold [1,2,3] 0 {when ($ == 2) {cancel}; +};
  toList (fromYield {yield 1; cancel; yield 2})`);
 assert.deepEqual(result.stack,[1,2,[10],[1,2],1,[1]]);
 assert.doesNotMatch(result.p.types.get('main'),/cancel/);
 assert.throws(()=>new VM().evaluate('cancel'),/Unhandled effect: cancel/);
});
test('unlabelled cancel stops the nearest loop; labelled cancel crosses nested loops',()=>{
 const result=run(`main =
  @outer each [1,2] {-> x; each [3,4] {-> y; print #(x,y); cancel}; print x};
  @outer each [1,2] {-> x; each [3,4] {-> y; print #(x,y); cancel@outer}; print "unreachable"}`);
 assert.deepEqual(result.output,['#(1 3)','1','#(2 3)','2','#(1 3)']);
});
test('plain masks skip one matching handler; nested masks skip two',()=>{
 const result=run(`effect ask: -> int
main = handle {handle {handle {mask ask {mask ask {ask}}} {ask:{-> k; resume 3 k}}} {ask:{-> k; resume 2 k}}} {ask:{-> k; resume 1 k}}`);
 assert.deepEqual(result.stack,[1]);assert.doesNotMatch(result.p.types.get('main'),/ask/);
});
test('named effects and named mask select their handler and preserve inner handlers',()=>{
 const result=run(`effect ask: -> int
main = @outer handle {
  @inner handle {ask@outer; mask ask@outer {ask}; ask;
    mask ask@outer {handle {ask} {ask:{-> k; resume 3 k}}}} {ask:{-> k; resume 2 k}}
} {ask:{-> k; resume 1 k}}`);
 assert.deepEqual(result.stack,[1,1,2,3]);
 assert.deepEqual(run('main = 3, mask put {_}').stack,[3]);
});
test('labelled yields cross inner generators and labelled generators survive REPL storage',()=>{
 const result=run('main = toList (@outer fromYield {yield 1; each (fromYield {yield@outer 2; yield 3}) {yield}})');
 assert.deepEqual(result.stack,[[1,2,3]]);
 const vm=new VM();vm.evaluate('@producer fromYield {yield@producer 7} -> xs');assert.deepEqual(vm.evaluate('toList xs'),[[7]]);assert.deepEqual(vm.evaluate('toList xs'),[[7]]);
});
test('labels resolve lexically and invalid or escaping references are rejected',()=>{
 assert.throws(()=>compile('main = cancel@missing'),/Unknown effect label/);
 assert.throws(()=>compile('main = @x each [1] {drop; ask@x}'),/Only effect operations/);
 assert.throws(()=>compile('effect ask: -> int\nmain = @x each [1] {drop; ask@x; drop}'),/does not handle/);
 assert.throws(()=>compile('effect ask: -> int\nmain = @x handle {{ask@x}} {ask:{-> k; resume 1 k}}'),/escapes/);
 assert.throws(()=>compile('effect ask: -> int\nmain = {0} -> mut saved; @x handle {saved := {ask@x}} {ask:{-> k; resume 1 k}}; call saved'),/escapes/);
 assert.throws(()=>compile('main = @x print 1'),/Label requires/);
 assert.throws(()=>compile('main = @x each [1] {print@x}'),/Only effect operations/);
 assert.throws(()=>compile('main = mask missing {nop}'),/Unknown effect operation/);
});
test('condition cancel is handled, while mutable changes are retained',()=>{
 assert.deepEqual(run('main = 5; while {cancel} {nop}').stack,[5]);
 assert.deepEqual(run('main = 0 -> mut n; while {n ! (+ 1); when (n == 3) {cancel}; True} {nop}; n').stack,[3]);
});
test('callbacks from named functions can be masked and mask changes remain visible in types',()=>{
 const result=run('stop = cancel\nmain = @outer each [1] {drop; each [2] {drop; mask cancel@outer {stop}}}');assert.deepEqual(result.stack,[]);
 assert.throws(()=>compile('bad : -> / {}\nbad = each [1] {drop; mask cancel {cancel}}'),/Effect cancel is not allowed/);
});
test('Go labelled handlers, loop exits, masks and yielded streams match interpreter',()=>{
 const source=`effect state 'a where
  ask: -> 'a
data box = Box [int]
instance streem box where
  item : int
  each (Box xs) f = each xs {call f}; 99; call f
main =
  [] -> mut seen;
  each (Box [1,2,3]) {-> x; when (x == 2) {cancel}; seen ! (:: x)}; print seen;
  @outer handle {handle {ask@outer; print; mask ask {ask}; print; ask; print} {ask:{-> k; resume 2 k}}} {ask:{-> k; resume 1 k}};
  0; each [1,2,3] {when ($ == 2) {cancel}; +}; print;
  0; while {$ < 5} {+ 1; when ($ == 3) {cancel}}; print;
  5; while {cancel} {nop}; print;
  @outer handle {handle {ask@outer; print; ask; print} {ask:{-> k; resume "inner" k}}} {ask:{-> k; resume 1 k}};
  print (toList (@outer fromYield {each (fromYield {yield@outer 1; yield "inner"}) {print}}));
  @outer each [1,2] {-> x; each [3,4] {-> y; print #(x,y); cancel@outer}; print "unreachable"};
  print (map [1,2,3] {when ($ == 2) {cancel}; * 10});
  print (toList (@outer fromYield {yield 1; each (fromYield {yield@outer 2; yield 3}) {yield}}));
  handle {handle {handle {mask ask {mask ask {ask}}} {ask:{-> k; resume 3 k}}} {ask:{-> k; resume 2 k}}} {ask:{-> k; resume 1 k}}; print
`;
 const {output}=run(source),p=compile(source),dir=mkdtempSync(join(tmpdir(),'nyanco-label-'));
 try{const file=join(dir,'main.go'),exe=join(dir,'main.exe');writeFileSync(file,transpileGo(p));const built=spawnSync('go',['build','-o',exe,file],{encoding:'utf8',windowsHide:true,timeout:120000});assert.equal(built.status,0,built.stderr);const result=spawnSync(exe,[],{encoding:'utf8',windowsHide:true,timeout:15000});assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,output.join('\n')+'\n');}finally{rmSync(dir,{recursive:true,force:true});}
});

test('effect parameters follow the destination handler rather than intervening handlers',()=>{
 const result=run(`effect state 'a where
  ask: -> 'a
main = @outer handle {handle {ask@outer; ask} {ask:{-> k; resume "inner" k}}} {ask:{-> k; resume 1 k}}`);
 assert.deepEqual(result.stack,[1,'inner']);
 const generated=run('main = toList (@outer fromYield {each (fromYield {yield@outer 1; yield "inner"}) {print}})');
 assert.deepEqual(generated.stack,[[1]]);assert.deepEqual(generated.output,['inner']);
});
