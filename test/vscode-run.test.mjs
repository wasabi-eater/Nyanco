import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
const {registerRun}=createRequire(import.meta.url)('../editors/vscode/run.cjs');

function setup(doc,settings={},target) {
  let command,task,error;
  const vscode={
    commands:{registerCommand:(id,fn)=>{assert.equal(id,'nyanco.runFile');command=fn;return {dispose(){}};}},
    window:{activeTextEditor:{document:doc},showErrorMessage:async text=>{error=text;}},
    Uri:{parse:uri=>uri},
    workspace:{openTextDocument:async uri=>{assert.equal(uri,target.uri.toString());return target;},getConfiguration:()=>({get:key=>settings[key]}),getWorkspaceFolder:()=>undefined},
    TaskScope:{Global:1},TaskRevealKind:{Always:1},
    ProcessExecution:class{constructor(command,args,options){Object.assign(this,{command,args,options});}},
    Task:class{constructor(definition,scope,name,source,execution){Object.assign(this,{definition,scope,name,source,execution});}},
    tasks:{executeTask:async value=>{task=value;}}
  };
  registerRun(vscode,{extensionPath:new URL('../editors/vscode',import.meta.url).pathname,subscriptions:[]});
  return {run:uri=>command(uri),get task(){return task;},get error(){return error;}};
}
test('VS Code run saves before launching CLI with separate arguments and an interactive terminal',async()=>{
  let saved=false;
  const file=new URL('../examples/typed.nyan',import.meta.url);
  const {fileURLToPath}=await import('node:url');
  const cli=fileURLToPath(new URL('../cli.mjs',import.meta.url));
  const doc={languageId:'nyanco',isDirty:true,uri:{scheme:'file'},fileName:fileURLToPath(file),save:async()=>{saved=true;return true;}};
  const state=setup(doc,{nodePath:process.execPath,cliPath:cli});await state.run();
  assert.ok(saved);assert.deepEqual(state.task.execution.args,[cli,doc.fileName]);
  assert.equal(state.task.presentationOptions.focus,true);
  const result=spawnSync(state.task.execution.command,[state.task.execution.args[0],'--single-file',state.task.execution.args[1]],{cwd:state.task.execution.options.cwd,encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,result.stderr);assert.ok(result.stdout.length>0);
});
test('Run CodeLens launches the selected file outside the active editor',async()=>{
  const uri='file:///other/entry.nyan',fileName='C:/other/entry.nyan';
  let saved=false;
  const target={languageId:'nyanco',uri:{scheme:'file',toString:()=>uri},fileName,isDirty:true,save:async()=>{saved=true;return true;}};
  const state=setup({uri:{toString:()=> 'file:///active.nyan'}},{},target);
  await state.run(uri);
  assert.ok(saved);
  assert.equal(state.task.execution.args[1],fileName);
  assert.equal(state.task.execution.options.cwd,undefined);
});
test('VS Code run respects cancelled save, non-file buffers, and paths containing shell characters',async()=>{
  const doc={languageId:'nyanco',isUntitled:true,save:async()=>false};
  const cancelled=setup(doc);await cancelled.run();assert.equal(cancelled.task,undefined);
  const remote=setup({languageId:'nyanco',uri:{scheme:'other'}});await remote.run();assert.match(remote.error,/locally/);
  const file='C:/a folder/$file.nyan';
  const state=setup({languageId:'nyanco',uri:{scheme:'file'},fileName:file},{serverPath:'C:/nyanco/lsp.mjs'});
  await state.run();assert.equal(state.task.execution.args[1],file);
  assert.match(state.task.execution.args[0],/cli\.mjs$/);
});
