import test from 'node:test';
import assert from 'node:assert/strict';
import {compile,VM} from '../migration/v048-adapter.mjs';
import {transpileGo} from '../go-backend.mjs';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const declarations=`class zero 'a where
  zero : -> 'a
instance zero num where
  zero = 0
instance zero string where
  zero = ""
data box 'a = Box 'a
instance zero 'a => zero (box 'a) where
  zero = Box zero
get = zero
number : -> num
number = get
text : -> string
text = get
boxed : -> box num
boxed = get
`;
const run=(body,extra='')=>{const p=compile(declarations+extra+'\nmain = '+body),output=[],vm=new VM({...p,output:s=>output.push(s),warning:()=>{}});return {stack:vm.evaluate('main'),output,p};};
test('result-only methods infer constraints and select instances from annotations and consumers',()=>{
 const {stack,p}=run('number; text; boxed; get; + 3');
 assert.deepEqual(stack,[0,'',{kind:'adt',typeName:'box',constructor:'Box',fields:[0]},3]);
 assert.match(p.types.get('get'),/^zero 'a =>/);
 assert.match(new VM(p).infer('zero'),/^zero 'a =>/);
});
test('class parameters may occur inside method input and output types',()=>{
 const extra=`class nested 'a where
  first : ['a] -> 'a
  singleton : -> ['a]
instance nested num where
  first = head
  singleton = [42]
instance nested string where
  first = head
  singleton = ["ok"]
nums : -> [num]
nums = singleton
strings : -> [string]
strings = singleton
`;
 assert.deepEqual(run('first [2]; first ["x"]; nums; strings',extra).stack,[2,'x',[42],['ok']]);
});
test('polymorphic quotations, local functions and composed blocks receive specialized dictionaries',()=>{
 assert.deepEqual(run('{get}; -> q; call q; + 1; call q; == ""').stack,[1,true]);
 assert.deepEqual(run('f = get; f; + 2').stack,[2]);
 assert.deepEqual(run('call (compose {get} {+ 1})').stack,[1]);
 assert.deepEqual(run('invoke {get}; + 2','invoke q = call q\n').stack,[2]);
});
test('stored REPL closures and streams are specialized independently on each use',()=>{
 const vm=new VM({...compile(declarations),warning:()=>{}});
 vm.evaluate('{get} -> q');assert.deepEqual(vm.evaluate('call q; + 1'),[1]);assert.deepEqual(vm.evaluate('call q; == ""'),[true]);
 vm.evaluate('smap [1,2] {drop; get} -> xs');
 assert.deepEqual(vm.evaluate('toList xs; head; + 1'),[1]);
 assert.deepEqual(vm.evaluate('toList xs; head; == ""'),[true]);
 vm.evaluate('fromYield {yield get} -> ys');assert.deepEqual(vm.evaluate('toList ys; head; + 2'),[2]);
});
test('lazy traversal propagates output expectations through each and yield',()=>{
 assert.deepEqual(run('map [1,2] {drop; get}; head; + 1').stack,[1]);
 assert.deepEqual(run('toList (smap [1,2] {drop; get}); head; + 1').stack,[1]);
 assert.deepEqual(run('toList (fromYield {produce}); head; + 1','produce = yield get\n').stack,[1]);
 const extra=`data many 'a = Many ['a]
instance streem (many 'a) where
  item : 'a
  each (Many xs) f = each xs f
`;
 assert.deepEqual(run('0; each (Many [1,2]) {drop; get; +}',extra).stack,[0]);
});
test('typed dictionaries coexist with effect handlers, break, and mutable captures',()=>{
 assert.deepEqual(run('0 -> mut acc; each [1,2] {drop; acc := acc + number}; acc').stack,[0]);
 assert.deepEqual(run('toList (smap [1,2] {when ($ == 2) {break}; drop; get}); head; + 1').stack,[1]);
 assert.deepEqual(run('handle {ask; + 1} {ask: {-> k; call {resume number k}}}','effect ask : -> num\n').stack,[1]);
});
test('ambiguous calls fail before direct expression or named function side effects',()=>{
 const output=[],vm=new VM({...compile(declarations),output:s=>output.push(s)});
 for(const expr of ['zero','zero; drop','print "bad"; get; drop'])assert.throws(()=>vm.evaluate(expr),/Ambiguous class method: zero/);
 assert.deepEqual(output,[]);
 assert.throws(()=>run('print "bad"; get; drop'),/Ambiguous class method: zero/);
 assert.deepEqual(vm.evaluate('{zero}; drop'),[]);
 assert.throws(()=>run('zero','mainType : -> bool\nmainType = zero\n'),/No instance/);
});
test('initializers and async execution retain solved result types',async()=>{
 const p=compile(declarations+'number -> initial\nmain = initial; text');
 assert.deepEqual(new VM(p).evaluate('main'),[0,'']);
 const vm=new VM(p);assert.deepEqual(await vm.evaluateAsync('main'),[0,'']);
});
test('native output-only and nested dispatch agrees with interpreter without a language stack',()=>{
 const body=`print number; print text; print boxed;
  {get} -> q; call q; + 1; print; call q; == ""; print;
  print (call (compose {get} {+ 2}));
  print (map [1,2] {drop; get}; head; + 3);
  print (toList (smap [1,2] {drop; get}); head; + 4);
  print (toList (fromYield {produce}); head; + 5)`;
 const {p,output}=run(body,'produce = yield get\n'),dir=mkdtempSync(join(tmpdir(),'hst-result-dispatch-'));
 try{const file=join(dir,'main.go'),exe=join(dir,'main.exe'),code=transpileGo(p);writeFileSync(file,code);
  const build=spawnSync('go',['build','-o',exe,file],{encoding:'utf8',windowsHide:true,timeout:120000});assert.equal(build.status,0,build.stderr);
  const result=spawnSync(exe,[],{encoding:'utf8',windowsHide:true,timeout:15000});assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,output.join('\n')+'\n');
 }finally{rmSync(dir,{recursive:true,force:true});}
 for(const body of ['get; drop','call {zero}','call {zero; drop}'])assert.throws(()=>transpileGo(compile(declarations+'main = '+body)),/Ambiguous/);
 assert.doesNotThrow(()=>transpileGo(compile(declarations+'main = {zero}; drop')));
});
