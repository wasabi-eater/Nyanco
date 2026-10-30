import test from 'node:test';
import assert from 'node:assert/strict';
import {compile,VM,format} from '../language.mjs';
import {transpileGo} from '../go-backend.mjs';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const run=source=>{const p=compile(source),output=[],vm=new VM({...p,output:s=>output.push(s),warning:()=>{}});return {p,output,stack:vm.evaluate('main')};};
const custom=`class zero 'a where
  zero : -> 'a
instance zero num where
  zero = 0
data key = Key num
instance ord key where
  (<) (Key a) (Key b) = a > b
  (<=) (Key a) (Key b) = a >= b
  (>) (Key a) (Key b) = a < b
  (>=) (Key a) (Key b) = a <= b
data bag = Bag [num]
instance streem bag where
  item : num
  each (Bag xs) f = each xs f
`;
const source=custom+`main =
  print (fold (map (1 ..= 5) {* 2}) 0 {+});
  print (fold (Bag [1,2,3]) 0 {+});
  print (fold (fromYield {yield 1; yield 2; yield 3}) 10 {when ($ == 3) {break}; +});
  print (reverse (map (1 ..= 4) {* 2}));
  print (sort (Bag [3,1,2,1]));
  print (sortBy [{score: 2, id: "a"}, {score: 1, id: "b"}, {score: 2, id: "c"}] {.score});
  print (sortBy [3,1,2] {print $; 0 -});
  print (sortBy [3,1,2] {when ($ == 2) {break}; nop});
  print (reverse (fromYield {yield 1; yield 2; break; yield 3}));
  print (sort []);
  print (sort [Key 1, Key 3, Key 2]);
  print (sortBy [1,2,3] {Key});
  print (fold (1 ..= 3) zero {+});
  print (sortBy [3,2,1] {break});
  print ([1,2].?[0]);
  print ([1,2].?[3])`;
test('collectors accept streem instances, preserve stable order and stop on break',()=>{
 assert.deepEqual(run(source).output,['30','6','13','[8, 6, 4, 2]','[1, 1, 2, 3]','[{id: "b", score: 1}, {id: "a", score: 2}, {id: "c", score: 2}]','3','1','2','[3, 2, 1]','[1, 3]','[2, 1]','[]','[(Key 3), (Key 2), (Key 1)]','[3, 2, 1]','6','[]','(Some 1)','None']);
 assert.deepEqual(run('main = 100; fold (1 ..= 3) 0 {+}').stack,[100,6]);
 assert.deepEqual(run('main = [3,1,2] -> xs; sort xs; xs').stack,[[1,2,3],[3,1,2]]);
});
test('collector types include key effects and latent producer effects',()=>{
 const p=compile('f xs = sortBy xs {print $; nop}');assert.match(p.types.get('f'),/ord/);assert.match(p.types.get('f'),/io/);
 assert.match(compile('f = fold (fromYield {print "hi"; yield 1}) 0 {+}').types.get('f'),/io/);
 assert.throws(()=>compile('main = sort [{x: 1}]'),/instance/i);
 assert.throws(()=>compile('main = sortBy [1] {dup}'),/unify|stack/i);
 assert.doesNotMatch(run('main = fold (1 ..= 3) 0 {when ($ == 2) {break}; +}').p.types.get('main'),/break/);
});
test('value rendering uses comma vectors and prefix constructors recursively',()=>{
 assert.equal(format(run('data tree = Leaf num | Node tree tree\nmain = Node (Leaf 1) (Leaf 2)').stack[0]),'(Node (Leaf 1) (Leaf 2))');
 assert.equal(format(run('main = Some [[1,2], []]').stack[0]),'(Some [[1, 2], []])');
});
test('native collectors match VM including class instances, key effects and break',()=>{
 const {p,output}=run(source),dir=mkdtempSync(join(tmpdir(),'nyanco-collect-'));
 try {const file=join(dir,'main.go'),exe=join(dir,'main.exe');writeFileSync(file,transpileGo(p));const build=spawnSync('go',['build','-o',exe,file],{encoding:'utf8',windowsHide:true,timeout:120000});assert.equal(build.status,0,build.stderr);const result=spawnSync(exe,[],{encoding:'utf8',windowsHide:true,timeout:15000});assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,output.join('\n')+'\n');}finally{rmSync(dir,{recursive:true,force:true});}
});


