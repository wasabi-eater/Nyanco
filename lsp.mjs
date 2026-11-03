#!/usr/bin/env node
import {pathToFileURL,fileURLToPath} from 'node:url';
import {existsSync,realpathSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {compileModule,moduleTypeSymbol,standardTokens} from './modules.mjs';
import {standardModule,standardModuleNames} from './std-modules.mjs';
import {syntaxSource} from './class-relations.mjs';
import {compile, lex, builtinNames, parseExpression} from './language.mjs';
import {inferExpression,occurrenceTypes} from './types.mjs';
import {patternNames} from './type-syntax.mjs';

// VS Code and the module loader can spell the same file URI differently
// (drive-letter case, percent encoding, or a symlink resolved by the loader).
const sourceIDs=new Map();
function sourceID(file){
 if(!file)return null;if(sourceIDs.has(file))return sourceIDs.get(file);
 let id=file;
 try{const path=file.startsWith('file:')?fileURLToPath(file):file.startsWith('<')?null:resolve(file);if(path){try{id=realpathSync.native(path);}catch{id=path;}if(process.platform==='win32')id=id.toLowerCase();}}catch{}
 sourceIDs.set(file,id);return id;
}
const sameSource=(a,b)=>!!a&&!!b&&(a===b||sourceID(a)===sourceID(b));

const keywords=['import','as','pub','open','type','case','otherwise','data','deriving','class','instance','where','effect','mut','with','handle','mask'];
const position=(line=1,col=1)=>({line:Math.max(0,line-1),character:Math.max(0,col-1)});
const range=t=>({start:position(t.line,t.col),end:position(t.endLine??t.line,t.endCol??((t.col||1)+Math.max(1,String(t.value??'').length)))});
const offset=(text,p)=>{
  let i=0;for(let line=0;line<p.line;line++){const n=text.indexOf('\n',i);if(n<0)return text.length;i=n+1;}
  const end=text.indexOf('\n',i),limit=end<0?text.length:end;
  return Math.min(i+p.character,limit);
};
export function applyChanges(text,changes){
  for(const change of changes)text=change.range?text.slice(0,offset(text,change.range.start))+change.text+text.slice(offset(text,change.range.end)):change.text;
  return text;
}
const contains=(r,p)=>offsetCompare(r.start,p)<=0&&offsetCompare(p,r.end)<0;
const offsetCompare=(a,b)=>a.line-b.line||a.character-b.character;

// The server never instantiates a VM: even top-level initializers are only checked.
export class LanguageService {
  constructor(){this.documents=new Map();this.standard=compile('','<lsp-builtins>');this.builtinTypes=new Map();}
  update(uri,text,version,refresh=true){
    sourceIDs.clear();
    const doc={uri,text,version,tokens:[],diagnostics:[],externalDiagnostics:new Map(),symbols:[],program:null};
    try{doc.tokens=lex(text,uri);}catch{} // Incomplete syntax must not kill the editor session.
    const overlays=new Map([...this.documents].map(([u,d])=>[u,d.text]));overlays.set(uri,text);
    const modular=(()=>{try{return uri.startsWith('file:')&&existsSync(dirname(fileURLToPath(uri)));}catch{return false;}})();
    const build=checkTypes=>{const previous=new Map();previous.moduleTokens=standardTokens;return modular?compileModule(uri,{overlays,uriFiles:true,checkTypes}):compile(text,uri,previous,{checkTypes});};
    try{
      doc.program=build(true);
      doc.diagnostics=(doc.program.warnings||[]).filter(w=>sameSource(w.file,uri)).map(w=>({range:range(w),severity:2,code:w.code,source:'nyanco',message:w.message}));
    }catch(error){
      const token=error.token||{line:1,col:1,value:''},diagnostic={range:range(token),severity:1,source:'nyanco',message:error.message};
      if(token.file&&!sameSource(token.file,uri)&&!token.file.startsWith('<')){
        const target=token.file.startsWith('file:')?token.file:pathToFileURL(resolve(token.file)).href;
        doc.externalDiagnostics.set(target,[diagnostic]);
      }else doc.diagnostics=[diagnostic];
      try{doc.program=build(false);}catch{}
    }
    doc.occurrences=new Map();
    if(doc.program&&!doc.externalDiagnostics.size&&!doc.diagnostics.some(d=>d.severity===1)){
      try{const source=[...doc.program.modules?.sources.keys()||[]].find(file=>sameSource(file,uri))||uri;doc.occurrences=occurrenceTypes(doc.program.definitions,source);}catch{}
    }
    const definitions=doc.program?.definitions;
    if(definitions)for(const [name,clauses] of definitions){
      const own=clauses.filter(c=>sameSource(c.token?.file,uri)&&!c.token.internal);
      if(!own.length||name.startsWith('__tc_'))continue;
      const first=own[0].token,last=own.at(-1),nodes=[...(last.guard||[]),...last.body];
      let end=range(last.token).end;
      const visit=n=>{if(!n||typeof n!=='object')return;if(sameSource(n.file,uri)&&n.endLine&&offsetCompare(end,range(n).end)<0)end=range(n).end;
        for(const v of Object.values(n))if(Array.isArray(v))v.forEach(visit);};nodes.forEach(visit);
      doc.symbols.push({name,kind:12,range:{start:range(first).start,end},selectionRange:range(first),detail:doc.program.types.get(name)});
    }
    this.documents.set(uri,doc);if(refresh)for(const other of [...this.documents.values()])if(other.uri!==uri)this.update(other.uri,other.text,other.version,false);return doc;
  }
  token(doc,p){const ref=doc.program?.modules?.references.find(t=>sameSource(t.file,doc.uri)&&t.sourceName&&contains(range(t),p));if(ref)return ref;return doc.tokens.find(t=>t.kind==='word'&&contains(range(t),p));}
  // Abstain on local names rather than jumping to an unrelated top-level function.
  local(doc,token){
    const symbol=doc.symbols.find(s=>contains(s.range,range(token).start));
    if(!symbol)return false;
    const names=new Set();
    const visit=n=>{if(!n||typeof n!=='object')return;
      if(n.patterns)patternNames(n.patterns).forEach(x=>names.add(x));
      if(n.kind==='bind')for(const name of n.names||[])names.add(name);
      if(n.kind==='local-function')names.add(n.name);
      for(const v of Object.values(n))if(Array.isArray(v))v.forEach(visit);
    };
    for(const c of doc.program.definitions.get(symbol.name)||[])visit(c);
    return names.has(token.value)&&!doc.symbols.some(s=>s.selectionRange.start.line===token.line-1&&s.selectionRange.start.character===token.col-1);
  }
  type(doc,name){
    if(doc.program?.types.has(name))return doc.program.types.get(name);
    const data=doc.program?.definitions.dataTypes.get(name),modules=doc.program?.modules;
    if(data){const display=modules?.display||String;if(data.alias)return display('type '+name+(data.transparent||data.moduleID===modules?.root.id?' = '+syntaxSource(data.aliasSyntax):''));return display('data '+name);}

    if(!this.builtinTypes.has(name)){
      try{this.builtinTypes.set(name,inferExpression(parseExpression(name,'<lsp>',this.standard.definitions.constructors),this.standard.definitions));}catch{this.builtinTypes.set(name,null);}
    }
    return this.builtinTypes.get(name);
  }
  request(method,params){
    const doc=this.documents.get(params?.textDocument?.uri);if(!doc)return method==='textDocument/completion'?[]:null;
    if(method==='textDocument/documentSymbol')return doc.symbols;
    if(method==='textDocument/completion'){
      const defs=doc.program?.definitions||this.standard.definitions;
      const imported=[];for(const unit of doc.program?.modules?.root.files||[])if(sameSource(unit.file,doc.uri))for(const [alias,imp] of unit.imports){if(moduleTypeSymbol(imp))imported.push(alias);for(const name of imp.module.exports.keys())imported.push(alias+'.'+name);}
      const standard=standardModuleNames().flatMap(module=>[module,...[...standardModule(module).exports.keys()].map(name=>module+'.'+name)]);
      const names=new Set([...imported,...standard,...builtinNames(),...defs.keys(),...defs.constructors.keys(),...defs.methods.keys(),...defs.effects.keys(),...keywords]);
      return [...names].filter(n=>!n.startsWith('__tc_')&&!n.startsWith('@')&&!/^nyancoModule/i.test(n)).sort().map(label=>({label,kind:keywords.includes(label)?14:3,...(doc.program?.types.has(label)?{detail:doc.program.types.get(label)}:{})}));
    }
    const token=this.token(doc,params.position);if(!token||this.local(doc,token))return null;
    if(method==='textDocument/definition'){
      const defs=doc.program?.definitions,t=defs?.get(token.value)?.[0]?.token||defs?.constructors.get(token.value)?.token||defs?.methods.get(token.value)?.token||defs?.dataTypes.get(token.value)?.token;
      return t?{uri:t.file,range:range(t)}:null;
    }
    if(method==='textDocument/hover'){
      const type=this.type(doc,token.value);
      const declaration=doc.symbols.some(s=>s.name===token.value&&s.selectionRange.start.line===token.line-1&&s.selectionRange.start.character===token.col-1);
      const actual=doc.occurrences.get(`${token.line}:${token.col}`)||(declaration?type:null);
      const substitutions=doc.occurrences.substitutions?.get(`${token.line}:${token.col}`)||[];
      const mapping=substitutions.length?'\n\n型変数の対応\n\n```nyanco\n'+substitutions.map(s=>s.variable+' = '+(doc.program?.modules?.display(s.type)||s.type)).join('\n')+'\n```':'';
      const display=doc.program?.modules?.display||String;
      const block=t=>'```nyanco\n'+(token.sourceName||token.value)+' : '+display(t)+'\n```';
      return type?{contents:{kind:'markdown',value:'定義時の型\n\n'+block(type)+(actual?'\n\nこの項の型\n\n'+block(actual):'')+mapping},range:range(token)}:null;
    }
    return null;
  }
}

export function startServer(input=process.stdin,output=process.stdout,{exit=code=>process.exit(code)}={}){
  const service=new LanguageService();let buffer=Buffer.alloc(0),initialized=false,shutdown=false;
  const send=message=>{const body=Buffer.from(JSON.stringify(message));output.write(`Content-Length: ${body.length}\r\n\r\n`);output.write(body);};
  const reply=(id,result)=>send({jsonrpc:'2.0',id,result});
  const fail=(id,code,message)=>send({jsonrpc:'2.0',id,error:{code,message}});
  const published=new Set();
  const publishAll=()=>{
    const targets=new Map(),opened=[...service.documents.values()];
    const add=(uri,diagnostics)=>{const doc=opened.find(d=>sameSource(d.uri,uri)),target=doc?.uri||uri,id=sourceID(target);if(!targets.has(id))targets.set(id,{uri:target,...(doc?{version:doc.version}:{}),diagnostics:[]});const list=targets.get(id).diagnostics;for(const diagnostic of diagnostics)if(!list.some(d=>d.message===diagnostic.message&&JSON.stringify(d.range)===JSON.stringify(diagnostic.range)))list.push(diagnostic);};
    for(const doc of opened){add(doc.uri,doc.diagnostics);for(const [uri,diagnostics] of doc.externalDiagnostics)add(uri,diagnostics);}
    const next=new Set([...targets.values()].map(t=>t.uri));
    for(const uri of published)if(!next.has(uri))send({jsonrpc:'2.0',method:'textDocument/publishDiagnostics',params:{uri,diagnostics:[]}});
    for(const params of targets.values())send({jsonrpc:'2.0',method:'textDocument/publishDiagnostics',params});
    published.clear();for(const uri of next)published.add(uri);
  };
  function dispatch(message){
    const {id,method,params={}}=message,request=id!==undefined;
    if(method==='exit'){exit(shutdown?0:1);return;}
    if(method==='initialize'&&!initialized){initialized=true;reply(id,{capabilities:{positionEncoding:'utf-16',textDocumentSync:{openClose:true,change:2},hoverProvider:true,completionProvider:{},definitionProvider:true,documentSymbolProvider:true},serverInfo:{name:'Nyanco Language Server',version:'0.81.0'}});return;}
    if(!initialized){if(request)fail(id,-32002,'Server not initialized');return;}
    if(shutdown){if(request)fail(id,-32600,'Server has shut down');return;}
    if(method==='shutdown'){shutdown=true;reply(id,null);return;}
    if(method==='workspace/didChangeWatchedFiles'){for(const doc of [...service.documents.values()])service.update(doc.uri,doc.text,doc.version,false);publishAll();return;}
    if(method==='initialized'||method==='$/cancelRequest'||method==='$/setTrace')return;
    try{
      if(method==='textDocument/didOpen'){const d=params.textDocument;service.update(d.uri,d.text,d.version);publishAll();return;}
      if(method==='textDocument/didChange'){
        const d=params.textDocument,old=service.documents.get(d.uri);if(!old||d.version<=old.version)return;
        service.update(d.uri,applyChanges(old.text,params.contentChanges),d.version);publishAll();return;
      }
      if(method==='textDocument/didClose'){const uri=params.textDocument.uri;service.documents.delete(uri);for(const doc of [...service.documents.values()])service.update(doc.uri,doc.text,doc.version,false);publishAll();return;}
      if(['textDocument/hover','textDocument/completion','textDocument/definition','textDocument/documentSymbol'].includes(method)){reply(id,service.request(method,params));return;}
      if(request)fail(id,-32601,`Method not found: ${method}`);
    }catch(error){if(request)fail(id,-32603,error.message);else send({jsonrpc:'2.0',method:'window/logMessage',params:{type:1,message:error.message}});}
  }
  input.on('data',chunk=>{
    buffer=Buffer.concat([buffer,chunk]);
    while(true){
      const end=buffer.indexOf('\r\n\r\n');if(end<0){if(buffer.length>8192){input.pause();exit(1);}return;}
      const length=/^Content-Length:\s*(\d+)\s*$/im.exec(buffer.subarray(0,end).toString('ascii'));
      if(!length||Number(length[1])>32*1024*1024){input.pause();exit(1);return;}
      const count=Number(length[1]);if(buffer.length<end+4+count)return;
      const body=buffer.subarray(end+4,end+4+count);buffer=buffer.subarray(end+4+count);
      let message;try{message=JSON.parse(body.toString('utf8'));}catch{fail(null,-32700,'Parse error');continue;}
      if(!message||Array.isArray(message)||message.jsonrpc!=='2.0'||typeof message.method!=='string'){fail(message?.id??null,-32600,'Invalid Request');continue;}
      dispatch(message);
    }
  });
  input.on('end',()=>exit(shutdown?0:1));
  return service;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)startServer();
