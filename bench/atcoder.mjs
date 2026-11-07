import {writeFileSync,mkdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {compileModule} from '../modules.mjs';
import {transpileCpp} from '../cpp-backend.mjs';
import {VM} from '../language.mjs';
import {problemIDs,stressCases,smallCases} from './atcoder-cases.mjs';
const root=fileURLToPath(new URL('..',import.meta.url)),out=join(root,'native','atcoder');mkdirSync(out,{recursive:true});
const selected=process.argv.slice(2);
let referenceCounting='shared';
const rcIndex=selected.indexOf('--rc');
if(rcIndex>=0){referenceCounting=selected[rcIndex+1];if(!['local','shared'].includes(referenceCounting))throw Error('--rc requires local or shared');selected.splice(rcIndex,2);}
const results=[];
for(const id of problemIDs){
 if(selected.length&&!selected.includes(id))continue;
 const file=join(root,'examples','atcoder',id.replace('_','/'),'main.nyan'),program=compileModule(file);
 const small=smallCases(id);
 for(const {name,input,output} of small){
  const lines=input.trimEnd().split('\n'),actual=[];
  new VM({...program,input:()=>lines.shift(),output:line=>actual.push(line)}).evaluate('main');
  if(actual.join('\n')+'\n'!==output)throw Error(`${id}/${name}: VM output mismatch`);
 }
 const cpp=join(out,id+'.cpp'),exe=join(out,id+(process.platform==='win32'?'.exe':''));writeFileSync(cpp,transpileCpp(program,{batchIO:true,noSourcePaths:true,referenceCounting}));
 const compiler=process.platform==='win32'?'cl':'c++',args=compiler==='cl'?['/nologo','/std:c++20','/EHsc','/utf-8','/O2',cpp,'/Fe:'+exe]:['-std=c++20','-O2','-pthread',cpp,'-o',exe];
 const built=spawnSync(compiler,args,{cwd:out,encoding:'utf8',timeout:120000,windowsHide:true});if(built.status!==0)throw Error(built.stdout+built.stderr);
 for(const data of [...stressCases(id),...small])run(data.name,data);
 function run(name,data){const start=performance.now();const p=spawnSync(exe,[],{input:data.input,encoding:'utf8',timeout:30000,windowsHide:true,maxBuffer:16*1024*1024});const ms=Math.round(performance.now()-start);if(p.status!==0||p.stdout.replaceAll('\r\n','\n')!==data.output)throw Error(JSON.stringify({problem:id,name,ms,exit:p.status,error:p.error?.message,stderr:p.stderr,output:p.stdout?.slice(0,300),expected:data.output.slice(0,300)}));const row={problem:id,case:name,ms,limitMs:2000,withinLimit:ms<2000};results.push(row);console.log(JSON.stringify(row));}
}
writeFileSync(join(out,'results.json'),JSON.stringify(results,null,2)+'\n');
