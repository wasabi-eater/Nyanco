import {copyFile, mkdir, readFile, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {posix} from 'node:path';
import {fileURLToPath} from 'node:url';

const project = new URL('../',import.meta.url);
const output = new URL('./dist/',import.meta.url);
const runtime = new URL('./runtime/',output);
const assets = ['index.html','icon.svg','style.css','app.mjs','lessons.mjs','execute.mjs','worker.mjs'];
const sources = new URL('src/',project);
const modules = new Set(['frontend/language.mjs','frontend/modules.mjs','tooling/syntax-highlight.mjs']);
const runtimeFiles = new Set(['browser-platform.mjs','prelude-source.mjs']);
await mkdir(runtime,{recursive:true});
for (const name of assets) await copyFile(new URL(name,import.meta.url),new URL(name,output));
await copyFile(new URL('./browser-platform.mjs',import.meta.url),new URL('browser-platform.mjs',runtime));
const prelude = await readFile(new URL('std/prelude.nyan',project),'utf8');
await writeFile(new URL('prelude-source.mjs',runtime),'export const preludeSource = '+JSON.stringify(prelude)+';');

for (const module of modules) {
  const name = posix.basename(module);
  if (runtimeFiles.has(name)) throw new Error('Duplicate module name in the tour: '+name);
  runtimeFiles.add(name);
  let content = module === 'runtime/io-input.mjs'
    ? "export function readLine() { throw new Error('Browser input requires a supplied reader'); }\n"
    : await readFile(new URL(module,sources),'utf8');
  // Keep the browser's runtime directory flat while resolving imports against src/.
  content = content.replace(/(\bfrom\s*['"])(\.\.?\/[\w./-]+\.mjs)(['"])/g,(_,start,specifier,end)=>{
    const dependency = posix.join(posix.dirname(module),specifier);
    if (dependency.startsWith('../')) throw new Error('Tour dependency outside src/: '+dependency);
    modules.add(dependency);
    return start+'./'+posix.basename(dependency)+end;
  });
  if (module === 'frontend/modules.mjs' || module === 'frontend/std-modules.mjs') {
    content = content.replace(/from 'node:(?:fs|path|url|crypto)'/g,"from './browser-platform.mjs'");
    content = content.replace("process.platform==='win32'","false");
  }
  if (/\bfrom\s*['"]node:/.test(content)) throw new Error('Node-only dependency in the tour: '+module);
  await writeFile(new URL(name,runtime),content);
}
console.log('Tour built: '+fileURLToPath(output));

if(process.argv.includes('--serve')) {
  const files=new Set([...assets,...[...runtimeFiles].map(name=>'runtime/'+name)]);
  const mime={html:'text/html',svg:'image/svg+xml',css:'text/css',mjs:'text/javascript'};
  createServer(async (request,response) => {
    const name=new URL(request.url,'http://localhost').pathname.slice(1)||'index.html';
    if(!files.has(name)){response.writeHead(404).end();return;}
    const body=await readFile(new URL(name,output)).catch(()=>null);
    if(!body){response.writeHead(404).end();return;}
    response.writeHead(200,{'Content-Type':mime[name.split('.').at(-1)]+'; charset=utf-8','Cache-Control':'no-cache'});
    response.end(body);
  }).listen(Number(process.env.NYANCO_TOUR_PORT || 4173),'127.0.0.1',function(){
    console.log('http://127.0.0.1:'+this.address().port+'/');
  });
}
