import {compile} from '../language.mjs';
import {transpileCpp} from '../cpp-backend.mjs';
import {mkdirSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const out=fileURLToPath(new URL('../native/coroutines/',import.meta.url));mkdirSync(out,{recursive:true});
const cases=[
 {name:'handler',source:'effect ask : -> int\nmain = handle {0; each (0 .. 2000) {drop; ask; +}} {ask: {-> k; resume 1 k}}; print',expected:'2000\n'},
 {name:'zip',source:'main = zip (map (0 .. 5000) {+ 1}) (map (0 .. 5000) {* 2}); count; print',expected:'5000\n'},
];
const results=[];
for(const data of cases)for(const effectCoroutines of [false,true]){
 const mode=effectCoroutines?'coroutine':'thread',file=join(out,data.name+'-'+mode+'.cpp'),exe=join(out,data.name+'-'+mode+'.exe');
 const program=compile(data.source);
 let cpp=transpileCpp(program,{effectCoroutines,batchIO:true,noSourcePaths:true});
 cpp='#include <chrono>\n'+cpp.replace(/^int main\(\)/m,'int measuredMain()')+`\nint main(){auto start=std::chrono::steady_clock::now();auto result=measuredMain();std::cerr<<std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-start).count()<<'\\n';return result;}\n`;
 writeFileSync(file,cpp);
 const compiler=process.platform==='win32'?'cl':'c++';
 const args=compiler==='cl'?['/nologo','/std:c++20','/EHsc','/utf-8','/O2',file,'/Fe:'+exe,'/link','/STACK:16777216']:['-std=c++20','-O2','-pthread',file,'-o',exe];
 const built=spawnSync(compiler,args,{cwd:out,encoding:'utf8',windowsHide:true,timeout:120000});if(built.status!==0)throw Error(built.stdout+built.stderr);
 const times=[];for(let i=0;i<3;i++){
  const r=spawnSync(exe,[],{encoding:'utf8',windowsHide:true,timeout:60000});if(r.status!==0||r.stdout.replaceAll('\r\n','\n')!==data.expected)throw Error(JSON.stringify({case:data.name,mode,status:r.status,stdout:r.stdout,stderr:r.stderr}));times.push(Number(r.stderr.trim()));
 }
 times.sort((a,b)=>a-b);const row={case:data.name,mode,ms:times[1],sourceBytes:Buffer.byteLength(cpp)};results.push(row);console.log(row);
}
writeFileSync(join(out,'results.json'),JSON.stringify(results,null,2)+'\n');
