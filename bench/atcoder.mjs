import {writeFileSync,mkdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {compileModule} from '../modules.mjs';
import {transpileCpp} from '../cpp-backend.mjs';
import {VM} from '../language.mjs';
import {problemIDs,problemLimit,stressCases,smallCases} from './atcoder-cases.mjs';
const root=fileURLToPath(new URL('..',import.meta.url)),out=join(root,'native','atcoder');mkdirSync(out,{recursive:true});
const selected=process.argv.slice(2);
let referenceCounting='shared';
const rcIndex=selected.indexOf('--rc');
if(rcIndex>=0){referenceCounting=selected[rcIndex+1];if(!['local','shared'].includes(referenceCounting))throw Error('--rc requires local or shared');selected.splice(rcIndex,2);}
let runs=1;
const runsIndex=selected.indexOf('--runs');
if(runsIndex>=0){runs=Number(selected[runsIndex+1]);if(!Number.isSafeInteger(runs)||runs<1)throw Error('--runs requires a positive integer');selected.splice(runsIndex,2);}
for(const id of selected)if(!problemIDs.includes(id))throw Error('Unknown problem: '+id);
const results=[];
for(const id of problemIDs){
 if(selected.length&&!selected.includes(id))continue;
 const limitMs=problemLimit(id);
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
 for(const data of stressCases(id))run(data,runs);
 for(const data of small)run(data,1);
 function run({name,input,output},count){
  const samples=[];
  for(let i=0;i<count;i++){
   const start=performance.now();
   const p=spawnSync(exe,[],{input,encoding:'utf8',timeout:30000,windowsHide:true,maxBuffer:16*1024*1024});
   const ms=Math.round(performance.now()-start);
   if(p.status!==0||p.stdout.replaceAll('\r\n','\n')!==output)throw Error(JSON.stringify({problem:id,name,ms,exit:p.status,error:p.error?.message,stderr:p.stderr,output:p.stdout?.slice(0,300),expected:output.slice(0,300)}));
   samples.push(ms);
  }
  const sorted=[...samples].sort((a,b)=>a-b),middle=Math.floor(count/2);
  const ms=count%2?sorted[middle]:(sorted[middle-1]+sorted[middle])/2;
  const row={problem:id,case:name,ms,limitMs,withinLimit:ms<limitMs,...(count>1?{samples}: {})};
  results.push(row);console.log(JSON.stringify(row));
 }
}
writeFileSync(join(out,'results.json'),JSON.stringify(results,null,2)+'\n');
