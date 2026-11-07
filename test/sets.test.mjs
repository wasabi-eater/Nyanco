import test from 'node:test';
import assert from 'node:assert/strict';
import {compile,VM,format} from '../language.mjs';
import {transpileCpp} from '../cpp-backend.mjs';
import {standardTokens} from '../modules.mjs';
import {LanguageService} from '../lsp.mjs';
import {emptyDict,dictSet,dictGet,dictDelete,dictEntries} from '../hash-map.mjs';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
const compiler=process.platform==='win32'?'cl':'c++';
const available=!spawnSync(compiler,[compiler==='cl'?'/h':'--version'],{stdio:'ignore',windowsHide:true}).error;
function native(program){const dir=mkdtempSync(join(tmpdir(),'nyanco-sets-'));try{
 const cpp=join(dir,'main.cpp'),exe=join(dir,'main.exe');writeFileSync(cpp,transpileCpp(program));
 const args=compiler==='cl'?['/nologo','/std:c++20','/EHsc','/utf-8','/O2',cpp,'/Fe:'+exe]:['-std=c++20','-O2','-pthread',cpp,'-o',exe];
 const built=spawnSync(compiler,args,{cwd:dir,encoding:'utf8',windowsHide:true,timeout:120000});assert.equal(built.status,0,built.stdout+built.stderr);
 const result=spawnSync(exe,[],{encoding:'utf8',windowsHide:true,timeout:20000});assert.equal(result.status,0,result.stderr);return result.stdout.replaceAll('\r\n','\n');
}finally{assert.equal(dirname(dir),tmpdir());assert.ok(dir.startsWith(join(tmpdir(),'nyanco-sets-')));rmSync(dir,{recursive:true,force:true});}}
function run(source){const program=compile(source),output=[];new VM({...program,output:s=>output.push(s),warning:()=>{}}).evaluate('main');return {program,output};}
const source=`data key = Key int deriving eq, show
instance hash key where
    hash (Key n) = 0
unKey (Key n) = n
data residue = Residue int deriving show
instance hash residue where
    hash (Residue n) = n % 10
instance eq residue where
    (==) (Residue a) (Residue b) = a % 10 == b % 10
    (/=) (Residue a) (Residue b) = a % 10 /= b % 10
main =
    toSet [3,1,3,2] -> original
    sinsert original 4; sremove 2; toVector; sort; print
    original; toVector; sort; print
    print (scontains original 2); print (slength original); print (sisEmpty (sremove (toSet [1]) 1))
    sunion original (toSet [4,2]); toVector; sort; print
    sintersection original (toSet [2,4]); toVector; print
    sdifference original (toSet [2,4]); toVector; sort; print
    print (original == toSet [2,1,3]); print (hash original == hash (toSet [3,2,1]))
    toSet [Key 1,Key 2,Key 1]; sremove (Key 2); map {unKey}; toVector; print
    toSet [Residue 1,Residue 11,Residue 2] -> residues
    print (slength residues); print (scontains residues (Residue 21)); print (slength (sremove residues (Residue 21)))
    toSet [toSet [1,2],toSet [2,1]]; slength; print
    [toSet [1,2]: "nested"].?[toSet [2,1]]; print
    toSet [#(1,"a"),#(1,"a"),#(2,"b")]; slength; print
    toSet [{x:1,y:[2,3]},{y:[2,3],x:1}]; slength; print
    set [] -> mut changing
    changing ! sinsert 1
    changing -> saved
    changing ! sremove 1; changing ! sinsert 2
    saved; toVector; print; changing; toVector; print
    0; each original {+}; print
    show original; print
`;
test('set type constraints, custom hashing/equality and persistent snapshots',()=>{
 const {output}=run(source);
 assert.deepEqual(output.slice(0,10),['[1, 3, 4]','[1, 2, 3]','True','3','True','[1, 2, 3, 4]','[2]','[1, 3]','True','True']);
 assert.ok(output.includes('(Some "nested")'));
 assert.throws(()=>compile('main = set []; sinsert {nop}'),/instance|constraint/i);
 assert.throws(()=>compile('main = (toSet [1]) < (toSet [2])'),/instance.*ord/i);
 const vm=new VM();assert.match(vm.infer('set'),/hash 'b/);assert.match(vm.infer('sinsert'),/eq 'a/);
});
test('set standard module, annotations and language service',()=>{
 const text='f : set int -> bool\nf = std.set.contains _ 2\nmain = f (std.set.toSet [1,2])';
 const p=compile(text,'<set>',new Map(),{tokens:standardTokens(text)});assert.equal(format(new VM(p).evaluate('main')),'[True]');
 const service=new LanguageService();assert.deepEqual(service.update('file:///sets.nyan',text,1).diagnostics,[]);
});
test('persistent hash-trie deletion covers collision buckets and empty branches',()=>{
 let data=emptyDict();for(let i=0;i<200;i++)data=dictSet(data,i,true,i%7,(a,b)=>a===b);const snapshot=data;
 for(let i=0;i<200;i+=2)data=dictDelete(data,i,i%7,(a,b)=>a===b);
 assert.equal(data.size,100);assert.equal(snapshot.size,200);assert.equal([...dictEntries(data)].length,100);
 for(let i=0;i<200;i++)assert.equal(!!dictGet(data,i,i%7,(a,b)=>a===b),i%2===1);
 for(let i=1;i<200;i+=2)data=dictDelete(data,i,i%7,(a,b)=>a===b);assert.equal(data.size,0);
});
test('native hashset matches VM for collisions, structural keys, snapshots and custom eq',{skip:!available},()=>{const {program,output}=run(source);assert.equal(native(program),output.join('\n')+'\n');});

test('new vector helpers and primitive mutable updates match VM and preserve aborts',{skip:!available},()=>{
 const text=`main =
    [1,2,3]; vscan 0 {+}; print
    []; vscan 7 {+}; print
    vreplicate 3 4; print
    vreplicate 0 4; print
    catch {vreplicate (-1) 4}; print
    vreplicate 3 0 -> mut xs
    xs.[1] ! + 2
    xs -> saved
    xs.[1] <<- 9
    print xs; print saved
    catch {xs.[99] <<- 7; 0}; print
    print xs
    [:] -> mut d
    d.["a"] <<- 3
    d -> before
    d.["a"] ! + 1
    d.["b"] ??<- 9
    print d; print before
    catch {d.["missing"] ! + 1; 0}; print
    [1,2,3]; vscan 0 {+; cancel}; print
    [1,2,3]; vscan 0 {drop; drop; [42]; break}; print
    repeat 3; take 4; toVector; print
    0 -> mut n
    repeatWith {n ! + 1; n}; take 3; toVector; print
    deque []; qpush 1; qpushFront 2 -> mut q
    q ! qpopHead; print; print (toVector q)
`;
 const {program,output}=run(text);assert.equal(native(program),output.join('\n')+'\n');
});
