import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {compile,VM} from '../language.mjs';
import {transpileGo} from '../go-backend.mjs';

const source=`data amount = Amount int deriving show
instance fromInt amount where
    from n = Amount n
instance add amount where
    (+) (Amount a) (Amount b) = Amount (a + b)
instance mul amount where
    (*) (Amount a) (Amount b) = Amount (a * b)
data bag 'a = Bag ['a]
instance streem (bag 'a) where
    item : 'a
    each (Bag xs) f = each xs f
emptyInts : -> [int]
emptyInts = []
main =
    [1,2,3]; sum; print
    [1,2,3,4]; product; print
    [1.5,2.5]; sum; print
    [1.5,2.5]; product; print
    [toByte 2,toByte 3]; sum; print
    [toByte 2,toByte 3]; product; print
    emptyInts; sum; print
    emptyInts; product; print
    1 ..= 4; sum; print
    1 ..= 4; product; print
    Bag [Amount 2,Amount 3]; sum; print
    Bag [Amount 2,Amount 3]; product; print
    fromYield {yield 2; cancel; yield 3}; sum; print
    fromYield {yield 2; cancel; yield 3}; product; print
    catch {sum (fromYield {yield 1; exn "source"})}; print
    99; sum [1,2]; print; print
`;
const expected=['6','24','4','3.75','5','6','0','1','10','24','(Amount 5)','(Amount 6)','2','2','(Err "source")','3','99'];

test('sum and product retain numeric and traversal polymorphism',()=>{
 const program=compile(source),output=[];
 new VM({...program,output:line=>output.push(line)}).evaluate('main');
 assert.deepEqual(output,expected);
 assert.match(program.types.get('sum'),/add 'b, fromInt 'b/);
 assert.match(program.types.get('product'),/fromInt 'b, mul 'b/);
 assert.doesNotMatch(program.types.get('sum'),/num 'b/);
 const vm=new VM(program);
 assert.match(vm.infer('sum (fromYield {read; parseInt; yield})'),/io/);
});

test('Go standard sum and product specialize scalar types and user instances',()=>{
 const dir=mkdtempSync(join(tmpdir(),'nyanco-aggregates-'));
 try{
  const file=join(dir,'main.go');writeFileSync(file,transpileGo(compile(source)));
  const result=spawnSync('go',['run',file],{encoding:'utf8',windowsHide:true,timeout:120000});
  assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,expected.join('\n')+'\n');
 }finally{
  assert.equal(dirname(dir),tmpdir());assert.ok(dir.startsWith(join(tmpdir(),'nyanco-aggregates-')));rmSync(dir,{recursive:true,force:true});
 }
});
