import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {compile,VM,format} from '../language.mjs';
import {compileModule} from '../modules.mjs';
import {transpileGo} from '../go-backend.mjs';

test('deque operations preserve aliases, handle both ends, and return options',()=>{
 const vm=new VM(compile(''));
 assert.deepEqual(vm.evaluate('toDeque [1,2]; qpushFront 0; qpush 3; toVector'),[[0,1,2,3]]);
 assert.deepEqual(vm.evaluate('toDeque [1,2]; dup; qpop; swap; drop; toVector; swap; toVector'),[[2],[1,2]]);
 assert.deepEqual(vm.evaluate('toDeque [1,2]; qpopBack; swap; unwrap; swap; qpopFront; swap; unwrap; swap; qisEmpty'),[2,1,true]);
 assert.equal(format(vm.evaluate('deque []; qpopFront')[0]),'None');
 assert.deepEqual(vm.evaluate('toDeque [1,2]; dup; qpeekBack; unwrap; swap; qlength'),[2,2]);
 assert.deepEqual(vm.evaluate('0; each (toDeque [1,2,3]) {+};'),[6]);
 assert.deepEqual(vm.evaluate('0; each (toDeque [1,2,3]) {+; cancel}'),[0]);
});

test('all three collection types convert in both directions',()=>{
 const vm=new VM(compile(''));
 for(const source of ['toVector (toDeque [3,1,4,2])','toVector (toHeap [3,1,4,2])',
                      'toVector (toDeque (toHeap [3,1,4,2]))','toVector (toHeap (toDeque [3,1,4,2]))']){
  const [vector]=vm.evaluate(source);
  assert.deepEqual([...vector].sort((a,b)=>a-b),[1,2,3,4],source);
 }
 assert.deepEqual(vm.evaluate('toVector (toDeque [3,1,4,2])'),[[3,1,4,2]]);
 assert.deepEqual(vm.evaluate('toDeque [3,1,4,2]; toHeap; hpeek; unwrap'),[4]);
 assert.deepEqual(vm.evaluate('toHeap []; toDeque; toVector'),[[]]);
 assert.deepEqual(vm.evaluate('toHeap (deque []); hisEmpty'),[true]);
 for(const collection of ['[1,2,3]','toDeque [1,2,3]','toHeap [1,2,3]']){
  assert.deepEqual(vm.evaluate('0; each ('+collection+') {+}'),[6]);
 }
 assert.deepEqual(vm.evaluate('toVector (map [1,2,3] {* 2})'),[[2,4,6]]);
 assert.deepEqual(vm.evaluate('toDeque (map [1,2,3] {* 2}); toVector'),[[2,4,6]]);
 assert.deepEqual(vm.evaluate('toHeap (map [1,2,3] {* 2}); hpeek; unwrap'),[6]);
});
test('binary max heap orders pops, preserves old heaps and enforces ord',()=>{
 const vm=new VM(compile(''));
 let h=vm.evaluate('toHeap [3,1,4,1,5,9,2,6]')[0],out=[];
 while(h.items.length){const [item,next]=vm.evaluate('hpop',[h]);h=next;out.push(item.fields[0]);}
 assert.deepEqual(out,[9,6,5,4,3,2,1,1]);
 assert.deepEqual(vm.evaluate('toHeap [1,2] -> h; hpush h 9; hpeek; unwrap; hpeek h; unwrap'),[9,2]);
 assert.equal(format(vm.evaluate('heap []; hpop')[0]),'None');
 assert.throws(()=>vm.evaluate('heap []; hpush {nop}'),/No instance: (ord|eq)/);
 assert.throws(()=>vm.evaluate('toHeap [1]; hpush "bad"'),/unify/);
});

const source=`open data rank = Rank int deriving eq
instance ord rank where
  (<) (Rank x) (Rank y) = x > y
  (>) (Rank x) (Rank y) = x < y
  (<=) (Rank x) (Rank y) = x >= y
  (>=) (Rank x) (Rank y) = x <= y
main =
 print (std.vector.push [] 3)
 print (vpush [] 4)
 toDeque [1,2]; qpushFront 0; qpush 3 -> mut q
 q ! qpopBack; print; print q
 toHeap [3,1,4,2] -> mut h
 h ! hpop; print; print h
 print (toVector (toDeque [1,2,3]))
 toHeap [Rank 3, Rank 1, Rank 2]; hpop; drop; print
 print (toVector (map (toDeque [1,2]) {+ 1}))
 print (sort (toHeap [3,1,4,2]))
 print (sort (toDeque (toHeap [3,1,4,2])))
 toDeque [3,1,4,2]; toHeap; hpeek; print
 loop {q ! std.deque.popFront; ?? cancel -> x; print (x * 2)}
 print (qisEmpty q)
`;
test('standard collection modules and native backend match interpreter including custom ord',()=>{
 const dir=mkdtempSync(join(tmpdir(),'nyanco-collections-'));
 try{
  const file=join(dir,'main.nyan');writeFileSync(file,source);const p=compileModule(file),output=[];
  new VM({...p,output:s=>output.push(s),warning:()=>{}}).evaluate('main');
  assert.deepEqual(output,['[3]','[4]','(Some 3)','deque [0, 1, 2]','(Some 4)','heap [3, 2, 1]','[1, 2, 3]','(Some (Rank 1))','[2, 3]','[1, 2, 3, 4]','[1, 2, 3, 4]','(Some 4)','0','2','4','True']);
  const go=join(dir,'main.go');writeFileSync(go,transpileGo(p));const run=spawnSync('go',['run',go],{encoding:'utf8',timeout:120000});assert.equal(run.status,0,run.stderr);assert.equal(run.stdout.trim(),output.join('\n'));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
