import test from 'node:test';
import assert from 'node:assert/strict';
import {compile,VM,lex} from '../language.mjs';
import {compileModule} from '../modules.mjs';
import {transpileGo} from '../go-backend.mjs';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const run=source=>{const p=compile(source),output=[],vm=new VM({...p,output:s=>output.push(s),warning:()=>{}});return {p,vm,output,stack:vm.evaluate('main')};};
const source=`swapValues mut a mut b = b, a ->> a, b; #(a,b)
counter = mut n <- 0; {n ! + 1; n}
main =
 x <- 0
 print x
 mut n <- 1
 n <<- 2
 3 ->> n
 n ! + 1, * 2
 print n
 a, mut b <- 4, 5
 print #(a,b)
 b <<- 6
 print b
 mut c, mut d <- 7, 8
 c, d <<- d, c
 print #(c,d)
 d, c ->> c, d
 print #(c,d)
 print (swapValues 1 2)
 9; selected <- _ + 1; print selected
 {:name, age: years} <- {name: "Nyanco", age: 3, extra: True}
 print name; print years
 Some(~) <- Some 12; print
 mut r <- {xs: [0], field: 1}
 13 ->> r.xs.[0]
 14 ->> r.field
 r.xs.[0] <<- 15
 print r
 inc <- counter
 print (call inc); print (call inc)
 local value = result <- value + 1; result;; print (local 20)
`;
const expected=['0','8','#(4 5)','6','#(8 7)','#(7 8)','#(2 1)','10','Nyanco','3','12','{field: 14, xs: [15]}','1','2','21'];

test('left declarations and both assignment directions preserve binding and stack behavior',()=>{
 assert.deepEqual(run(source).output,expected);
 const vm=new VM({warning:()=>{}});
 assert.deepEqual(vm.evaluate('40; x <- 1; x'),[40,1]);
 assert.deepEqual(vm.evaluate('mut a, mut b <- 1, 2; 99; b, a ->> a b; a, b'),[99,2,1]);
 assert.deepEqual(run('main = 3; x <- + 1; x').stack,[4]);
 assert.deepEqual(run('main = x <- 1, 2; x').stack,[1,2]);
 assert.deepEqual(run('main = mut x<--3; x<<--4; -5->>x; x').stack,[-5]);
 assert.deepEqual(lex('x<-1; x<<-2; 3->>x').map(t=>t.value),['x','<-',1,';','x','<<-',2,';',3,'->>','x']);
});

test('declaration and reassignment enforce mutability, distinct targets and transactional failure',()=>{
 for(const body of ['x <- 0; x <- 1','mut x <- 0; x <- 1'])assert.throws(()=>run('main = '+body),/already declared/i);
 for(const body of ['x <- 0; x <<- 1','x <- 0; 1 ->> x'])assert.throws(()=>run('main = '+body),/immutable/);
 for(const body of ['x, x <- 1,2','mut x <- 1; 1,2 ->> x,x'])assert.throws(()=>run('main = '+body),/Duplicate/);
 for(const body of ['x y <- 1,2','x <-','x, y <- 1','mut x <- 0; x <<- "bad"','mut x <- 0; "bad" ->> x'])assert.throws(()=>run('main = '+body));
 assert.throws(()=>run('main = 1 ->> missing'),/Unknown/);
 assert.throws(()=>run('main = mut x <- 0; ->> x'),/underflow|empty stack|supply/i);
 const vm=new VM({warning:()=>{}});vm.evaluate('mut x, mut y <- 1,2');
 assert.throws(()=>vm.evaluate('x, y <<- 3, 1 / 0'),/zero/);assert.deepEqual(vm.evaluate('x,y'),[1,2]);
 assert.throws(()=>vm.evaluate('3, 1 / 0 ->> x,y'),/zero/);assert.deepEqual(vm.evaluate('x,y'),[1,2]);
});

function native(p,output,dir){const file=join(dir,'main.go');writeFileSync(file,transpileGo(p));const result=spawnSync('go',['run',file],{encoding:'utf8',windowsHide:true,timeout:120000});assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,output.join('\n')+'\n');}
test('native declarations and stack assignments match interpreter output',()=>{
 const dir=mkdtempSync(join(tmpdir(),'nyanco-declaration-arrows-'));try{const {p,output}=run(source);native(p,output,dir);}finally{rmSync(dir,{recursive:true,force:true});}
});

test('module globals and REPL bindings support the new arrows',()=>{
 const dir=mkdtempSync(join(tmpdir(),'nyanco-declaration-modules-'));
 try{
  mkdirSync(join(dir,'lib'));writeFileSync(join(dir,'lib/api.nyan'),'mut count <- 0\npub next = count <<- count + 1; count\n{:name} <- {name: "module"}\npub read = name');
  const entry=join(dir,'main.nyan');writeFileSync(entry,'import "./lib"\nmain = print lib.next; print lib.next; print lib.read');
  const p=compileModule(entry),output=[];new VM({...p,output:s=>output.push(s),warning:()=>{}}).evaluate('main');assert.deepEqual(output,['1','2','module']);native(p,output,dir);
  const repl=spawnSync(process.execPath,['cli.mjs'],{input:'x <- 0\nx\nmut y <- 1\ny <<- 2\n3 ->> y\ny\n:q\n',encoding:'utf8',windowsHide:true,timeout:5000});assert.equal(repl.status,0,repl.stderr);assert.doesNotMatch(repl.stdout,/Error:/);assert.match(repl.stdout,/\[0\]/);assert.match(repl.stdout,/\[0, 3\]/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
