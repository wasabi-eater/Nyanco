import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {compile,VM,format} from '../migration/v048-adapter.mjs';
import {transpileGo} from '../go-backend.mjs';
const go=spawnSync('go',['version'],{windowsHide:true}).status===0;
test('native prefix evaluation, comma captures, associated types and effects match interpreter',{skip:!go},()=>{
  const program=compile(`data box 'a = Box 'a
class unpack 'c where
  type item
  unpack : 'c -> item
instance unpack (box 'a) where
  item : 'a
  unpack (Box x) = x
data lmap 'c 'a 'b = LMap 'c {'a -> 'b}
instance streem 'c 'a => streem (lmap 'c 'a 'b) where
  item : 'b
  each (LMap c f) g = each c {call f; call g}
effect yield 'a: 'a ->
effect ask: -> num
effect fail: string -> !
abs = when ($ < 0) {0 -}
sum xs = 0; each xs {+}
x = print "x"
y = print "y"
f = print "f"
effect state 'a where
  askState: -> 'a
  writeState: 'a ->
main =
  0 -> mut cell;
  handle {writeState 17; askState} {askState: {-> k; resume cell k}, writeState: {-> value k; cell := value; resume k}}; print;
  print read; print read; print read;
  f x y;
  print (abs -5);
  print (sum [1, 2, 3]);
  print (unpack (Box 7));
  0; each (LMap [1, 2, 3] {+ 10}) {+}; print;
  handle {yield 3; ask; "done"} {yield: {-> v k; print v; resume k}, ask: {-> k; resume 42 k}}; print; print;
  handle {fail "bad"} {fail: {-> reason k; 8, "abort"}}; print; print;
  3 4; _, _; print; print; print;
  {x: 9} -> r; print r.x;
  #(3, "x") -> t; print t.0;
  0 -> mut count, count ! (+ 2), print count;
  [] -> mut logs;
  handle {print 42; print True} {put: {-> text k; logs ! (:: text); resume k}};
  print logs;
  handle {print "silenced"; 5} {put: {-> text k; 99}}; print;
  handle {print "forward"} {put: {-> text k; put text; resume k}}`);
  const inputs=['日本語','second',''];
  const expected=[],vm=new VM({...program,input:()=>inputs.shift(),output:x=>expected.push(x),warning:()=>{}}),stack=vm.evaluate('main');expected.push(format(stack));
  const dir=mkdtempSync(join(tmpdir(),'nyanco-prefix-'));
  try{
    const file=join(dir,'main.go'),exe=join(dir,'main.exe'),source=transpileGo(program,{showStack:true});
    assert.doesNotMatch(source,/type Stack|\*Stack|\.push\(|\.pop\(/);writeFileSync(file,source);
    const built=spawnSync('go',['build','-o',exe,file],{encoding:'utf8',windowsHide:true,timeout:120000,env:{...process.env,CGO_ENABLED:'0',GOWORK:'off',GO111MODULE:'off'}});
    assert.equal(built.status,0,built.stderr);
    const result=spawnSync(exe,[],{input:'日本語\r\nsecond\n',encoding:'utf8',windowsHide:true,timeout:15000});assert.equal(result.status,0,result.stderr);
    assert.equal(result.stdout,expected.join('\n')+'\n');
  }finally{rmSync(dir,{recursive:true,force:true});}
});
