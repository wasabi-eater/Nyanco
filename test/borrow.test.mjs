import test from 'node:test';
import assert from 'node:assert/strict';
import {compile,VM} from '../language.mjs';
import {compileModule} from '../modules.mjs';
import {transpileGo} from '../go-backend.mjs';
import {verifyTypedIR} from '../typed-ir.mjs';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
const run=source=>new VM({...compile(source),warning:()=>{}}).evaluate('main');
const scoped=body=>'main = mut x <- 0; borrow mut x as r {'+body+'}';

test('explicit effect variables are universally checked; calls can still instantiate them',()=>{
 const apply="f : {-> / {| 'e}} -> / {| 'e}\nf q = call q\n";
 assert.deepEqual(run(apply+'main = f {nop}'),[]);
 const output=[],p=compile(apply+'main = f {print "ok"}');new VM({...p,output:s=>output.push(s)}).evaluate('main');assert.deepEqual(output,['ok']);
 for(const s of [
  'mut saved <- {nop}\nf : {-> / {| \'e}} -> / {| \'e}\nf q = saved <<- q',
  'mut saved <- {print "io"}\nf : {-> / {| \'e}} -> / {| \'e}\nf q = saved <<- q',
  'f : {-> / {| \'e}} -> / {| \'f}\nf q = call q',
  'f : -> / {| \'e}\nf = print "io"',
  'f : {-> / {| \'e}} -> / {| \'e}\nf q = call q; print "io"',
 ])assert.throws(()=>compile(s),/Universally quantified|not allowed/);
 assert.doesNotThrow(()=>compile("f : {-> / {| 'e}} -> / {| 'e}\nf q = drop q"));
 assert.doesNotThrow(()=>compile("f : {-> / {'e}} -> / {'e}\nf q = call q"));
 // Omitted effect annotations remain inference holes, not explicit forall rows.
 assert.match(compile('q : -> {->}\nq = {print "io"}').types.get('q'),/io/);
});

test('mutable borrows support callbacks, polymorphic helpers and nested reborrowing',()=>{
 const header="bump : mutref 'r int -> / {borrowMut 'r}\nbump r = writeRef r (readRef r + 1)\n";
 assert.deepEqual(run(header+scoped('writeRef r 3; when True {bump r}; readRef r')),[4]);
 assert.deepEqual(run('main = mut x <- 0; borrow mut x as r {borrow mut r as s {writeRef s 9}; writeRef r 10}; x'),[10]);
 assert.deepEqual(run(scoped('toVector (map [1,2] {drop; readRef r})')),[[0,0]]);
 assert.deepEqual(run(scoped('0; each [1,2] {+; writeRef r $; cancel}')+'; x'),[0,1]);
});

test('exclusivity covers aliases, existing closures and functions with global mutable captures',()=>{
 for(const body of ['x','x <<- 1','x ! + 1','borrow mut x as s {nop}','borrow mut r as s {readRef r; drop}'])
  assert.throws(()=>compile(scoped(body)),/borrowed|reborrow|suspended/);
 assert.throws(()=>compile('main = mut x <- 0; {x} -> old; borrow mut x as r {call old}'),/borrowed/);
 assert.throws(()=>compile('mut x <- 0\nreadX : -> int / {}\nreadX = x\nmain = borrow mut x as r {readX}'),/borrowed/);
 assert.throws(()=>compile("mut x <- 0\nf : {-> / {| 'e}} -> / {| 'e}\nf q = borrow mut x as r {call q}\nmain = f {drop x}"),/borrowed/);
 assert.throws(()=>compile(scoped('mut holder <- r; borrow mut holder as s {writeRef s 3}')),/Cannot unify/);
 assert.throws(()=>compile('main = x <- 0; borrow mut x as r {nop}'),/mutable variable/);
});

test('borrow capture information survives quotations, lazy streams, ADTs and aliases',()=>{
 for(const body of ['r','{readRef r}','{drop r}','[r]','{ref: r}','#(r)','map [1] {drop; readRef r}'])assert.throws(()=>compile(scoped(body)),/escapes/);
 for(const prefix of [
  'data box = Box {->}\npack q = Box q\nunpack (Box q) = q\n',
  'open type box = {q: {->}}\npack : {-> / {| \'e}} -> box\npack q = {q: q}\nunpack b = b.q\n',
 ])assert.throws(()=>compile(prefix+scoped('unpack (pack {drop r})')),/escapes/);
 assert.throws(()=>compile('mut saved <- {nop}\n'+scoped('saved <<- {drop r}')),/escapes/);
});

test('protected loans cannot be masked, handled, performed or passed to escaping effect handlers',()=>{
 assert.throws(()=>compile(scoped('mask borrowMut {drop r}')),/cannot be masked/);
 assert.throws(()=>compile(scoped('handle {readRef r} {borrowMut: {nop}}')),/cannot be handled/);
 assert.throws(()=>compile('main = borrowMut'),/cannot be performed/);
 assert.throws(()=>compile("effect send 'a : 'a ->\n"+scoped('send r')),/payload/);
 assert.throws(()=>compile("effect send 'a : 'a ->\nmain = mut x <- 0; {x} -> q; borrow mut x as r {send q}"),/payload/);
 assert.throws(()=>compile('mut x <- 0\neffect ask : -> int\nf : -> / {ask}\nf = borrow mut x as r {writeRef r ask}\nmain = handle {f} {ask: {-> k; drop x; resume 1 k}}'),/handler accesses/);
 assert.throws(()=>compile('effect ask : -> int\n'+scoped('handle {borrow mut r as s {writeRef s ask}} {ask: {-> k; drop (readRef r); resume 1 k}}')),/parent reference during reborrow/);
 assert.deepEqual(run('mut x <- 0\neffect ask : -> int\nmain = handle {borrow mut x as r {writeRef r ask}; x} {ask: {-> k; resume 7 k}}'),[7]);
});

test('failed borrowed writes remain transactional in the REPL',()=>{
 const vm=new VM({warning:()=>{}});vm.evaluate('mut x <- 1');
 assert.throws(()=>vm.evaluate('borrow mut x as r {writeRef r 9; exn "failed"}'),/failed/);
 assert.deepEqual(vm.evaluate('x'),[1]);
 assert.deepEqual(vm.evaluate('borrow mut x as r {writeRef r 2}; x'),[2]);
});

test('borrow modules, IR loan identities and native scoped cleanup match the VM',()=>{
 const source=`pub bump : mutref 'r int -> / {borrowMut 'r}
bump r = std.borrow.writeRef r (std.borrow.readRef r + 1)
effect ask : -> int
main =
 mut x <- 10
 borrow mut x as r {when True {bump r}; borrow mut r as s {writeRef s 20}; bump r}
 print x
 print (borrow mut x as r {toVector (map [1,2] {drop; readRef r})})
 handle {borrow mut x as r {writeRef r ask}} {ask: {-> k; resume 8 k}}
 print x
 0; each [1,2] {+; borrow mut x as r {writeRef r 99; cancel}}; print
 print x
`;
 const dir=mkdtempSync(join(tmpdir(),'nyanco-borrow-'));
 try{
  const file=join(dir,'main.nyan');
  mkdirSync(join(dir,'aliases'));
  writeFileSync(join(dir,'aliases','main.nyan'),'pub import "std.effects" {borrowMut as secret}\nf = mut x <- 0; borrow mut x as r {handle {readRef r} {secret: {nop}}}');
  writeFileSync(file,'import "./aliases"\nmain = nop');
  assert.throws(()=>compileModule(file),/cannot be handled/);
  writeFileSync(join(dir,'aliases','main.nyan'),'pub import "std.effects" {borrowMut as secret}');
  writeFileSync(file,source);const p=compileModule(file),output=[];new VM({...p,output:s=>output.push(s),warning:()=>{}}).evaluate('main');
  assert.deepEqual(output,['21','[21, 21]','8','0','99']);
  let ir;const go=join(dir,'main.go');writeFileSync(go,transpileGo(p,{onIR:x=>ir=x}));assert.ok(verifyTypedIR(ir));assert.ok(ir.regions.flatMap(r=>r.instructions).some(i=>i.loan?.mode==='mutable'));
  const native=spawnSync('go',['run',go],{encoding:'utf8',timeout:120000});assert.equal(native.status,0,native.stderr);assert.equal(native.stdout.trim(),output.join('\n'));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
