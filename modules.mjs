import {readFileSync,readdirSync,realpathSync,statSync,existsSync} from 'node:fs';
import {resolve,dirname,basename,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {compile,lex,recordShorthands,leftDeclarationAt,declarationGroups,LanguageError} from './language.mjs';

const space=kind=>['data','type','class'].includes(kind)?'type':kind==='effect'?'both':'value';
const identifier=/^[a-zA-Z_][a-zA-Z0-9_']*$/;
const reserved=/^nyancoModule[0-9a-f]+_/i;
const fail=(message,t)=>{throw new LanguageError(message,t);};
const key=file=>process.platform==='win32'?resolve(file).toLowerCase():resolve(file);
const pathOf=file=>file.startsWith('file:')?fileURLToPath(file):resolve(file);

// A renamed import still refers to the type named after the directory itself.
export function moduleTypeSymbol(imp){
 const symbol=imp.module.exports.get(basename(imp.module.dir));
 return symbol?.access.has('type')&&(symbol.kinds.has('data')||symbol.kinds.has('type'))?symbol:null;
}
function typePosition(group,index){
 const first=group[0]?.value,where=group.findIndex(t=>t.value==='where');
 if(group[1]?.value===':'||['data','type','class','effect'].includes(first))return true;
 if(first!=='instance')return false;
 if(index<where)return true;
 const indent=group[where+1]?.col;let member=where+1,depth=0;
 for(let i=where+1;i<=index;i++){const t=group[i];if(!depth&&t.col===indent)member=i;if(['(','[','{'].includes(t.kind))depth++;if([')',']','}'].includes(t.kind))depth--;}
 return group[member+1]?.value===':';
}

// Modules are linked as one checked program. Each dependency's declarations get
// unique identifiers before parsing, so private helpers retain lexical access
// without becoming names that an importing source can resolve.
export function compileModule(entry,{overlays=new Map(),previous=new Map(),globals=new Map(),checkTypes=true,uriFiles=false}={}){
  entry=pathOf(entry);const rootDir=statDirectory(entry)?entry:dirname(entry);
  const edits=new Map([...overlays].map(([file,text])=>[key(pathOf(file)),text]));
  if(!statDirectory(entry)&&!existsSync(entry)&&!edits.has(key(entry)))throw new Error('Source file does not exist: '+entry);
  const modules=new Map(),ordered=[],loading=[],references=[],sources=new Map(),names=new Map();
  const fileName=file=>uriFiles?pathToFileURL(file).href:file;
  const read=file=>edits.get(key(file))??readFileSync(file,'utf8');
  const canonical=dir=>{try{return realpathSync(dir);}catch{throw new Error('Module directory does not exist: '+dir);}};
  function load(dir,from){
    dir=canonical(dir);if(!statDirectory(dir))fail('Import requires a directory: '+dir,from);const id=key(dir);
    if(loading.includes(id))fail('Cyclic module import: '+[...loading,id].map(p=>basename(p)).join(' -> '),from);
    if(modules.has(id))return modules.get(id);
    const prefix=id===key(canonical(rootDir))?'':'nyancoModule'+createHash('sha256').update(id).digest('hex').slice(0,12)+'_';
    const mod={id,dir,prefix,files:[],symbols:new Map(),exports:new Map()};modules.set(id,mod);loading.push(id);
    const files=new Set(readdirSync(dir,{withFileTypes:true}).filter(e=>e.isFile()&&e.name.endsWith('.nyan')).map(e=>join(dir,e.name)));
    for(const file of overlays.keys()){const p=pathOf(file);if(key(dirname(p))===id&&p.endsWith('.nyan'))files.add(p);}
    if(!files.size)fail('Module has no .nyan source files: '+dir,from);
    for(const file of [...files].sort()){
      const text=read(file),tokens=recordShorthands(lex(text,fileName(file)));sources.set(fileName(file),text);
      for(const t of tokens)if(t.kind==='word'&&reserved.test(t.value))fail('Reserved module identifier',t);
      const unit={file,groups:[],imports:new Map()};mod.files.push(unit);
      for(let group of declarationGroups(tokens)){
        let visibility='private';if(['pub','open'].includes(group[0]?.value)){visibility=group[0].value;group=group.slice(1);if(!group.length)fail('Visibility requires a declaration',tokens[0]);group[0]={...group[0],declarationStart:true,declarationCol:1,visibility};}
        const first=group[0];
        if(first?.value==='import'){
          if(visibility!=='private')fail('Imports cannot have a visibility modifier',first);
          const path=group[1],alias=group[2]?.value==='as'?group[3]:null;
          if(path?.kind!=='literal'||typeof path.value!=='string'||![2,4].includes(group.length)||group.length===4&&!alias)fail('Expected import "directory" [as name]',first);
          const name=alias?.value||basename(resolve(dir,path.value));
          if(!/^[a-z][A-Za-z0-9_]*$/.test(name)||unit.imports.has(name))fail('Invalid or duplicate module alias: '+name,alias||path);
          unit.imports.set(name,{path:resolve(dir,path.value),token:alias||path});continue;
        }
        unit.groups.push(group);collect(mod,group,visibility);
      }
    }
    for(const symbol of mod.symbols.values())if(symbol.visibility!=='private')mod.exports.set(symbol.name,symbol);
    for(const unit of mod.files)for(const [alias,imp] of unit.imports){if(mod.symbols.has(alias))fail('Module alias conflicts with declaration: '+alias,imp.token);imp.module=load(imp.path,imp.token);}
    loading.pop();ordered.push(mod);return mod;
  }
  function declare(mod,token,kind,visibility='private'){
    if(!token||!identifier.test(token.value))fail('Expected a declaration name',token);
    const name=token.value,prior=mod.symbols.get(name);
    if(prior){prior.declarations.push(token);if(!prior.kinds.has(kind)&&[...prior.kinds].some(k=>space(k)===space(kind)))fail('Duplicate module declaration: '+name,token);prior.kinds.add(kind);for(const ns of space(kind)==='both'?['type','value']:[space(kind)])if(visibility!=='private'){const old=prior.access.get(ns);if(old&&old!==visibility)fail('Conflicting visibility: '+name,token);prior.access.set(ns,visibility);prior.visibility=visibility;}return prior;}
    const internal=mod.prefix?(/^[A-Z]/.test(name)?'N'+mod.prefix.slice(1):mod.prefix)+name:name;
    const access=new Map(visibility==='private'?[]:(space(kind)==='both'?['type','value']:[space(kind)]).map(ns=>[ns,visibility]));
    const symbol={name,internal,kind,declarations:[token],kinds:new Set([kind]),access,visibility,token,module:mod};mod.symbols.set(name,symbol);names.set(internal,name);return symbol;
  }
  function collect(mod,group,visibility){
    const first=group[0],kind=first.value;
    if(['data','type'].includes(kind)){
      declare(mod,group[1],kind,visibility);
      if(kind==='data'){let depth=0,next=true;const eq=group.findIndex(t=>t.value==='=');for(const t of group.slice(eq+1)){if(!depth&&t.value==='deriving')break;if(!depth&&t.value==='|'){next=true;continue;}if(next){declare(mod,t,'constructor',visibility==='open'?'open':'private');next=false;}if(['(','[','{'].includes(t.kind))depth++;if([')',']','}'].includes(t.kind))depth--;}}
      return;
    }
    if(kind==='class'||kind==='effect'){
      const header=group.filter(t=>t.line===first.line),arrow=header.findIndex(t=>t.value==='=>'),own=kind==='class'&&arrow>=0?arrow+1:1;
      declare(mod,header[own],kind,visibility);
      if(header.at(-1)?.value==='where'){
        const body=group.slice(header.length),indent=body[0]?.col;
        for(let i=0;i<body.length;i++)if(body[i].col===indent&&body[i].value!=='type'){
          const member=body[i].kind==='('?body[i+1]:body[i];
          if(identifier.test(member?.value))declare(mod,member,kind==='class'?'method':'operation',visibility);
        }
      }
      return;
    }
    if(kind==='instance'){if(visibility!=='private')fail('Instance visibility follows its class and types',first);return;}
    if(group[1]?.value===':'||group.some(t=>t.value==='='&&!['with'].includes(first.value))&&identifier.test(first.value)){
      // A top-level update is an initializer, not a function declaration.
      if(!group.some(t=>t.value==='with')||group.findIndex(t=>t.value==='=')<group.findIndex(t=>t.value==='with')){declare(mod,first,'function',visibility);return;}
    }
    const declaration=leftDeclarationAt(group,0);
    if(declaration>=0){if(visibility!=='private')fail('Visibility requires a function, type, class, or effect declaration',first);for(const [i,t] of group.slice(0,declaration).entries())if(t.kind==='word'&&identifier.test(t.value)&&!['mut','_'].includes(t.value)&&!/^[A-Z]/.test(t.value)&&group[i+1]?.value!==':')declare(mod,t,'variable');return;}
    if(visibility!=='private')fail('Visibility requires a function, type, class, or effect declaration',first);
    let depth=0,binding=false;
    for(const [i,t] of group.entries()){if(!depth&&t.value==='->'){binding=true;continue;}if(!depth&&[';',','].includes(t.kind))binding=false;if(binding&&group[i+1]?.value!==':'&&t.kind==='word'&&identifier.test(t.value)&&!['mut','_'].includes(t.value)&&!/^[A-Z]/.test(t.value))declare(mod,t,'variable');if(['(','[','{'].includes(t.kind))depth++;if([')',']','}'].includes(t.kind))depth--;}
  }
  const root=load(rootDir),tokens=[];
  function rewrite(group,mod,unit){
    group=recordShorthands(group);
    const fields=new Set();
    // Record labels and the first component of an update path are not names.
    for(let i=0,depth=0;i<group.length;i++){const t=group[i];if(group[i+1]?.value===':'){const symbol=mod.symbols.get(t.value);if(depth||i!==0&&!symbol?.declarations.some(d=>d.file===t.file&&d.line===t.line&&d.col===t.col))fields.add(t);}if(['(','[','{'].includes(t.kind))depth++;if([')',']','}'].includes(t.kind))depth--;}
    for(let i=0;i<group.length;i++)if(group[i].value==='with'){
      let j=i+1,braced=group[j]?.kind==='{',depth=0,path=true;if(braced)j++;
      for(;j<group.length;j++){const t=group[j];if(!depth&&['=','!','??='].includes(t.value))path=false;if(path&&!depth&&t.kind==='word'&&identifier.test(t.value))fields.add(t);if(['(','[','{'].includes(t.kind))depth++;if([')',']','}'].includes(t.kind)){if(!depth)break;depth--;}if(!depth&&braced&&[',',';'].includes(t.kind))path=true;if(!braced&&!depth&&[',',';'].includes(t.kind))break;}
    }
    const out=[];
    for(let i=0;i<group.length;i++){
      const original=group[i],t={...original,moduleID:mod.id};
      if(t.kind==='word'&&reserved.test(t.value))fail('Reserved module identifier',t);
      if(t.parts)t.parts=t.parts.map(part=>rewrite(part,mod,unit));
      if(group[i-1]?.value==='..'&&typePosition(group,i)){references.push(t);out.push(t);continue;}
      const imp=!fields.has(original)&&unit.imports.get(t.value),member=group[i+1];
      if(imp&&member?.kind==='word'&&/^\.[A-Za-z_]/.test(member.value)){
        if(i===0&&(group[2]?.value===':'||group.some(t=>t.value==='=')&&!group.some(t=>t.value==='with')))fail('Cannot declare an imported name',t);
        const name=member.value.slice(1),symbol=imp.module.exports.get(name);
        const typeContext=typePosition(group,i);
        const ns=/^[A-Z]/.test(name)?'value':typeContext?'type':'value';
        if(!symbol||!symbol.access.has(ns))fail('Module '+t.value+' does not export '+name+' in the '+ns+' namespace',member);
        const ref={...t,value:symbol.internal,endLine:member.endLine,endCol:member.endCol,sourceName:t.value+'.'+name};references.push(ref);out.push(ref);i++;continue;
      }
      if(imp){
        const symbol=typePosition(group,i)&&moduleTypeSymbol(imp);
        if(!symbol)fail('Module alias requires a qualified member or an exported same-named type: '+t.value,t);
        const ref={...t,value:symbol.internal,sourceName:t.value};references.push(ref);out.push(ref);continue;
      }
      if(t.kind==='word'&&!fields.has(original)&&mod.symbols.has(t.value)){t.sourceName=t.value;t.value=mod.symbols.get(t.value).internal;}
      references.push(t);out.push(t);
    }
    return out;
  }
  for(const mod of ordered)for(const unit of mod.files)for(const group of unit.groups)tokens.push(...rewrite(group,mod,unit));
  const rootUnit=root.files.find(u=>key(u.file)===key(entry))||root.files.find(u=>basename(u.file)==='main.nyan')||root.files[0];
  const moduleTokens=(source,file='<eval>')=>rewrite(recordShorthands(lex(source,file)),root,rootUnit);
  for(const mod of ordered)if(mod!==root)for(const symbol of mod.symbols.values())names.set(symbol.internal,basename(mod.dir)+'.'+symbol.name);
  for(const unit of root.files)for(const [alias,imp] of unit.imports)for(const symbol of imp.module.symbols.values())names.set(symbol.internal,symbol===moduleTypeSymbol(imp)?alias:alias+'.'+symbol.name);
  const display=text=>String(text).replace(/\b(?:nyancoModule|NyancoModule)[0-9a-f]+_[A-Za-z0-9_']+/g,n=>names.get(n)||n);
  const moduleEffects=new Map(ordered.map(mod=>[mod.id,new Map([...mod.symbols.values()].filter(s=>s.kinds.has('effect')||s.kinds.has('operation')).map(s=>[s.name,s.internal]))]));
  let program;try{program=compile('',fileName(entry),previous,{tokens,globals,checkTypes,moduleEffects});}catch(error){error.message=display(error.message);throw error;}
  program.definitions.moduleTokens=moduleTokens;program.definitions.moduleDisplay=display;program.definitions.modulePublicNames=[...rootUnit.imports].flatMap(([alias,imp])=>[...(moduleTypeSymbol(imp)?[alias]:[]),...[...imp.module.exports.keys()].map(name=>alias+'.'+name)]);
  program.modules={root,ordered,references,sources,names,display};program.types=new Map([...program.types].map(([name,type])=>[name,display(type)]));
  return program;
}
function statDirectory(path){try{return statSync(path).isDirectory();}catch{return false;}}
