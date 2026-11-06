import {copyFile, mkdir, readFile, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';

const project = new URL('../',import.meta.url);
const output = new URL('./dist/',import.meta.url);
const runtime = new URL('./runtime/',output);
const assets = ['index.html','icon.svg','style.css','app.mjs','lessons.mjs','execute.mjs','worker.mjs'];
const modules = new Set(['language.mjs','syntax-highlight.mjs','modules.mjs','browser-platform.mjs','prelude-source.mjs']);
await mkdir(runtime,{recursive:true});
for (const name of assets) await copyFile(new URL(name,import.meta.url),new URL(name,output));
for (const name of modules) {
  let content = name === 'io-input.mjs'
    ? "export function readLine() { throw new Error('Browser input requires a supplied reader'); }\n"
    : name === 'browser-platform.mjs' ? await readFile(new URL(name,import.meta.url),'utf8')
    : name === 'prelude-source.mjs' ? 'export const preludeSource = '+JSON.stringify(await readFile(new URL('std/prelude.nyan',project),'utf8'))+';'
    : await readFile(new URL(name,project),'utf8');
  if (name === 'modules.mjs' || name === 'std-modules.mjs') {
    content = content.replace(/from 'node:(?:fs|path|url|crypto)'/g,"from './browser-platform.mjs'");
    content = content.replace("process.platform==='win32'","false");
  }
  for (const [,dependency] of content.matchAll(/\bfrom\s*['"]\.\/([\w-]+\.mjs)['"]/g)) modules.add(dependency);
  if (/\bfrom\s*['"]node:/.test(content)) throw new Error('Node-only dependency in the tour: '+name);
  await writeFile(new URL(name,runtime),content);
}
console.log('Tour built: '+fileURLToPath(output));

if(process.argv.includes('--serve')) {
  const files=new Set([...assets,...[...modules].map(name=>'runtime/'+name)]);
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
