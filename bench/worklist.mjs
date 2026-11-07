import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const dir=join(root,'work','worklist-bench');
mkdirSync(dir,{recursive:true});
function run(command,args,options={}){
 const result=spawnSync(command,args,{cwd:root,encoding:'utf8',windowsHide:true,timeout:120000,...options});
 if(result.status!==0)throw Error(result.error?.message??result.stdout+result.stderr);
 return result;
}

const variants=[
 ['heap-direct','heap [] -> mut h','h ! hpush','h ! hpop'],
 ['heap-effect','withHeap (heap []) below','std.worklist.push','std.worklist.pop'],
 ['deque-direct','deque [] -> mut q','q ! qpush','q ! qpopFront'],
 ['deque-effect','withDeque (deque []) below','std.worklist.push','std.worklist.pop']
];
for(const [name,init,push,pop] of variants){
 const nyan=join(dir,name+'.nyan'),cpp=join(dir,name+'.cpp'),exe=join(dir,name+'.exe');
 writeFileSync(nyan,`main =
    read; parseInt -> n
    read; parseInt -> mode
    ${init}
    if (mode == 0) {
        0
        each (0 .. n) {${push}; ${pop}; ?? cancel; +}
        print
    } {
        each (0 .. n) {${push}}
        0
        loop {${pop}; ?? cancel; +}
        print
    }
`);
 const code=run(process.execPath,['cli.mjs','--single-file',nyan,'--procon']).stdout;
 assert.match(code,/^int main\(\)/m);
 writeFileSync(cpp,'#include <chrono>\n'+code.replace(/^int main\(\)/m,'int measuredMain()')+`
int main() {
    auto start = std::chrono::steady_clock::now();
    int status = measuredMain();
    std::cout.flush();
    std::cerr << std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count() << '\\n';
    return status;
}
`);
 if(process.platform==='win32')run('cl',['/nologo','/std:c++20','/EHsc','/utf-8','/O2','/bigobj',cpp,'/Fe:'+exe],{cwd:dir});
 else run('c++',['-std=c++20','-O2',cpp,'-o',exe],{cwd:dir});
}

for(const [mode,workload,n] of [[0,'alternate',200000],[1,'fill-drain',10000]]){
 for(const [variant] of variants){
  const execute=()=>{
   const result=run(join(dir,variant+'.exe'),[],{input:`${n}\n${mode}\n`,timeout:30000});
   assert.equal(result.stdout.trim(),String(n*(n-1)/2));
   const elapsed=Number(result.stderr.trim());
   assert.ok(Number.isFinite(elapsed)&&elapsed>0,result.stderr);
   return elapsed;
  };
  execute();
  const times=Array.from({length:5},execute).sort((a,b)=>a-b);
  console.log(JSON.stringify({variant,workload,n,ms:times[2],times}));
 }
}
