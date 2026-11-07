import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join,resolve} from 'node:path';
import {compile,VM} from '../language.mjs';
import {compileModule} from '../modules.mjs';
import {transpileCpp} from '../cpp-backend.mjs';
import {stressCases,smallCases} from './atcoder-cases.mjs';
const root=fileURLToPath(new URL('..',import.meta.url)),out=join(root,'native','graphs');mkdirSync(out,{recursive:true});
const args=process.argv.slice(2),index=args.indexOf('--baseline-cpp');
const baseline=index<0?null:resolve(args[index+1]);if(index>=0)args.splice(index,2);
const csr=join(root,'examples/atcoder/abc481/d/main.nyan'),jagged=join(root,'examples/atcoder/abc481/d-jagged/main.nyan');
const source=readFileSync(csr,'utf8');
const dense=source.replace('set [] -> mut seen','vreplicate n 0 -> mut seen').replace('scontains seen v; not','seen.[v] == 0').replace('seen ! sinsert v','seen.[v] <<- 1');
const variants=[
 {name:'csr-env',program:compileModule(csr),nativeLocals:false},
 {name:'csr-native',program:compileModule(csr)},
 {name:'csr-dense-native',program:compile(dense)},
 {name:'jagged-native',program:compileModule(jagged)},
 ...(baseline?[{name:'saved-baseline',source:readFileSync(baseline,'utf8')}]:[])
];
const fixture=JSON.parse(readFileSync(join(root,'test/fixtures/atcoder-samples.json'),'utf8')).find(p=>p.id==='abc481_d');
const checks=[...fixture.samples,...smallCases('abc481_d')],large=stressCases('abc481_d');
const layers=50000,edges=[];
for(let i=0;i<layers-1;i++){const a=i*2+1,b=a+1;edges.push(`${a} ${b}`,`${a} ${a+2}`,`${b} ${a}`,`${b} ${b+2}`);}
edges.push(`${layers*2-1} ${layers*2}`,`${layers*2} ${layers*2-1}`);
large.push({name:'max-ladder',input:`${layers*2} ${edges.length} 1 ${layers*2}\n`+edges.join('\n')+'\n',output:(layers-1)+'\n'});
const results=[];
for(const variant of variants){
 if(args.length&&!args.includes(variant.name))continue;
 if(variant.program)for(const sample of fixture.samples){let lines=sample.input.trimEnd().split('\n'),output=[];new VM({...variant.program,input:()=>lines.shift(),output:s=>output.push(s)}).evaluate('main');if(output.join('\n')+'\n'!==sample.output)throw Error(variant.name+' VM mismatch');}
 let code=variant.source??transpileCpp(variant.program,{nativeLocals:variant.nativeLocals??true,batchIO:true,noSourcePaths:true,referenceCounting:'local'});
 code='#include <chrono>\n'+code.replace(/^int main\(\)/m,'int measuredMain()')+'\nint main(){auto start=std::chrono::steady_clock::now();auto status=measuredMain();std::cout.flush();std::cerr<<std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-start).count()<<"\\n";return status;}\n';
 const cpp=join(out,variant.name+'.cpp'),exe=join(out,variant.name+'.exe');writeFileSync(cpp,code);
 const compiler=process.platform==='win32'?'cl':'c++';
 const flags=compiler==='cl'?['/nologo','/std:c++20','/EHsc','/utf-8','/O2','/bigobj',cpp,'/Fe:'+exe]:['-std=c++20','-O2',cpp,'-o',exe];
 const built=spawnSync(compiler,flags,{cwd:out,encoding:'utf8',windowsHide:true,timeout:120000});if(built.status!==0)throw Error(built.stdout+built.stderr);
 const run=data=>{const r=spawnSync(exe,[],{input:data.input,encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:16*1024*1024});if(r.status!==0||r.stdout.replaceAll('\r\n','\n')!==data.output)throw Error(JSON.stringify({variant:variant.name,case:data.name,status:r.status,stderr:r.stderr,output:r.stdout,error:r.error?.message}));return Number(r.stderr.trim());};
 for(const data of checks)run(data);
 for(const data of large){run(data);const times=[];for(let i=0;i<3;i++)times.push(run(data));times.sort((a,b)=>a-b);const row={variant:variant.name,case:data.name,ms:times[1],times};results.push(row);console.log(JSON.stringify(row));}
}
writeFileSync(join(out,'results.json'),JSON.stringify({date:new Date().toISOString(),compiler:process.platform==='win32'?'MSVC /O2':'c++ -O2',runs:3,warmups:1,checks:checks.length,results},null,2)+'\n');
