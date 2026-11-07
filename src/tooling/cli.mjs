#!/usr/bin/env node
import { readFile, writeFile, mkdtemp, rename, copyFile, rm } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { transpileGo } from '../compiler/go/go-backend.mjs';
import {createReplInterface,highlight} from './repl-highlight.mjs';
import { stdin, stdout } from 'node:process';
import { VM, compile, format, builtinNames, lex, parseExpression, formatWarning } from '../frontend/language.mjs';
import { checkExpression } from '../types/types.mjs';
import {compileModule,standardTokens} from '../frontend/modules.mjs';
import {standardModule,standardModuleNames} from '../frontend/std-modules.mjs';

const help = `Nyanco 0.84.0 — statically typed stack language
Usage:
  nyanco                       Interactive REPL
  nyanco program.nyan           Execute main (all .nyan files in its directory)
  nyanco --single-file file.nyan Execute a standalone file
  nyanco program.nyan --stack   Execute main and show final stack
  nyanco --eval "2 + 3"         Evaluate and show final stack
  nyanco program.nyan --eval "factorial 5"
  nyanco --check program.nyan   Check syntax and types (no execution)
  nyanco --types program.nyan   Show inferred function stack effects
  nyanco --type "dup"          Infer an expression without executing it
  nyanco program.nyan --emit-ir ir.json   Write typed intermediate representation
  nyanco program.nyan --dump-ir          Show readable typed IR (no execution)
  nyanco program.nyan --emit-ir-text ir.txt Write readable typed IR to a file
  nyanco program.nyan --emit-go main.go   Transpile to standalone Go
  nyanco program.nyan --emit-cpp main.cpp Transpile to standalone C++20
  nyanco program.nyan --build program.exe Build a native executable
  nyanco program.nyan --procon           Write path-free C++ with buffered IO
  --no-source-paths            Omit source paths from generated Go and C++
  --batch-io                   Buffer C++ output across reads (non-interactive)
  --interactive-io             Flush C++ output before reads (overrides procon default)
  --rc local|shared            C++ reference counting (procon: local, otherwise: shared)
  nyanco --lsp                 Start Language Server (stdio)
  nyanco --help
REPL: :help, :quit, :stack, :clear, :words, :type EXPR, :load PATH, :{ ... :}
`;

async function repl() {
  const isDefinition=source=>{
    let depth=0,withUpdate=false;
    return lex(source).some(t=>{
      if(!depth&&t.value==='with')withUpdate=true;
      const found=!depth && !withUpdate && t.kind==='word' && ['=',':','class','instance','effect'].includes(t.value);
      if(['(','[','{'].includes(t.kind))depth++;
      if([')',']','}'].includes(t.kind))depth--;
      return found;
    });
  };
  const rl = createReplInterface({input:stdin,output:stdout});
  const color=Boolean(stdin.isTTY&&stdout.isTTY)&&!('NO_COLOR' in process.env)&&process.env.TERM!=='dumb';
  const lines = rl[Symbol.asyncIterator]();
  const vm = new VM({input:async()=>{const line=await lines.next();return line.done?'':line.value;}}); let stack = [], block = null, continued = null;
  vm.definitions.moduleTokens=standardTokens;
  const install = async (source, file, module = false) => {
    const previous = vm.definitions;
    const program = module?compileModule(file,{previous,globals:vm.globals}):compile(source, file, previous, {globals: vm.globals});
    for(const warning of program.warnings||[])process.stderr.write(formatWarning(warning)+'\n');
    vm.definitions = program.definitions;
    try { await vm.executeAsync([]); } catch (error) { vm.definitions = previous; throw error; }
  };
  stdout.write('Nyanco 0.84.0 — static types; :type EXPR for inference\n');
  rl.setPrompt('nyanco> '); if (stdin.isTTY) rl.prompt();
  for await (const line of lines) {
    const source = continued === null ? line : continued + '\n' + line;
    const input = source.trim();
    try {
      if (block === null && (continued !== null || !input.startsWith(':'))) {
        continued = null;
        try { lex(source, '<repl>'); }
        catch (error) {
          if (!error.incompleteContinuation) throw error;
          continued = source;
          rl.setPrompt('...> ');
          if (stdin.isTTY && !rl.closed) rl.prompt();
          continue;
        }
      }
      if (block !== null) {
        if (input === ':}') {
          const source = block.join('\n'); block = null;
          await install(source, '<repl>');
          stdout.write('Defined.\n');
        } else block.push(line);
      } else if (input === ':quit' || input === ':q') break;
      else if (input === ':{') block = [];
      else if (input === ':help') stdout.write(help + '\nDefinitions: square x = x * x\nBindings: 3, 4, 5 -> x y z; x + y * z\nSeparators: comma shares captures; semicolon starts a new clause\nSections: 3, 2; (+), 3; (+ 2), 3; (2 +), 3 + 2\nMulti-clause definitions: enter :{, declarations, then :}\n');
      else if (input === ':stack') stdout.write(format(stack) + '\n');
      else if (input.startsWith(':type ')) {const type=vm.infer(input.slice(6),'<repl-type>');stdout.write((color?highlight(type):type)+'\n');}
      else if (input === ':clear') { stack = []; stdout.write('[]\n'); }
      else if (input === ':words') stdout.write([...new Set([...builtinNames(), ...(vm.definitions.effects?.keys()||[]), ...(vm.definitions.constructors?.keys() || []), ...(vm.definitions.methods?.keys() || []), ...[...vm.definitions.keys()].filter(n=>!n.startsWith('__tc_')), ...vm.globals.keys(),...vm.definitions.modulePublicNames||[],...standardModuleNames().flatMap(module=>[module,...[...standardModule(module).exports.keys()].map(name=>module+'.'+name)])])].filter(n=>!vm.definitions.effects?.get(n)?.qualifiedName&&!/^nyancoModule/i.test(n)&&!n.startsWith('__tc_')).join(' ') + '\n');
      else if (input.startsWith(':load ')) {
        const path = input.slice(6).trim();
        await install(null,path,true);
        stdout.write(`Loaded ${path}\n`);
      } else if (input.startsWith(':')) throw new Error(`Unknown REPL command: ${input}`);
      else if (isDefinition(input)) {
        await install(input, '<repl>');
        stdout.write('Defined.\n');
      } else if (input) {
        const next = [...stack]; await vm.evaluateAsync(source, next, '<repl>'); stack = next;
        stdout.write(format(stack) + '\n');
      }
    } catch (error) { stdout.write(`Error: ${error.message}\n`); }
    rl.setPrompt(block === null ? 'nyanco> ' : '...> '); if (stdin.isTTY && !rl.closed) rl.prompt();
  }
  if (block !== null) stdout.write('Error: unfinished definition block (expected :})\n');
  if (continued !== null) stdout.write('Error: unfinished line continuation\n');
  rl.close();
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length) return repl();
  if (args.length === 1 && args[0] === '--lsp') { const {startServer}=await import('./lsp.mjs'); startServer(); return; }
  let file, expression, typeExpression, emitGo, emitCpp, emitIR, emitIRText, build, batchIO, referenceCounting, dumpIR = false, check = false, singleFile = false, procon = false, noSourcePaths = false, showStack = false, showTypes = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') { stdout.write(help); return; }
    if (arg === '--eval' || arg === '-e') {
      if (expression !== undefined || args[i + 1] === undefined) throw new Error('--eval requires exactly one expression');
      expression = args[++i];
    } else if (arg === '--type') {
      if(typeExpression !== undefined || args[i+1] === undefined) throw new Error('--type requires one expression');
      typeExpression=args[++i];
    } else if (arg === '--emit-go' || arg === '--emit-cpp' || arg === '--emit-ir' || arg === '--emit-ir-text' || arg === '--build') {
      const path=args[++i];
      const existing={'--emit-go':emitGo,'--emit-cpp':emitCpp,'--emit-ir':emitIR,'--emit-ir-text':emitIRText,'--build':build};
      if(!path || path.startsWith('-') || existing[arg])throw new Error(`${arg} requires one output path`);
      if(arg==='--emit-go')emitGo=resolve(path);
      else if(arg==='--emit-cpp')emitCpp=resolve(path);
      else if(arg==='--emit-ir')emitIR=resolve(path);
      else if(arg==='--emit-ir-text')emitIRText=resolve(path);
      else build=resolve(path);
    } else if (arg === '--types') showTypes = true;
    else if (arg === '--dump-ir') dumpIR = true;
    else if (arg === '--check') check = true;
    else if (arg === '--single-file') singleFile = true;
    else if (arg === '--procon') procon = true;
    else if (arg === '--no-source-paths') noSourcePaths = true;
    else if (arg === '--batch-io') batchIO = true;
    else if (arg === '--interactive-io') batchIO = false;
    else if (arg === '--rc') {
      referenceCounting=args[++i];
      if(!['local','shared'].includes(referenceCounting))throw new Error('--rc requires local or shared');
    }
    else if (arg === '--stack') showStack = true;
    else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else if (!file) file = arg;
    else throw new Error('Only one source file is supported');
  }
  if (check && (!file || expression !== undefined)) throw new Error('--check requires a file and cannot be combined with --eval');
  if(typeExpression !== undefined && (check || expression !== undefined || showTypes || showStack)) throw new Error('--type cannot be combined with execution or other check options');
  if(showTypes && (!file || expression !== undefined)) throw new Error('--types requires a file and cannot be combined with --eval');
  const outputs=[emitGo,emitCpp,emitIR,emitIRText,build].filter(Boolean);
  const readableIR=dumpIR||emitIRText;
  const generateCpp=emitCpp||procon||(readableIR&&!emitGo&&!build);
  if(batchIO!==undefined&&!generateCpp)throw new Error(`${batchIO?'--batch-io':'--interactive-io'} requires C++ output (--procon or --emit-cpp)`);
  if(referenceCounting!==undefined&&!generateCpp)throw new Error('--rc requires C++ output (--procon or --emit-cpp)');
  if((outputs.length||procon||dumpIR) && (check || showTypes || typeExpression!==undefined))throw new Error('Compiled output cannot be combined with --check, --types or --type');
  const pathKey=p=>process.platform==='win32'?p.toLowerCase():p;
  if(new Set(outputs.map(pathKey)).size!==outputs.length || (file && outputs.map(pathKey).includes(pathKey(resolve(file)))))throw new Error('Input and output paths must be different');
  if (!file && expression === undefined && typeExpression === undefined) throw new Error('Specify a file, --eval or --type');
  const standalone=new Map();standalone.moduleTokens=standardTokens;
  const program = file ? (singleFile?compile(await readFile(file, 'utf8'), file,standalone):compileModule(file)) : compile('', '<input>', standalone);
  if(outputs.length&&program.modules){
    const sources=new Set([...program.modules.sources.keys()].map(pathKey));
    if(outputs.some(path=>sources.has(pathKey(path))))throw new Error('Input and output paths must be different');
  }
  const vm = new VM(program);
  if (typeExpression !== undefined) {stdout.write(vm.infer(typeExpression) + '\n');return;}
  if (showTypes) {for(const [name,type] of program.types)if(!/^nyancoModule/i.test(name)&&!name.startsWith('__tc_'))stdout.write(`${name} : ${type}\n`);return;}
  if (check) {
    // A file with main is also checked as an executable starting with no values.
    if(program.definitions.has('main')) {
      checkExpression(parseExpression('main'),program.definitions);
    }
    stdout.write(`Types OK: ${file}\n`); return;
  }
  if (expression === undefined && !program.definitions.has('main')) throw new Error('Program has no main definition');
  if(outputs.length||procon||dumpIR) {
    const cppToStdout=procon&&!emitCpp;
    const report=cppToStdout||dumpIR?process.stderr:stdout;
    if(expression!==undefined)vm.infer(expression);
    let ir;
    const options={noSourcePaths,batchIO:batchIO??procon,referenceCounting:referenceCounting??(procon?'local':'shared'),expression:expression ?? 'main',showStack:showStack || expression!==undefined};
    const onIR=emitIR||readableIR?value=>{ir=value;}:null;
    const source=emitGo||build||(!generateCpp&&emitIR)?transpileGo(program,{...options,onIR:generateCpp?null:onIR}):null;
    const attribution = procon ? '// Generated by Nyanco using C++ runtime templates from https://github.com/wasabi-eater/Nyanco\n' : '';
    const cpp = generateCpp
      ? attribution + (await import('../compiler/cpp/cpp-backend.mjs')).transpileCpp(program,{...options,noSourcePaths:noSourcePaths||procon,onIR})
      : null;
    if(emitIR){await writeFile(emitIR,JSON.stringify(ir,null,2)+'\n','utf8');report.write(`Typed IR: ${emitIR}\n`);}
    if(readableIR){
      const {formatTypedIR}=await import('../compiler/ir-format.mjs');
      const text=formatTypedIR(ir,{backend:generateCpp?'C++':'Go',noSourcePaths:noSourcePaths||procon});
      if(emitIRText){await writeFile(emitIRText,text,'utf8');report.write(`Readable IR: ${emitIRText}\n`);}
      if(dumpIR)(cppToStdout?process.stderr:stdout).write(text);
    }
    if(emitGo) { await writeFile(emitGo,source,'utf8');report.write(`Go source: ${emitGo}\n`); }
    if(emitCpp) { await writeFile(emitCpp,cpp,'utf8');report.write(`C++ source: ${emitCpp}\n`); }
    if(build) {
      const temp=await mkdtemp(join(dirname(build),'.nyanco-build-'));
      try {
        const goFile=join(temp,'main.go'),binary=join(temp,'program.exe');
        await writeFile(goFile,source,'utf8');
        const result=spawnSync('go',['build','-trimpath','-o',binary,goFile],{encoding:'utf8',timeout:120000,windowsHide:true,env:{...process.env,CGO_ENABLED:'0',GOTOOLCHAIN:'local',GOWORK:'off',GO111MODULE:'off'}});
        if(result.error)throw new Error(`Go build failed: ${result.error.message}. Install Go and ensure go is on PATH.`);
        if(result.status!==0)throw new Error(`Go build failed:\n${result.stderr || result.stdout}`);
        // Windows scanners may briefly hold freshly linked executables open.
        for(let attempt=0;;attempt++) {
          try { await rename(binary,build);break; }
          catch(error) {
            if(!['EPERM','EBUSY','EACCES'].includes(error.code))throw error;
            if(attempt>=4) { await copyFile(binary,build);break; }
            await delay(200);
          }
        }
        report.write(`Native executable: ${build}\n`);
      } finally { await rm(temp,{recursive:true,force:true,maxRetries:10,retryDelay:200}); }
    }
    if(procon&&!emitCpp)stdout.write(cpp);
    return;
  }
  const stack = vm.evaluate(expression ?? 'main');
  if (showStack || expression !== undefined) stdout.write(format(stack) + '\n');
}

main().catch(error => { process.stderr.write(`Error: ${error.message}\n`); process.exitCode = 1; });
