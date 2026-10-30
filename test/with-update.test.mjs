import test from 'node:test';
import assert from 'node:assert/strict';
import {compile,VM,format} from '../migration/v048-adapter.mjs';
import {transpileGo} from '../go-backend.mjs';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const run=(source)=>{const p=compile(source),output=[],vm=new VM({...p,output:s=>output.push(s),warning:()=>{}});return {p,vm,output,stack:vm.evaluate('main')};};
test('with copies records tuples and lists and preserves original aliases',()=>{
 assert.deepEqual(run('main = {x: 1, y: 2} -> r; r with {.x = 10; .y = 5} -> r2; r.x, r.y, r2.x, r2.y').stack,[1,2,10,5]);
 assert.deepEqual(run('main = #(1,2,3) -> t; t with {.1 = 5} -> t2; t.1, t2.1').stack,[2,5]);
 assert.deepEqual(run('main = [0,1,2] -> xs; xs with {.[1] = 3}; xs').stack,[[0,3,2],[0,1,2]]);
});
test('nested updates copy every ancestor and preserve untouched siblings',()=>{
 assert.deepEqual(run('main = {x: {y: [#(1,2),#(3,4)]}, z: 7} -> r; r with {.x.y.[1].0 = 9} -> r2; r.x.y.[1].0, r2.x.y.[1].0, r2.z').stack,[3,9,7]);
 assert.deepEqual(run('main = {x: 1} with {.x = 2; .x ! + 3}.x').stack,[5]);
});
test('prefix with and row polymorphism retain unrelated fields and allow immutable type changes',()=>{
 const {p,stack}=run('f = with {.x ! + 2};; main = f {x: 3, label: "hi"} -> r; r.x, r.label; {x: 1} with {.x = "s"}.x; #(1,2) with {.0 = "t"}.0');
 assert.deepEqual(stack,[5,'hi','s','t']);assert.match(p.types.get('f'),/x:/);
 assert.deepEqual(run('main = {x: 1, y: 2}; with {.x = 10; .y = 5}; .y').stack,[5]);
});
test('modifying updates get a fresh clause containing the selected old value',()=>{
 assert.deepEqual(run('main = {x: 3} with {.x ! _ * _}.x; [1,2] with {.[1] ! ($; *)}; #(1,2) with {.1 ! + 3}.1').stack,[9,[1,4],5]);
 assert.deepEqual(run('main = 10; {x: 1} with {.x = _}.x').stack,[10]);
 assert.throws(()=>run('main = {x: 1} with {.x ! _ + $}'),/Cannot mix/);
});
test('mutable access assignment and modification rebind roots without mutating aliases',()=>{
 assert.deepEqual(run('main = {x: {y: [1,2]}} -> mut r; r -> old; r.x.y.[1] := 5; r.x.y.[1] ! + 2; old.x.y.[1], r.x.y.[1]').stack,[2,7]);
 assert.deepEqual(run('main = #(1,2) -> mut t; t.1 ! _ * _; t.0 := 9; t').stack,[{kind:'tuple',items:[9,4]}]);
 assert.throws(()=>run('main = {x: 1} -> r; r.x := 3'),/immutable/);
 assert.throws(()=>run('main = {x: 1} -> mut r; r.x := "s"'),/Cannot unify/);
});
test('update paths and replacement arities are statically checked',()=>{
 for(const s of ['{x: 1} with {.missing = 3}','#(1,2) with {.2 = 3}','[1] with {.["s"] = 3}','[1] with {.[0] = "s"}','{x: 1} with {.x = (1,2)}','{x: 1} with {.x ! drop}'])assert.throws(()=>run('main = '+s),/Type error/);
 assert.throws(()=>run('main = {x: 1,y: 2} with {.x = 3, .y = 4}'),/using ;/);
 assert.throws(()=>run('main = {x: 1} with {.x}'),/Expected update path/);
});
test('list bounds use exn, indices run once, and failed mutation retains the root',()=>{
 const {p,stack,output}=run('index = print "index"; 0;; main = [1] with {.[index] ! + 2}');assert.deepEqual(stack,[[3]]);assert.deepEqual(output,['index']);assert.match(p.types.get('main'),/exn/);
 for(const index of ['-1','1','0.5'])assert.deepEqual(run(`main = handle {[1] with {.[${index}] = 9}; drop; 0} {exn: {-> message k; 7}}`).stack,[7]);
 assert.deepEqual(run('main = [1] -> mut xs; handle {xs.[3] := 9} {exn: {-> message k; nop}}; xs').stack,[[1]]);
});
test('effects, dependencies and typed class dispatch work inside update expressions',()=>{
 assert.deepEqual(run('main = {x: 1} with {.x = later}.x;; later = 8').stack,[8]);
 assert.deepEqual(run("class zero 'a where\n  zero : -> 'a\ninstance zero num where\n  zero = 0\nmain = {x: 1} with {.x = zero}.x; + 2").stack,[2]);
 assert.deepEqual(run('main = handle {{x: 1} with {.x ! exn "stop"}; drop} {exn: {-> message k; 9}}').stack,[9]);
});
test('Go persistent updates and mutable sugar agree with the VM',()=>{
 const source=`bump = with {.x.y.[1].0 ! _ + 5};;
main = {x: {y: [#(1,2),#(3,4)]}, z: 7} -> mut r; r -> old;
 r.x.y.[0].1 := 9; r.x.y.[1].0 ! + 2;
 print old; print r; print (bump r);
 print (#(1,2) with {.0 = "s"}); print ([1,2] with {.[1] ! ($; *)});
 print ({x: 1,y: 2} with {.x = 10; .y ! + 5});
 handle {r.x.y.[9].0 := 5} {exn: {-> message k; print message}}; print r`;
 const {p,output}=run(source),dir=mkdtempSync(join(tmpdir(),'nyanco-with-'));
 try{const file=join(dir,'main.go'),exe=join(dir,'main.exe');writeFileSync(file,transpileGo(p));const build=spawnSync('go',['build','-o',exe,file],{encoding:'utf8',windowsHide:true,timeout:120000});assert.equal(build.status,0,build.stderr);const result=spawnSync(exe,[],{encoding:'utf8',windowsHide:true,timeout:15000});assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,output.join('\n')+'\n');}finally{rmSync(dir,{recursive:true,force:true});}
});
