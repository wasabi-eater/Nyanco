import test from 'node:test';
import assert from 'node:assert/strict';
import {compile,VM} from '../language.mjs';
import {transpileGo} from '../go-backend.mjs';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const run=s=>{const p=compile(s),output=[],vm=new VM({...p,output:s=>output.push(s),warning:()=>{}});return {p,output,stack:vm.evaluate('main')};};
const source=`main =
 print (toVector (take (iterate {1,0} {_1 + _, _1}) 8));
 print (toVector (iterate {cancel} {+ 1}));
 print (toVector (iterate {0} {when ($ >= 3) {cancel}; + 1}));
 print (toVector (iterate @s {0; cancel@s} {+ 1}));
 print (toVector (iterate {0} @c {when ($ >= 2) {cancel@c}; + 1}));
 0; loop {when ($ >= 3) {cancel}; + 1}; print;
 print (toVector (take (iterate {print "start"; 0} {+ 1}) 2));
 print (toVector (take (iterate {0} {print "unexpected cont"; + 1}) 1));
 print (toVector (take (repeat "x") 3));
 mut n <- 0;
 xs <- repeatWith {n ! + 1; n};
 print n;
 print (toVector (take xs 0));
 print (toVector (take xs 3));
 print n;
 print (nth xs 0)`;
test('standard loops and iterate support multiple state values and cancel in either block',()=>{
 assert.deepEqual(run(source).output,['[0, 1, 1, 2, 3, 5, 8, 13]','[]','[0, 1, 2, 3]','[]','[0, 1, 2]','3','start','[0, 1]','[0]','["x", "x", "x"]','0','[]','[1, 2, 3]','3','(Some 4)']);
 const vm=new VM();vm.evaluate('iterate {0} {+ 1} -> xs');assert.deepEqual(vm.evaluate('toVector (take xs 3)'),[[0,1,2]]);assert.deepEqual(vm.evaluate('toVector (take xs 2)'),[[0,1]]);
 assert.match(compile('f = iterate {print "start"; 0} {+ 1}').types.get('f'),/stream.*io/);
 assert.doesNotMatch(compile('f = iterate {0} {when ($ > 2) {cancel}; + 1}').types.get('f'),/cancel/);
 assert.throws(()=>compile('main = iterate {0} {"bad"}'),/unify|stack/i);
 assert.match(vm.infer('repeatWith {read}'),/stream string.*io/);
 assert.equal(vm.infer('nth (repeatWith {read}) 0'),'..s -> ..s (option string) / {io}');
 assert.throws(()=>vm.infer('repeatWith {1, 2}'),/stack|underflow/i);
 assert.throws(()=>vm.infer('repeatWith {drop; 1}'),/stack|underflow/i);
});
test('standard iterate lowers to native calls and supports lazy cancellation',()=>{
 const {p,output}=run(source),dir=mkdtempSync(join(tmpdir(),'nyanco-iterate-'));
 try{const file=join(dir,'main.go'),exe=join(dir,'main.exe');writeFileSync(file,transpileGo(p));const build=spawnSync('go',['build','-o',exe,file],{encoding:'utf8',windowsHide:true,timeout:120000});assert.equal(build.status,0,build.stderr);const result=spawnSync(exe,[],{encoding:'utf8',windowsHide:true,timeout:15000});assert.equal(result.status,0,result.stderr+result.stdout);assert.equal(result.stdout,output.join('\n')+'\n');}finally{rmSync(dir,{recursive:true,force:true});}
});
