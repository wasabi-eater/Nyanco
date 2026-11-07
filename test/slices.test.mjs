import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {compile,VM,format} from '../language.mjs';
import {transpileGo} from '../go-backend.mjs';
import {transpileCpp} from '../cpp-backend.mjs';
import {verifyTypedIR} from '../typed-ir.mjs';
import {LanguageService} from '../lsp.mjs';
import {canMutateVector} from '../src/runtime/vector-view.mjs';

const evaluate=(source,optimizeVectors=true)=>{
 const output=[],program=compile(source),vm=new VM({...program,optimizeVectors,output:s=>output.push(s)});
 return {stack:vm.evaluate('main'),output,vm,program};
};

test('inclusive slices implement three class methods and preserve index syntax',()=>{
 const {stack,program}=evaluate('main = [0,1,2,3].[1:2], [0,1,2,3].[1:], [0,1,2,3].[:2], [0,1].[0], [0,1].?[9]');
 assert.equal(format(stack),'[[1, 2], [1, 2, 3], [0, 1, 2], 0, None]');
 assert.equal(program.definitions.classes.get('slice').methods.size,3);
 assert.equal(format(evaluate('main = [0,1,2,3]; sliceBetween 1 2; sliceFrom 1; sliceTo 0').stack),'[[2]]');
 assert.equal(format(evaluate('main = [0,1].[1:0], [0,1].[2:], [].[0:]').stack),'[[], [], []]');
 for(const code of ['[1].[:]', '[1].[0:0:0]', '[1].?[0:0]', '[1].[True:0]'])assert.throws(()=>compile('main = '+code));
 assert.match(format(evaluate('main = catch {[0,1].[0:2]}').stack),/Err/);
 assert.match(format(evaluate('main = catch {[0,1].[-1:]}').stack),/Err/);
 assert.equal(format(evaluate('main = 1; [0,1,2].[_:2]').stack),'[[1, 2]]');
});

const custom=`data box = Box [int]
instance slice box where
    sliceBetween (Box xs) lo hi = Box xs.[lo:hi]
    sliceFrom (Box xs) lo = Box xs.[lo:]
    sliceTo (Box xs) hi = Box xs.[:hi]
`;
test('slice instances specialize user types in syntax and ordinary calls',()=>{
 assert.equal(format(evaluate(custom+'main = (Box [0,1,2]).[1:2], sliceFrom (Box [0,1,2]) 1, (Box [0,1,2]).[:1]').stack),'[(Box [1, 2]), (Box [1, 2]), (Box [0, 1])]');
 assert.match(compile('cut xs = xs.[1:]').types.get('cut'),/slice/);
 assert.throws(()=>compile('main = 1.[0:1]'),/No instance: slice int/);
});

test('concatenation patterns match exact ends with at most one unknown length',()=>{
 const source=`middle ([1, 2] ++ rest ++ [3]) = rest
middle _ = []
main =
    middle [1,2,4,5,3], middle [1,2,3], middle [1,8,3]
    [1,2] -> [x] ++ [y]; x, y
    [1,2,3] -> [1] ++ ~ ++ [3]
    [1,2,3] -> [1] ++ rest; rest`;
 assert.equal(format(evaluate(source).stack),'[[4, 5], [], [], 1, 2, [2], [2, 3]]');
 for(const source of ['f (a ++ b) = a','f (a ++ [1,2,3] ++ b) = a','main = [1,2] -> a ++ b'])assert.throws(()=>compile(source),/at most one variable-length/);
 assert.throws(()=>evaluate('main = [1,2] -> [1] ++ [3]'),/pattern did not match/);
 assert.throws(()=>compile('f ([x] ++ rest ++ [x]) = rest'),/Duplicate pattern/);
 assert.throws(()=>compile('f ([1] ++ rest ++ [True]) = rest'),/unify/);
 assert.equal(format(evaluate('main = [1,2] -> [1] ++ mut rest; rest ! vpush 3; rest').stack),'[[2, 3]]');
 const guarded='choose = case\n  -> [1] ++ rest ++ [3] | length rest > 0 ? rest\n  otherwise drop; []\nmain = choose [1,2,3], choose [1,3]';
 assert.equal(format(evaluate(guarded).stack),'[[2], []]');
});

const persistence=`main =
    mut xs <- [0,1,2,3]
    view <- xs.[1:2]
    xs.[1] ! + 10
    print xs
    print view
    view; vpush 9; print
    view with [0] = 8; print
    print view
    xs -> [0] ++ middle ++ [3]
    middle; vpush 7; print
    print xs
    xs; sort; print
`;
test('views and concatenation bindings stay immutable across parent and child updates',()=>{
 const expected=['[0, 11, 2, 3]','[1, 2]','[1, 2, 9]','[8, 2]','[1, 2]','[11, 2, 7]','[0, 11, 2, 3]','[0, 2, 3, 11]'];
 for(const optimize of [true,false])assert.deepEqual(evaluate(persistence,optimize).output,expected);
 const {stack}=evaluate('main = original <- [1,2,3]; original, original.[1:]');
 assert.equal(canMutateVector(stack[0]),false);assert.equal(canMutateVector(stack[1]),false);
 assert.deepEqual([...stack[1]],[2,3]);
 let ir;transpileGo(compile('main = v <- [0,1,2]; v.[1:]; vpush 3'),{onIR:value=>ir=value});
 assert.ok(verifyTypedIR(ir));
 assert.ok(ir.regions.some(r=>r.instructions.some(i=>i.ownership?.mode==='view')));
});

test('LSP reports slices and concatenation bindings with vector types',()=>{
 const service=new LanguageService(),uri='file:///slice.nyan';
 const source='main = [1,2,3] -> [1] ++ rest; rest.[0:]';
 assert.deepEqual(service.update(uri,source,1).diagnostics,[]);
 const hover=service.request('textDocument/hover',{textDocument:{uri},position:{line:0,character:source.lastIndexOf('rest')+1}});
 assert.match(hover.contents.value,/\[int\]/);
 assert.ok(service.update(uri,'main = [1].[:]',2).diagnostics.length);
});

test('Go and C++ execute slices, custom instances, patterns and copy-on-write',t=>{
 const functions='strip ([1,2] ++ ys ++ [3]) = ys\nstrip _ = []\n';
 const extra=[
  '    (Box [0,1,2]).[1:2]; print',
  '    [0,1,2,3].[1:]; print',
  '    [0,1,2,3].[:2]; print',
  '    [0,1,2,3].[1:].[:0]; print',
  '    catch {[1].[:3]}; print',
  '    strip [1,2,4,3]; print',
  '    strip [1,9,3]; print',
  '    [1,2] -> [a] ++ [b]; a + b; print',
 ].join('\n');
 const source=custom+functions+persistence.replace('    mut xs',extra+'\n    mut xs');
 const expected=evaluate(source).output.join('\n')+'\n',dir=mkdtempSync(join(tmpdir(),'nyanco-slices-'));
 try{
  const program=compile(source),go=join(dir,'main.go');writeFileSync(go,transpileGo(program));
  const result=spawnSync('go',['run',go],{encoding:'utf8',windowsHide:true,timeout:120000});
  assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,expected);
  const cpp=join(dir,'main.cpp');writeFileSync(cpp,transpileCpp(program));
  const compiler=process.platform==='win32'?'cl':'c++';
  const probe=spawnSync(compiler,[compiler==='cl'?'/h':'--version'],{windowsHide:true,stdio:'ignore'});
  if(probe.error){t.diagnostic('C++ execution requires cl or c++ in PATH');return;}
  const exe=join(dir,process.platform==='win32'?'main.exe':'main');
  const args=compiler==='cl'?['/nologo','/std:c++20','/EHsc','/utf-8',cpp,'/Fe:'+exe]:['-std=c++20','-pthread',cpp,'-o',exe];
  const build=spawnSync(compiler,args,{cwd:dir,encoding:'utf8',windowsHide:true,timeout:120000});
  assert.equal(build.status,0,build.stdout+build.stderr);
  const native=spawnSync(exe,[],{encoding:'utf8',windowsHide:true,timeout:15000});
  assert.equal(native.status,0,native.stderr);assert.equal(native.stdout.replaceAll('\r\n','\n'),expected);
 }finally{
  assert.equal(dirname(dir),tmpdir());assert.ok(dir.startsWith(join(tmpdir(),'nyanco-slices-')));rmSync(dir,{recursive:true,force:true});
 }
});
