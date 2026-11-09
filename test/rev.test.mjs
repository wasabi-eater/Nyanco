import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {compile,VM} from '../language.mjs';
import {standardTokens} from '../modules.mjs';
import {transpileCpp} from '../cpp-backend.mjs';
import {transpileGo} from '../go-backend.mjs';

const source=`unrev : std.rev int -> int
unrev (std.rev.Rev x) = x
main =
    print (sortBy [1, 3, 2] {Rev})
    heap [Rev 3, Rev 1, Rev 2]; pop; drop; unwrap; unrev; print
    print (Rev 2 < Rev 1 && Rev 2 <= Rev 2)
    print (Rev 1 > Rev 2 && Rev 1 >= Rev 1)
    print (Rev 1 == Rev 1 && Rev 1 /= Rev 2)
    print (hash (Rev 7) == hash 7)
    print ([Rev 4: "key"].[Rev 4])
    print (show (Rev "text"))
    print (unrev (std.rev.Rev 7))
    print (Rev (Rev 1) < Rev (Rev 2))
    sortBy [#(2, "a"), #(1, "a"), #(2, "b"), #(1, "z")] {#(_.0, Rev _.1)}; print
`;
const expected=['[3, 2, 1]','1','True','True','True','True','key','(Rev "text")','7','True','[#(1 "z"), #(1 "a"), #(2 "b"), #(2 "a")]'];
const program=()=>compile(source,'<rev>',new Map(),{tokens:standardTokens(source)});

test('Rev reverses ordering and delegates equality, hashing and display to its item',()=>{
  const output=[];
  new VM({...program(),output:line=>output.push(line)}).evaluate('main');
  assert.deepEqual(output,expected);
  const vm=new VM();
  assert.match(vm.infer('Rev'),/rev 'a/);
  assert.deepEqual(vm.evaluate('Rev 2 < Rev 1'),[true]);
  assert.throws(()=>vm.infer('Rev {1} < Rev {2}'),/No instance: (eq|ord)/);
});

const cpp=process.platform==='win32'?'cl':'c++';
for(const target of ['cpp','go']){
  const compiler=target==='cpp'?cpp:'go';
  const available=!spawnSync(compiler,[compiler==='cl'?'/h':compiler==='go'?'version':'--version'],{stdio:'ignore',windowsHide:true}).error;
  test(`Rev comparisons and heap behavior match the VM in ${target}`,{skip:!available},()=>{
    const dir=mkdtempSync(join(tmpdir(),'nyanco-rev-'));
    try{
      const file=join(dir,'main.'+target),exe=join(dir,'main.exe'),p=program();
      writeFileSync(file,target==='cpp'?transpileCpp(p):transpileGo(p));
      const flags=target==='go'?['build','-o',exe,file]:compiler==='cl'
        ?['/nologo','/std:c++20','/EHsc','/utf-8','/O2',file,'/Fe:'+exe]
        :['-std=c++20','-O2','-pthread',file,'-o',exe];
      const build=spawnSync(compiler,flags,{cwd:dir,encoding:'utf8',windowsHide:true,timeout:120000});
      assert.equal(build.status,0,build.error?.message||build.stdout+build.stderr);
      const run=spawnSync(exe,[],{encoding:'utf8',windowsHide:true,timeout:15000});
      assert.equal(run.status,0,run.stderr);
      assert.equal(run.stdout.replaceAll('\r\n','\n'),expected.join('\n')+'\n');
    }finally{rmSync(dir,{recursive:true,force:true});}
  });
}
