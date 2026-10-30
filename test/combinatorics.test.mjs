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
 print (toVector (permutations [1,2,3] 2));
 print (toVector (combinations (1 ..= 3) 2));
 print (toVector (combinationsWithReplacement [1,2] 2));
 print (toVector (cartesianProduct [1,2] ["a","b"]));
 print (toVector (powerset [1,2]));
 print (toVector (take (permutations (1 ..= 10) 10) 2));
 print (toVector (combinations [] 0));
 print (toVector (permutations [1] 2));
 print (toVector (combinations [1,1,2] 2));
 print (toVector (combinations (fromYield {yield 1; yield 2; break; yield 3}) 1));
 each (powerset [1,2]) {print $; break};
 print (handle {combinations [1] (-1); drop; "valid"} {exn: {-> msg k; "invalid"}})`;
test('combinatorial streams enumerate positions, preserve order and handle edges',()=>{
 assert.deepEqual(run('main = toVector (combinationsWithReplacement [1,2] 2)').stack,[[[1,1],[1,2],[2,2]]]);
 assert.deepEqual(run('main = toVector (powerset [1,2])').stack,[[[],[1],[2],[1,2]]]);
 assert.deepEqual(run('main = toVector (permutations [] 0)').stack,[[[]]]);
 assert.deepEqual(run('main = toVector (cartesianProduct [] [1])').stack,[[]]);
 const vm=new VM();vm.evaluate('combinations [1,2,3] 2 -> choices');assert.deepEqual(vm.evaluate('toVector choices'),[[[1,2],[1,3],[2,3]]]);assert.deepEqual(vm.evaluate('toVector choices'),[[[1,2],[1,3],[2,3]]]);
 assert.match(compile('f = combinations').types.get('f'),/streem/);
 assert.match(compile('f = combinations (fromYield {print "read"; yield 1}) 1; toVector').types.get('f'),/io/);
 assert.throws(()=>run('main = combinations [1] (-1)'),/nonnegative/);
 assert.throws(()=>new VM({maxSteps:100}).evaluate('combinationsWithReplacement [1] 1000000000; toVector'),/step limit/);
});
test('Go combinatorial streams agree with VM including lazy cancellation and effects',()=>{
 const {p,output}=run(source),dir=mkdtempSync(join(tmpdir(),'nyanco-combinations-'));
 try{const file=join(dir,'main.go'),exe=join(dir,'main.exe');writeFileSync(file,transpileGo(p));const build=spawnSync('go',['build','-o',exe,file],{encoding:'utf8',windowsHide:true,timeout:120000});assert.equal(build.status,0,build.stderr);const result=spawnSync(exe,[],{encoding:'utf8',windowsHide:true,timeout:15000});assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,output.join('\n')+'\n');}finally{rmSync(dir,{recursive:true,force:true});}
});

