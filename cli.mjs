#!/usr/bin/env node
import { readFile, writeFile, mkdtemp, rename, copyFile, rm } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { transpileGo } from './go-backend.mjs';
import {createReplInterface,highlight} from './repl-highlight.mjs';
import { stdin, stdout } from 'node:process';
import { VM, compile, format, builtinNames, lex, parseExpression, formatWarning } from './language.mjs';
import { checkExpression } from './types.mjs';

const help = `Nyanco 0.72.1 — statically typed stack language
Usage:
  nyanco                       Interactive REPL
  nyanco program.nyan           Execute main
  nyanco program.nyan --stack   Execute main and show final stack
  nyanco --eval "2 + 3"         Evaluate and show final stack
  nyanco program.nyan --eval "factorial 5"
  nyanco --check program.nyan   Check syntax and types (no execution)
  nyanco --types program.nyan   Show inferred function stack effects
  nyanco --type "dup"          Infer an expression without executing it
  nyanco program.nyan --emit-go main.go   Transpile to standalone Go
  nyanco program.nyan --build program.exe Build a native executable
  nyanco --lsp                 Start Language Server (stdio)
  nyanco --help
REPL: :help, :quit, :stack, :clear, :words, :type EXPR, :load PATH, :{ ... :}
`;

async function repl() {
  const isDefinition=source=>{
    let depth=0;
    return lex(source).some(t=>{
      const found=!depth && t.kind==='word' && ['=',':','class','instance','effect'].includes(t.value);
      if(['(','[','{'].includes(t.kind))depth++;
      if([')',']','}'].includes(t.kind))depth--;
      return found;
    });
  };
  const rl = createReplInterface({input:stdin,output:stdout});
  const color=Boolean(stdin.isTTY&&stdout.isTTY)&&!('NO_COLOR' in process.env)&&process.env.TERM!=='dumb';
  const lines = rl[Symbol.asyncIterator]();
  const vm = new VM({input:async()=>{const line=await lines.next();return line.done?'':line.value;}}); let stack = [], block = null;
  const install = async (source, file) => {
    const previous = vm.definitions;
    const program = compile(source, file, previous, {globals: vm.globals});
    for(const warning of program.warnings||[])process.stderr.write(formatWarning(warning)+'\n');
    vm.definitions = program.definitions;
    try { await vm.executeAsync([]); } catch (error) { vm.definitions = previous; throw error; }
  };
  stdout.write('Nyanco 0.72.1 — static types; :type EXPR for inference\n');
  rl.setPrompt('nyanco> '); if (stdin.isTTY) rl.prompt();
  for await (const line of lines) {
    const input = line.trim();
    try {
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
      else if (input === ':words') stdout.write([...new Set([...builtinNames(), ...(vm.definitions.effects?.keys()||[]), ...(vm.definitions.constructors?.keys() || []), ...(vm.definitions.methods?.keys() || []), ...[...vm.definitions.keys()].filter(n=>!n.startsWith('__tc_')), ...vm.globals.keys()])].join(' ') + '\n');
      else if (input.startsWith(':load ')) {
        const path = input.slice(6).trim();
        await install(await readFile(path, 'utf8'), path);
        stdout.write(`Loaded ${path}\n`);
      } else if (input.startsWith(':')) throw new Error(`Unknown REPL command: ${input}`);
      else if (isDefinition(input)) {
        await install(input, '<repl>');
        stdout.write('Defined.\n');
      } else if (input) {
        const next = [...stack]; await vm.evaluateAsync(line, next, '<repl>'); stack = next;
        stdout.write(format(stack) + '\n');
      }
    } catch (error) { stdout.write(`Error: ${error.message}\n`); }
    rl.setPrompt(block === null ? 'nyanco> ' : '...> '); if (stdin.isTTY && !rl.closed) rl.prompt();
  }
  if (block !== null) stdout.write('Error: unfinished definition block (expected :})\n');
  rl.close();
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length) return repl();
  if (args.length === 1 && args[0] === '--lsp') { const {startServer}=await import('./lsp.mjs'); startServer(); return; }
  let file, expression, typeExpression, emitGo, build, check = false, showStack = false, showTypes = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') { stdout.write(help); return; }
    if (arg === '--eval' || arg === '-e') {
      if (expression !== undefined || args[i + 1] === undefined) throw new Error('--eval requires exactly one expression');
      expression = args[++i];
    } else if (arg === '--type') {
      if(typeExpression !== undefined || args[i+1] === undefined) throw new Error('--type requires one expression');
      typeExpression=args[++i];
    } else if (arg === '--emit-go' || arg === '--build') {
      const path=args[++i];
      if(!path || path.startsWith('-') || (arg==='--emit-go' ? emitGo : build))throw new Error(`${arg} requires one output path`);
      if(arg==='--emit-go')emitGo=resolve(path);else build=resolve(path);
    } else if (arg === '--types') showTypes = true;
    else if (arg === '--check') check = true;
    else if (arg === '--stack') showStack = true;
    else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else if (!file) file = arg;
    else throw new Error('Only one source file is supported');
  }
  if (check && (!file || expression !== undefined)) throw new Error('--check requires a file and cannot be combined with --eval');
  if(typeExpression !== undefined && (check || expression !== undefined || showTypes || showStack)) throw new Error('--type cannot be combined with execution or other check options');
  if(showTypes && (!file || expression !== undefined)) throw new Error('--types requires a file and cannot be combined with --eval');
  if((emitGo || build) && (check || showTypes || typeExpression!==undefined))throw new Error('Go output cannot be combined with --check, --types or --type');
  if((emitGo && emitGo===build) || (file && [emitGo,build].includes(resolve(file))))throw new Error('Input, Go source and executable paths must be different');
  if (!file && expression === undefined && typeExpression === undefined) throw new Error('Specify a file, --eval or --type');
  const program = file ? compile(await readFile(file, 'utf8'), file) : { definitions: new Map() };
  const vm = new VM(program);
  if (typeExpression !== undefined) {stdout.write(vm.infer(typeExpression) + '\n');return;}
  if (showTypes) {for(const [name,type] of program.types)stdout.write(`${name} : ${type}\n`);return;}
  if (check) {
    // A file with main is also checked as an executable starting with no values.
    if(program.definitions.has('main')) {
      checkExpression(parseExpression('main'),program.definitions);
    }
    stdout.write(`Types OK: ${file}\n`); return;
  }
  if (expression === undefined && !program.definitions.has('main')) throw new Error('Program has no main definition');
  if(emitGo || build) {
    if(expression!==undefined)vm.infer(expression);
    const source=transpileGo(program,{expression:expression ?? 'main',showStack:showStack || expression!==undefined});
    if(emitGo) { await writeFile(emitGo,source,'utf8');stdout.write(`Go source: ${emitGo}\n`); }
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
        stdout.write(`Native executable: ${build}\n`);
      } finally { await rm(temp,{recursive:true,force:true,maxRetries:10,retryDelay:200}); }
    }
    return;
  }
  const stack = vm.evaluate(expression ?? 'main');
  if (showStack || expression !== undefined) stdout.write(format(stack) + '\n');
}

main().catch(error => { process.stderr.write(`Error: ${error.message}\n`); process.exitCode = 1; });
