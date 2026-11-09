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

const source=`data bag 'a = Bag ['a]
instance length (bag 'a) where
    length (Bag xs) = length xs
instance isEmpty (bag 'a) where
    isEmpty (Bag xs) = isEmpty xs
instance eq 'a => in (bag 'a) where
    item : 'a
    in key (Bag xs) = in key xs
instance push (bag 'a) where
    item : 'a
    push (Bag xs) item = Bag (push xs item)
instance pop (bag 'a) where
    item : 'a
    pop (Bag xs) = pop xs; Bag
instance peek (bag 'a) where
    item : 'a
    peek (Bag xs) = peek xs
data residue = Residue int
instance eq residue where
    (==) (Residue a) (Residue b) = a % 10 == b % 10
    (/=) (Residue a) (Residue b) = a % 10 /= b % 10
size : std.classes.length 'a => 'a -> int
size = std.classes.length
has : std.classes.in 'c 'a => 'a 'c -> bool
has = std.classes.in
main =
    print (size (Bag [0, 1])); print (isEmpty (Bag []))
    print (has 0 [0, 1, 2]); print (has "a" (Bag ["b"]))
    print (in (Residue 11) [Residue 1])
    print (catch {in (Residue 11) [Residue 1]}); print (in 1 [byte 1])
    print (length "猫😀"); print (in '猫' "猫😀"); print (isEmpty "")
    print (length [1: "a"]); print (in 1 [1: "a"]); print (in 2 [1: "a"])
    print (isEmpty (deque [])); print (length (deque [1, 2]))
    print (in 2 (heap [1, 2])); print (length (heap [1, 2]))
    print (in 2 (3 .. 1)); print (in 1 (3 .. 1)); print (in 1 (3 ..= 1))
    print (isEmpty (1 .. 1)); print (isEmpty (1 ..= 1))
    push (Bag [1]) 2; dup; peek; print; pop; drop; print
    mut xs <- [0, 1]
    xs -> saved
    xs ! push 2
    xs ! pop; print
    print xs; print saved
    []; pop; print; print
    print (peek [])
    deque [1]; push 2; dup; peek; print; pop; vector; print; print
    heap [1]; push 2; dup; peek; print; pop; vector; print; print
    [1, 2]; std.vector.peek; print
`;
const withSet=`    print (length (set [0, 0, 1])); print (in 1 (set [0, 1])); print (isEmpty (set []))
    set [1]; push 2; push 2; sort; print
`;
const expected=['2','True','True','False','True','(Ok True)','True','7','True','True','1','True','False','True','2','True','2','True','False','True','True','False',
 '(Some 2)','(Some 2)','(Some 2)','[0, 1]','[0, 1]','[]','None','None','(Some 1)','[2]','(Some 1)','(Some 2)','[1]','(Some 2)','(Some 2)'];
const program=text=>compile(text,'<collection-classes>',new Map(),{tokens:standardTokens(text)});
function evaluate(p){
 const output=[];new VM({...p,output:line=>output.push(line)}).evaluate('main');return output;
}

test('collection methods infer constraints and dispatch on standard and user types',()=>{
 assert.deepEqual(evaluate(program(source+withSet)),[...expected,'2','True','True','[1, 2]']);
 const vm=new VM();
 for(const name of ['length','isEmpty','in','push','pop','peek'])assert.match(vm.infer(name),new RegExp('^'+name+' '));
 for(const expr of ['length 0','isEmpty False','in "a" [0]','in {nop} [{nop}]','push [1] "a"','pop (set [1])','peek (set [1])'])
  assert.throws(()=>vm.evaluate(expr),/No instance|Cannot unify/,expr);
 assert.doesNotThrow(()=>compile('data option = Nothing\nmain = push [1] 2'));
});

test('collection methods run in an empty REPL session',()=>{
 const vm=new VM();
 assert.deepEqual(vm.evaluate('deque [1]; push 2; vector'),[[1,2]]);
 const [peeked,popped,remaining]=vm.evaluate('[1,2]; dup; peek; swap; pop');
 assert.equal(peeked.constructor,'Some');
 assert.deepEqual(peeked.fields,[2]);
 assert.deepEqual(popped,peeked);
 assert.deepEqual([...remaining],[1]);
});

const compiler=process.platform==='win32'?'cl':'c++';
const hasCpp=!spawnSync(compiler,[compiler==='cl'?'/h':'--version'],{stdio:'ignore',windowsHide:true}).error;
const hasGo=!spawnSync('go',['version'],{stdio:'ignore',windowsHide:true}).error;
for(const target of ['cpp','go'])test(`collection methods match the VM in ${target}`,{skip:!(target==='cpp'?hasCpp:hasGo)},()=>{
 const p=program(source+(target==='cpp'?withSet:''));
 const dir=mkdtempSync(join(tmpdir(),'nyanco-collection-classes-'));
 try{
  const file=join(dir,'main.'+target),exe=join(dir,'main.exe');
  writeFileSync(file,target==='cpp'?transpileCpp(p):transpileGo(p));
  const flags=target==='go'?['build','-o',exe,file]:compiler==='cl'
   ?['/nologo','/std:c++20','/EHsc','/utf-8','/O2',file,'/Fe:'+exe]
   :['-std=c++20','-O2','-pthread',file,'-o',exe];
  const build=spawnSync(target==='cpp'?compiler:'go',flags,{cwd:dir,encoding:'utf8',timeout:120000,windowsHide:true});
  assert.equal(build.status,0,build.error?.message||build.stdout+build.stderr);
  const run=spawnSync(exe,[],{encoding:'utf8',timeout:15000,windowsHide:true});
  assert.equal(run.status,0,run.stderr);
  assert.equal(run.stdout.replaceAll('\r\n','\n'),evaluate(p).join('\n')+'\n');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
