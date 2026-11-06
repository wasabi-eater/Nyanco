import test from 'node:test';
import assert from 'node:assert/strict';
import {compile,VM,format} from '../language.mjs';
import {standardTokens} from '../modules.mjs';
import {standardModule} from '../std-modules.mjs';
import {LanguageService} from '../lsp.mjs';
import {transpileCpp} from '../cpp-backend.mjs';
import {transpileGo} from '../go-backend.mjs';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';

const source=`data code = Code int deriving show
instance toInt code where
    int (Code n) = n
instance into int code where
    from n = Code n
instance toFloat bool where
    float = if {1.0} {0.0}
class toInt 'a => readable 'a where
    text : 'a -> string / {exn}
instance readable code where
    text value = show (int value)
convert : toInt 'a => 'a -> int / {exn}
convert = int
make : int -> code / {exn}
make = fromInt
fromCode : code -> int / {exn}
fromCode = from
main =
    byte 'x'; print
    float 3; + 0.5; print
    print (int 3.9); print (char 128512)
    print (float True); print (convert (Code 7)); print (fromCode (Code 8))
    print (make 9); print (text (Code 10))
    print (std.numeric.byte 'A')
    0 .. 3; map {float}; vector; print
    deque [3,1,2]; heap; vector; sort; print
    dict [#(1,"a"),#(2,"b")]; .[2]; print
    set [2,1,2]; sinsert 3; vector; sort; print
    deque []; qisEmpty; print
    heap []; hisEmpty; print
    set []; sisEmpty; print
    handle {byte 256} {exn: {-> message k; print "out of range"; byte 0}}; drop
    print (toInt 4.9); print (toByte 'B')
`;
function program(text=source){return compile(text,'<conversion-names>',new Map(),{tokens:standardTokens(text,'<conversion-names>')});}
function run(p){const output=[];new VM({...p,output:x=>output.push(x)}).evaluate('main');return output;}
const expected=['120','3.5','3',"'😀'",'1','7','8','(Code 9)','10','65','[0, 1, 2]','[1, 2, 3]','b','[1, 2, 3]','True','True','True','out of range','4','66'];

test('target-named conversions retain toX constraints, into, fromX and legacy aliases',()=>{
 const p=program();assert.deepEqual(run(p),expected);
 for(const type of ['int','float','byte','char']){
   const name='to'+type[0].toUpperCase()+type.slice(1),cls=p.definitions.classes.get(name);
   assert.ok(cls.methods.has(type));assert.ok(!cls.methods.has(name));
   assert.match(new VM(p).infer(type),new RegExp(name+" 'a"));
   assert.match(new VM(p).infer(name),new RegExp(name+" 'a"));
   assert.ok(p.definitions.classes.get('num').supers.includes(name));
 }
 assert.throws(()=>new VM().evaluate('byte 1 + int 2'),/unify|instance/i);
 for(const name of ['set','deque','heap','vector','dict'])assert.throws(()=>new VM().evaluate(name),/underflow|empty stack/i,name);
 assert.deepEqual(new VM().evaluate('set [] -> a; sinsert a 1; vector; a; vector'),[[1],[]]);
 assert.deepEqual(new VM(compile('toInt = drop\ntoSet = drop\ntoVector = drop\nmain = set [1,1,2]; vector; sort; int 3.9')).evaluate('main'),[[1,2],3]);
 assert.deepEqual(new VM().evaluate('vector (fromYield {yield 1; cancel; yield 2})'),[[1]]);
});

test('conversion names coexist with types in std modules, hover and completion',()=>{
 const text=`convert : toByte 'a => 'a -> byte / {exn}
convert = byte
collect : [int] -> std.set int
collect = std.set.set
main = convert 'x'; print`;
 const service=new LanguageService(),uri='file:///conversion-names.nyan';
 assert.deepEqual(service.update(uri,text,1).diagnostics,[]);
 const hover=service.request('textDocument/hover',{textDocument:{uri},position:{line:1,character:11}}).contents.value;
 assert.match(hover,/byte :/);assert.match(hover,/toByte 'a/);
 for(const [module,name] of [['numeric','byte'],['vector','vector'],['dict','dict'],['set','set'],['deque','deque'],['heap','heap']]){
   const entry=standardModule('std.'+module).exports.get(name);
   assert.ok(entry.access.has('type'));assert.ok(entry.access.has('value'));
 }
 assert.equal(format(new VM(program('main = std.vector.vector (0 .. 3)')).evaluate('main')),'[[0, 1, 2]]');
});

const cpp=process.platform==='win32'?'cl':'c++';
const hasCpp=!spawnSync(cpp,[cpp==='cl'?'/h':'--version'],{stdio:'ignore',windowsHide:true}).error;
function native(p,backend){const dir=mkdtempSync(join(tmpdir(),'nyanco-conversion-names-'));try{
 const file=join(dir,backend==='cpp'?'main.cpp':'main.go'),exe=join(dir,'main.exe');
 writeFileSync(file,backend==='cpp'?transpileCpp(p):transpileGo(p));
 const args=backend==='go'?['build','-o',exe,file]:cpp==='cl'?['/nologo','/std:c++20','/EHsc','/utf-8','/O2',file,'/Fe:'+exe]:['-std=c++20','-O2','-pthread',file,'-o',exe];
 const build=spawnSync(backend==='go'?'go':cpp,args,{cwd:dir,encoding:'utf8',windowsHide:true,timeout:120000});assert.equal(build.status,0,build.stdout+build.stderr);
 const result=spawnSync(exe,[],{encoding:'utf8',windowsHide:true,timeout:15000});assert.equal(result.status,0,result.stderr);return result.stdout.replaceAll('\r\n','\n');
}finally{assert.equal(dirname(dir),tmpdir());assert.ok(dir.startsWith(join(tmpdir(),'nyanco-conversion-names-')));rmSync(dir,{recursive:true,force:true});}}
test('C++ executes canonical numeric and container conversions with custom instances',{skip:!hasCpp},()=>{assert.equal(native(program(),'cpp'),expected.join('\n')+'\n');});
test('Go retains numeric conversion and supported container behavior',()=>{
 const p=program(source.split('\n').filter(line=>!/^\s*set /.test(line)).join('\n'));
 assert.equal(native(p,'go'),run(p).join('\n')+'\n');
});
