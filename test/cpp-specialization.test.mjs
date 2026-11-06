import test from 'node:test';
import assert from 'node:assert/strict';
import {compile,VM} from '../language.mjs';
import {transpileCpp} from '../cpp-backend.mjs';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const expressions=[
 'if (ty == 1) {r} {c}; partitionPoint _ {<= t} - partitionPoint _ {< f}',
 'if (ty == 1) {r} {c}; partitionPoint _ {<= t}, partitionPoint _ {< f}, -',
];

const source=expression=>`cachePut =
    [] -> mut cache
    handle _ {
        read: {-> k; resume read k},
        put: {-> s k; cache ! vpush s; resume k}
    }
    cache; join "\\n"; put
main =
    cachePut below
    read; split " "; vmap {parseInt} -> [h w n q];
    0 .. n; map {-> _; read; split " "; vmap {parseInt}; -> [~ ~]; #(_1, _)}; unzip -> mut r mut c;
    r ! sort; c ! sort
    each (0 .. q) do -> _
        read; split " "; vmap {parseInt} -> [ty f t];
        ${expression}; print`;

test('C++ quotation specialization terminates for repeated captures and buffered IO handlers',()=>{
 for(const expression of expressions){
  const program=compile(source(expression));
  const code=transpileCpp(program,{noSourcePaths:true});
  assert.match(code,/int main\(/);
 }
});

test('procon output for both capture forms compiles and matches Run output',t=>{
 const compiler=process.platform==='win32'?'cl':'c++';
 if(spawnSync(compiler,[compiler==='cl'?'/h':'--version'],{stdio:'ignore',windowsHide:true}).error){t.skip('C++ compiler unavailable');return;}
 const dir=mkdtempSync(join(tmpdir(),'nyanco-cpp-specialization-'));
 const input='5 6 4 4\n1 2\n2 4\n2 5\n5 1\n1 1 2\n2 2 5\n1 3 5\n2 1 6\n';
 try{
  for(const expression of expressions){
   const text=source(expression),output=[],rows=input.trimEnd().split('\n');
   new VM({...compile(text),input:()=>rows.shift(),output:line=>output.push(line)}).evaluate('main');
   assert.deepEqual(output,['3\n3\n1\n4']);
   const file=join(dir,'main.nyan'),cpp=join(dir,'main.cpp'),exe=join(dir,process.platform==='win32'?'main.exe':'main');
   writeFileSync(file,text);
   const cli=spawnSync(process.execPath,[fileURLToPath(new URL('../cli.mjs',import.meta.url)),file,'--procon'],{encoding:'utf8',windowsHide:true,timeout:15000});
   assert.equal(cli.status,0,cli.stderr);writeFileSync(cpp,cli.stdout);
   const args=compiler==='cl'?['/nologo','/std:c++20','/EHsc','/utf-8',cpp,'/Fe:'+exe]:['-std=c++20','-pthread',cpp,'-o',exe];
   const build=spawnSync(compiler,args,{cwd:dir,encoding:'utf8',windowsHide:true,timeout:120000});
   assert.equal(build.status,0,build.stdout+build.stderr);
   const result=spawnSync(exe,[],{input,encoding:'utf8',windowsHide:true,timeout:15000});
   assert.equal(result.status,0,result.stderr);assert.equal(result.stdout.replaceAll('\r\n','\n'),output.join('\n')+'\n');
  }
 }finally{
  assert.equal(dirname(dir),tmpdir());assert.ok(dir.startsWith(join(tmpdir(),'nyanco-cpp-specialization-')));rmSync(dir,{recursive:true,force:true});
 }
});
