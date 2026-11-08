import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {compile,VM} from '../migration/v048-adapter.mjs';
import {transpileGo} from '../go-backend.mjs';
const run=source=>new VM({warning:()=>{}}).evaluate(source);
test('list indexing supports expressions, chaining, projections and accessor functions',()=>{
 assert.deepEqual(run('[10,20,30] -> x; x.[1]'),[20]);
 assert.deepEqual(run('[10,20,30] -> x; 1 -> i; x.[i + 1]'),[30]);
 assert.deepEqual(run('[[10,20],[30,40]].[1].[0]'),[30]);
 assert.deepEqual(run('[[10,20],[30,40]].[-1].[-2]'),[30]);
 assert.deepEqual(run('{items: [10,20]}.items.[1]'),[20]);
 assert.deepEqual(run('[{n: 10}].[0].n'),[10]);
 assert.deepEqual(run('.[1] [10,20]'),[20]);
 assert.deepEqual(run('1; [10,20].[_]'),[20]);
 assert.deepEqual(run('[10,20].[0] + [30,40].[1]'),[50]);
});
test('list index effects are inferred and handled, with typed indices and results',()=>{
 const p=compile('get xs i = xs.[i]\nmain : -> string / {}\nmain = handle {get ["x"] 2} {exn: {-> msg k; msg}}');
 assert.match(p.types.get('get'),/exn/);
 assert.deepEqual(new VM(p).evaluate('main'),['Index out of bounds: 2']);
 for(const expr of ['[1].["x"]','3.[0]','[1].[0,1]','[1].[]'])assert.throws(()=>run(expr),/Type error/);
 assert.throws(()=>compile('f : -> int / {}\nf = [1].[0]'),/Effect exn is not allowed/);
 assert.throws(()=>run('handle {[1].[9]} {exn: {-> msg k; resume k}}'),/non-returning|bottom|resume/i);
});
test('invalid indices raise exn, abort the body, and forward through nested handlers',()=>{
 for(const index of ['-2','1','9007199254740991']){
  assert.throws(()=>run(`[1].[${index}]`),/Exception: Index out of bounds/);
  assert.deepEqual(run(`handle {handle {[1].[${index}]; drop; 99} {:}} {exn: {-> msg k; 42}}`),[42]);
 }
 assert.deepEqual(run('handle {[].[0]} {exn: {-> msg k; 42}}'),[42]);
 assert.deepEqual(run('handle {exn "oops"} {exn: {-> msg k; msg}}'),['oops']);
 const output=[],vm=new VM({output:s=>output.push(s)});
 assert.deepEqual(vm.evaluate('handle {[1].[3]; drop; print "unreachable"} {exn: {-> msg k; nop}}'),[]);
 assert.deepEqual(output,[]);
});
test('native list access and exception handling match interpreter',()=>{
 const p=compile(`index xs i = xs.[i]
main =
  0 -> mut count;
  print [10,20].[count ! (+ 1); count]; print count;
  handle {[1].[exn "index failure"]} {exn: {-> msg k; 42}}; print;
  handle {[1].[9007199254740991]} {exn: {-> msg k; print msg; 42}}; print;
  print [10,20].?[1]; print [10,20].?[9]; print [10].?[-1]; print [10].?[2];
  [10].?[0] -> Some item; print item;
  print (index [10,20] 1);
  print [[10],[20]].[1].[0];
  1; [10,20].[_]; print;
  handle {index [10] -2; drop; print "unreachable"} {exn: {-> msg k; print msg}};
  handle {handle {[1].[2]} {:}} {exn: {-> msg k; 42}}; print;
  handle {exn "explicit"} {exn: {-> msg k; print msg}}`);
 const output=[],vm=new VM({...p,output:s=>output.push(s)});vm.evaluate('main');
 const dir=mkdtempSync(join(tmpdir(),'nyanco-index-'));
 try {
  const source=join(dir,'main.go'),exe=join(dir,'main.exe');writeFileSync(source,transpileGo(p));
  const build=spawnSync('go',['build','-o',exe,source],{encoding:'utf8',windowsHide:true,timeout:120000,env:{...process.env,CGO_ENABLED:'0',GOWORK:'off',GO111MODULE:'off'}});
  assert.equal(build.status,0,build.stderr);
  const result=spawnSync(exe,[],{encoding:'utf8',windowsHide:true,timeout:15000});assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,output.join('\n')+'\n');
  writeFileSync(source,transpileGo(p,{expression:'[1].[9]'}));
  const failedBuild=spawnSync('go',['build','-o',exe,source],{encoding:'utf8',windowsHide:true,timeout:120000});assert.equal(failedBuild.status,0,failedBuild.stderr);
  const failed=spawnSync(exe,[],{encoding:'utf8',windowsHide:true,timeout:15000});assert.notEqual(failed.status,0);assert.match(failed.stderr,/Exception: Index out of bounds/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
