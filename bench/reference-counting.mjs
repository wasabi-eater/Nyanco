import {compile} from '../language.mjs';
import {compileModule} from '../modules.mjs';
import {transpileCpp} from '../cpp-backend.mjs';
import {stressCases} from './atcoder-cases.mjs';
import {mkdirSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {cpus} from 'node:os';
const out=fileURLToPath(new URL('../native/rc/',import.meta.url));mkdirSync(out,{recursive:true});
const cases=[
 {name:'vector-borrows',source:'main = [1,2,3] -> xs; 0; each (0 .. 200000) {drop; length xs; +}; print',output:'600000\n'},
 {name:'set-int',source:'main = set [] -> mut s; each (0 .. 100000) {-> i; s ! sinsert i}; 0; each (0 .. 100000) {-> i; scontains s i; when {+ 1}}; print',output:'100000\n'},
 {name:'dict-int-int',source:'main = dict [] -> mut d; each (0 .. 100000) {-> i; d.[i] <<- i * 2}; 0; each (0 .. 100000) {-> i; d.[i]; +}; print',output:'9999900000\n'},
 {name:'handler',source:'effect ask : -> int\nmain = handle {0; each (0 .. 2000) {drop; ask; +}} {ask: {-> k; resume 1 k}}; print',output:'2000\n'},
 {name:'zip',source:'main = zip (map (0 .. 50000) {+ 1}) (map (0 .. 50000) {* 2}); count; print',output:'50000\n'},
];
for(const id of ['abc481_c','abc481_d']){
 const p=compileModule(fileURLToPath(new URL('../examples/atcoder/'+id.replace('_','/')+'/main.nyan',import.meta.url)));
 for(const data of stressCases(id))cases.push({...data,name:id+'-'+data.name,program:p});
}
const band=`main =
    read; split " "; vmap {parseInt} -> [h w n q]
    0 .. n; map {-> _; read; split " "; vmap {parseInt}; -> [~ ~]; #(_1, _)}; unzip -> mut r mut c
    r ! sort; c ! sort
    each (0 .. q) do -> _
        read; split " "; vmap {parseInt} -> [ty f t]
        if (ty == 1) {r} {c}; partitionPoint _ {<= t} - partitionPoint _ {< f}; print
`;
const count=300000,large=[`${count} ${count*2} ${count} ${count}`],answers=[];
for(let i=0;i<count;i++){const r=i*104729%count+1;large.push(`${r} ${r*2}`);}
for(let i=0;i<count;i++){const type=i%2+1,lo=i*7919%count+1,hi=Math.min(type*count,lo+10000);large.push(`${type} ${lo} ${hi}`);answers.push(type===1?hi-lo+1:Math.floor(hi/2)-Math.ceil(lo/2)+1);}
cases.push({name:'abc482_c-max',source:band,input:large.join('\n')+'\n',output:answers.join('\n')+'\n'});
const results=[];
for(const data of cases){
 if(process.argv.length>2&&!process.argv.slice(2).includes(data.name))continue;
 const program=data.program??compile(data.source),executables={};
 for(const referenceCounting of ['shared','local']){
  const file=join(out,data.name+'-'+referenceCounting+'.cpp'),exe=join(out,data.name+'-'+referenceCounting+'.exe');
  let code=transpileCpp(program,{referenceCounting,batchIO:true,noSourcePaths:true});
  // Measure only the program, including destruction and IO, not process startup.
  code='#include <chrono>\n'+code.replace(/^int main\(\)/m,'int measuredMain()')+`\nint main(){auto start=std::chrono::steady_clock::now();auto result=measuredMain();std::cout.flush();std::cerr<<std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-start).count()<<'\\n';return result;}\n`;
  writeFileSync(file,code);const compiler=process.platform==='win32'?'cl':'c++';
  const args=compiler==='cl'?['/nologo','/std:c++20','/EHsc','/utf-8','/O2','/bigobj',file,'/Fe:'+exe,'/link','/STACK:16777216']:['-std=c++20','-O2',file,'-o',exe];
  const build=spawnSync(compiler,args,{cwd:out,encoding:'utf8',windowsHide:true,timeout:120000});if(build.status!==0)throw Error(build.stdout+build.stderr);
  executables[referenceCounting]=exe;
 }
 const times={shared:[],local:[]};
 for(let i=-3;i<7;i++)for(const mode of i%2===0?['shared','local']:['local','shared']){
  const r=spawnSync(executables[mode],[],{input:data.input??'',encoding:'utf8',windowsHide:true,maxBuffer:16*1024*1024,timeout:60000});
  if(r.status!==0||r.stdout.replaceAll('\r\n','\n')!==data.output)throw Error(JSON.stringify({case:data.name,mode,status:r.status,stdout:r.stdout?.slice(0,300),stderr:r.stderr}));
  const ms=Number(r.stderr.trim());if(!Number.isFinite(ms))throw Error(r.stderr);
  if(i>=0)times[mode].push(ms);
 }
 const median=xs=>[...xs].sort((a,b)=>a-b)[Math.floor(xs.length/2)];
 const row={case:data.name,sharedMs:median(times.shared),localMs:median(times.local),speedup:median(times.shared)/median(times.local),samples:times};results.push(row);console.log(JSON.stringify(row));
}
const metadata={date:new Date().toISOString(),platform:process.platform,arch:process.arch,cpu:cpus()[0]?.model,compiler:process.platform==='win32'?'MSVC /O2':'c++ -O2',warmups:3,runs:7,results};
writeFileSync(join(out,'results.json'),JSON.stringify(metadata,null,2)+'\n');
