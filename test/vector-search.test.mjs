import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {compile,VM,format} from '../language.mjs';
import {transpileGo} from '../go-backend.mjs';
import {transpileCpp} from '../cpp-backend.mjs';
import {standardTokens} from '../modules.mjs';
import {LanguageService} from '../lsp.mjs';

const source=`data reversed = Reversed int deriving eq
instance ord reversed where
    (<) (Reversed a) (Reversed b) = a > b
    (<=) (Reversed a) (Reversed b) = a >= b
    (>) (Reversed a) (Reversed b) = a < b
    (>=) (Reversed a) (Reversed b) = a <= b
main =
    [1,3,3,5]; binarySearch 3; print
    [1,3,3,5]; binarySearch 4; print
    [1,3,3,5]; binarySearch 0; print
    [1,3,3,5]; binarySearch 9; print
    []; binarySearch 2; print
    [7]; binarySearch 7; print
    [7]; binarySearch 8; print
    [1,3,3,5]; partitionPoint {< 3}; print
    [1,3,3,5]; partitionPoint {<= 3}; print
    []; partitionPoint {drop; True}; print
    [1,2,3]; partitionPoint {drop; False}; print
    [1,2,3]; partitionPoint {drop; True}; print
    [{n:1},{n:3},{n:5}]; binarySearchBy 3 {.n}; print
    [{n:1},{n:3},{n:5}]; binarySearchBy 4 {.n}; print
    [0,1,3,5,9].[1:3]; binarySearch 3; print
    [Reversed 5,Reversed 3,Reversed 1]; binarySearch (Reversed 3); print
    [1.0,2.0]; binarySearch 1.5; print
    ["a","c"]; binarySearch "c"; print
    mut calls <- 0
    0..1024; toVector; partitionPoint {calls ! + 1; < 500}; print
    calls; print
    mut visited <- 0
    []; binarySearchBy 5 {visited ! + 1; nop}; print
    visited; print
    handle {partitionPoint [1,2,3] {print $; < 3}} {put:{-> text k; resume k}}; print
    catch {binarySearchBy [1,2,3] 2 {exn "key"}}; print
    99; [1,3]; binarySearch 3; print; print
`;
const expected=['(Ok 1)','(Err 3)','(Err 0)','(Err 4)','(Err 0)','(Ok 0)','(Err 1)','1','3','0','0','3','(Ok 1)','(Err 2)','(Ok 1)','(Ok 1)','(Err 1)','(Ok 1)','500','10','(Err 0)','0','2','(Err "key")','(Ok 1)','99'];
function run(){const program=compile(source),output=[];new VM({...program,output:text=>output.push(text)}).evaluate('main');return {program,output};}

test('vector searches return indices and insertion points with logarithmic callbacks',()=>{
 const {program,output}=run();assert.deepEqual(output,expected);
 assert.match(program.types.get('binarySearch'),/ord 'a/);
 assert.match(program.types.get('binarySearchBy'),/ord 'b/);
 assert.doesNotMatch(program.types.get('binarySearch'),/exn/);
 assert.doesNotMatch(program.types.get('partitionPoint'),/ord|exn/);
 const vm=new VM(program);
 assert.match(vm.infer('binarySearchBy [1] 1 {print $; nop}'),/io/);
 assert.match(vm.infer('partitionPoint [1] {print $; > 0}'),/io/);
 assert.throws(()=>vm.infer('partitionPoint [1] {nop}'),/unify/);
 assert.throws(()=>vm.infer('binarySearchBy [1] 1 {dup}'),/unify|shape/);
 assert.throws(()=>vm.infer('binarySearch (1..4) 2'),/unify/);
 assert.equal(format(vm.evaluate('100; [1,3]; binarySearchBy 3 {nop}')),'[100, (Ok 1)]');
});

test('standard vector exports and LSP expose the search functions',()=>{
 const text='main = [1,3,5]; std.vector.binarySearch 4',program=compile(text,'<search>',new Map(),{tokens:standardTokens(text)});
 assert.equal(format(new VM(program).evaluate('main')),'[(Err 2)]');
 const service=new LanguageService(),uri='file:///vector-search.nyan';
 const unqualified=text.replace('std.vector.','');
 assert.deepEqual(service.update(uri,unqualified,1).diagnostics,[]);
 const hover=service.request('textDocument/hover',{textDocument:{uri},position:{line:0,character:unqualified.indexOf('binarySearch')+2}});
 assert.match(hover.contents.value,/result int int/);
});

test('Go and C++ searches agree with VM for effects, user ordering and views',t=>{
 const {program}=run(),dir=mkdtempSync(join(tmpdir(),'nyanco-vector-search-'));
 try{
  const go=join(dir,'main.go');writeFileSync(go,transpileGo(program));
  const nativeGo=spawnSync('go',['run',go],{encoding:'utf8',windowsHide:true,timeout:120000});
  assert.equal(nativeGo.status,0,nativeGo.stderr);assert.equal(nativeGo.stdout,expected.join('\n')+'\n');
  const cpp=join(dir,'main.cpp');writeFileSync(cpp,transpileCpp(program));
  const compiler=process.platform==='win32'?'cl':'c++';
  if(spawnSync(compiler,[compiler==='cl'?'/h':'--version'],{windowsHide:true,stdio:'ignore'}).error){t.diagnostic('C++ execution requires cl or c++ in PATH');return;}
  const exe=join(dir,process.platform==='win32'?'main.exe':'main');
  const args=compiler==='cl'?['/nologo','/std:c++20','/EHsc','/utf-8',cpp,'/Fe:'+exe]:['-std=c++20','-pthread',cpp,'-o',exe];
  const build=spawnSync(compiler,args,{cwd:dir,encoding:'utf8',windowsHide:true,timeout:120000});
  assert.equal(build.status,0,build.stdout+build.stderr);
  const result=spawnSync(exe,[],{encoding:'utf8',windowsHide:true,timeout:15000});
  assert.equal(result.status,0,result.stderr);assert.equal(result.stdout.replaceAll('\r\n','\n'),expected.join('\n')+'\n');
 }finally{
  assert.equal(dirname(dir),tmpdir());assert.ok(dir.startsWith(join(tmpdir(),'nyanco-vector-search-')));rmSync(dir,{recursive:true,force:true});
 }
});
