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
 print (toVector (iterate {break} {+ 1}));
 print (toVector (iterate {0} {when ($ >= 3) {break}; + 1}));
 print (toVector (iterate @s {0; break@s} {+ 1}));
 print (toVector (iterate {0} @c {when ($ >= 2) {break@c}; + 1}));
 0; loop {when ($ >= 3) {break}; + 1}; print;
 print (toVector (take (iterate {print "start"; 0} {+ 1}) 2));
 print (toVector (take (iterate {0} {print "unexpected cont"; + 1}) 1))`;
test('standard loops and iterate support multiple state values and break in either block',()=>{
 assert.deepEqual(run(source).output,['[0, 1, 1, 2, 3, 5, 8, 13]','[]','[0, 1, 2, 3]','[]','[0, 1, 2]','3','start','[0, 1]','[0]']);
 const vm=new VM();vm.evaluate('iterate {0} {+ 1} -> xs');assert.deepEqual(vm.evaluate('toVector (take xs 3)'),[[0,1,2]]);assert.deepEqual(vm.evaluate('toVector (take xs 2)'),[[0,1]]);
 assert.match(compile('f = iterate {print "start"; 0} {+ 1}').types.get('f'),/stream.*io/);
 assert.doesNotMatch(compile('f = iterate {0} {when ($ > 2) {break}; + 1}').types.get('f'),/break/);
 assert.throws(()=>compile('main = iterate {0} {"bad"}'),/unify|stack/i);
});
test('standard iterate lowers to native calls and supports lazy cancellation',()=>{
 const {p,output}=run(source),dir=mkdtempSync(join(tmpdir(),'hst-iterate-'));
 try{const file=join(dir,'main.go'),exe=join(dir,'main.exe');writeFileSync(file,transpileGo(p));const build=spawnSync('go',['build','-o',exe,file],{encoding:'utf8',windowsHide:true,timeout:120000});assert.equal(build.status,0,build.stderr);const result=spawnSync(exe,[],{encoding:'utf8',windowsHide:true,timeout:15000});assert.equal(result.status,0,result.stderr+result.stdout);assert.equal(result.stdout,output.join('\n')+'\n');}finally{rmSync(dir,{recursive:true,force:true});}
});
