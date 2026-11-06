import {compile} from '../language.mjs';
import {transpileCpp} from '../cpp-backend.mjs';
import {mkdirSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const out=fileURLToPath(new URL('../native/tries/',import.meta.url));mkdirSync(out,{recursive:true});
const cases=[
 {name:'set-int',source:'main = set [] -> mut s; each (0 .. 100000) {-> i; s ! sinsert i}; 0; each (0 .. 100000) {-> i; scontains s i; when {+ 1}}; print',expected:'100000\n'},
 {name:'dict-int-int',source:'main = dict [] -> mut d; each (0 .. 100000) {-> i; d.[i] <<- i * 2}; 0; each (0 .. 100000) {-> i; d.[i]; +}; print',expected:'9999900000\n'},
];
const results=[];
for(const data of cases)for(const nativeHashTries of [false,true]){
 const mode=nativeHashTries?'native':'boxed',file=join(out,data.name+'-'+mode+'.cpp'),exe=join(out,data.name+'-'+mode+'.exe');
 let code=transpileCpp(compile(data.source),{nativeHashTries,batchIO:true,noSourcePaths:true});
 code='#include <chrono>\n'+code.replace(/^int main\(\)/m,'int measuredMain()')+`\nint main(){auto start=std::chrono::steady_clock::now();auto status=measuredMain();std::cerr<<std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-start).count()<<'\\n';return status;}\n`;
 writeFileSync(file,code);const compiler=process.platform==='win32'?'cl':'c++';
 const args=compiler==='cl'?['/nologo','/std:c++20','/EHsc','/utf-8','/O2',file,'/Fe:'+exe]:['-std=c++20','-O2',file,'-o',exe];
 const build=spawnSync(compiler,args,{cwd:out,encoding:'utf8',windowsHide:true,timeout:120000});if(build.status!==0)throw Error(build.stdout+build.stderr);
 const times=[];for(let i=0;i<3;i++){const r=spawnSync(exe,[],{encoding:'utf8',windowsHide:true,timeout:30000});if(r.status!==0||r.stdout.replaceAll('\r\n','\n')!==data.expected)throw Error(JSON.stringify({case:data.name,mode,status:r.status,stdout:r.stdout,stderr:r.stderr}));times.push(Number(r.stderr.trim()));}
 times.sort((a,b)=>a-b);const row={case:data.name,mode,ms:times[1]};results.push(row);console.log(row);
}
writeFileSync(join(out,'results.json'),JSON.stringify(results,null,2)+'\n');
