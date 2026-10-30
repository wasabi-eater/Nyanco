import {classConstraint} from './class-syntax.mjs';
import {lowerName,instanceKey} from './type-names.mjs';
import {typeSyntax} from './type-syntax.mjs';
import {operatorSpecs,standardOperatorClasses,primitiveOperatorClass,operatorFallback,installOperatorClasses} from './operator-classes.mjs';
// Layout-based type class declarations are expanded into ordinary checked functions.
import {LanguageError} from './language.mjs';
export function expandClasses(groups,definitions,previous,builtins,globals) {
  const classes=new Map([...previous.classes||[]].map(([n,c])=>[n,{...c,methods:new Map(c.methods),instances:new Map(c.instances)}]));
  const methods=new Map(previous.methods||[]),ordinary=[],pending=[];
  const fail=(message,t)=>{throw new LanguageError(message,t);};
  function members(tokens) {
    if(!tokens.length)return [];
    const indent=tokens[0].col,out=[];let depth=0;
    for(const t of tokens) {
      if(!depth && t.col===indent && (!out.length || t.line>out.at(-1).at(-1).line))out.push([]);
      if(!out.length || t.col<indent)fail('Invalid class/instance member indentation',t);
      out.at(-1).push(t);
      if(['(','[','{'].includes(t.kind))depth++;
      if([')',']','}'].includes(t.kind))depth--;
    }
    return out;
  }
  for(const group of groups) {
    const first=group[0];
    if(first.value!=='class' && first.value!=='instance'){ordinary.push(group);continue;}
    const header=group.filter(t=>t.line===first.line),body=group.slice(header.length);
    if(header.length<4 || header.at(-1).value!=='where' || body[0]?.col<=first.col)fail('Expected class Name \'a where or instance Name Type where with indented members',first);
    const classPostfix=false;
    let name=lowerName(header[classPostfix?2:1].value),arg=header[classPostfix?1:2].value;
    if(first.value==='instance') {
      const arrow=header.findIndex(t=>t.value==='=>'),start=arrow<0?1:arrow+1;
      const head=header.slice(start,-1).map(t=>t.value);
      const context=[];
      if(arrow>=0) {
        const text=header.slice(1,arrow).map(t=>t.value).join(' ');
        for(const part of text.split(',')){const c=classConstraint(part,n=>classes.has(n)||standardOperatorClasses.has(n)||n==='show');if(!c)fail('Invalid instance constraint',first);context.push([c.name,...c.args]);}
      }
      pending.push({head,context,body,token:first});continue;
    }
    if(header.length!==4)fail('Class requires one type parameter',first);
    if(!/^[a-z][A-Za-z0-9_]*$/.test(name) || !/^'[a-z][A-Za-z0-9_']*$/.test(arg))fail('Class requires a lowercase name and one type parameter',first);
    if(classes.has(name))fail(`Class already declared: ${name}`,first);
    const c={name,param:arg,associated:[],methods:new Map(),instances:new Map(),token:first};
    const classMembers=members(body),associatedParts=classMembers.filter(p=>p[0]?.value==='type');
    const used=new Set(body.map(t=>t.value));
    for(const part of associatedParts){
      const label=part[1]?.value;
      if(part.length!==2 || !/^[a-z][A-Za-z0-9_]*$/.test(label||''))fail('Associated type declaration requires type name',part[0]);
      if(c.associated.some(a=>a.name===label) || definitions.dataTypes.has(label) || ['int','float','byte','char','bool','string','range','stream'].includes(label))fail('Duplicate or reserved associated type: '+label,part[0]);
      let param="'associated_"+label;while(used.has(param))param+='_';used.add(param);c.associated.push({name:label,param});
    }
    for(const part of classMembers.filter(p=>p[0]?.value!=='type')) {
      // Parenthesized symbols are accepted in declarations as well as bare symbols.
      if(part[0]?.kind==='(' && part[2]?.kind===')')part.splice(0,3,part[1]);
      const [method,colon]=part;
      if(method.kind!=='word' || (!/^[a-z][A-Za-z0-9_']*$/.test(method.value) && !operatorSpecs.has(method.value)) || colon?.value!==':' || part.length<3)fail('Class member requires method : input -> output',method);
      if(methods.has(method.value) || builtins.has(method.value) && !operatorSpecs.has(method.value) || definitions.has(method.value) || globals.has(method.value) || definitions.constructors.has(method.value))fail(`Method name already used: ${method.value}`,method);
      const m={name:method.value,className:name,param:arg,signature:part.slice(2).map((t,i,ts)=>ts[i+1]?.value===':'?t.value:(c.associated.find(a=>a.name===t.value)?.param||t.value)).join(' '),token:method};
      c.methods.set(m.name,m);methods.set(m.name,m);
    }
    if(!c.methods.size)fail('Class requires at least one method',first);
    const operators=[...c.methods.values()].filter(m=>operatorSpecs.has(m.name));
    if(operators.length) {
      if(operators.length!==c.methods.size)fail('Operator classes cannot mix primitive operators and other methods',first);
      for(const m of operators) {
        m.signature=m.signature.replace(/\b(Num|Bool|String)\b/g,x=>lowerName(x));
        const expected=`${arg} ${arg} -> ${operatorSpecs.get(m.name).result==="'a"?arg:operatorSpecs.get(m.name).result}`;
        if(m.signature!==expected)fail(`Operator ${m.name} requires ${expected}`,m.token);
      }
      c.operatorClass=true;
    }
    classes.set(name,c);
  }
  function enableStandard(name,token) {
    if(!classes.has(name) && standardOperatorClasses.has(name)) {
      const c=primitiveOperatorClass(name,standardOperatorClasses.get(name),token);
      for(const [op,m] of c.methods){if(methods.has(op)&&!classes.get(methods.get(op).className)?.standard)fail(`Operator already belongs to class: ${op}`,token);methods.set(op,m);}
      classes.set(name,c);
    }
  }
  // An explicit constraint can enable an operator class without any ADT instance.
  for(const group of ordinary)if(group[1]?.value===':') {
    const arrow=group.findIndex(t=>t.value==='=>');
    if(arrow>=0)for(const t of group.slice(2,arrow))if(standardOperatorClasses.has(lowerName(t.value)))enableStandard(lowerName(t.value),t);
  }
  installOperatorClasses(classes,methods);
  for(const {head:header,context,body,token} of pending) {
    const postfix=false;
    const name=lowerName(postfix?header.at(-1):header[0]),headTokens=postfix?header.slice(0,-1):header.slice(1);
    enableStandard(name,token);
    const c=classes.get(name);if(!c)fail(`Unknown class: ${name}`,token);
    const parser=typeSyntax(headTokens,definitions.dataTypes,null,m=>fail(m,token)),heads=parser.types();
    if(!parser.done() || heads.length!==1)fail('Instance requires one complete type',token);
    const head=heads[0],target=instanceKey(head);
    if(!target)fail('Instance head must be a data type, scalar or vector',token);
    const params=new Set();
    const visit=t=>{if(t?.tag==='param')params.add(t.name);else if(t && typeof t==='object')for(const v of Object.values(t)){if(Array.isArray(v))v.forEach(visit);else visit(v);}};visit(head);
    for(const [cls,...args] of context){
      const constraintClass=classes.get(cls);if(!constraintClass)fail('Unknown class: '+cls,token);
      const count=cls==='streem'?2:1+(constraintClass.associated?.length||0);
      if(args.length!==count && !(args.length===1 && count>1))fail('Invalid instance constraint arity: '+cls,token);
      if(args.some(param=>!params.has(param)))fail('Instance constraint variable must occur in its head',token);
    }
    if(c.operatorClass && head.tag!=='adt' && operatorFallback(c,head))fail(`Primitive operator instance already exists: ${name} ${target}`,token);
    if(c.indexClass&&(head.tag==='list'||head.tag==='atom'&&head.name==='string'))fail('Built-in indexer instance already exists',token);
    if(name==='streem' && ['vector','range'].includes(target))fail('Built-in streem instance already exists',token);
    if(c.instances.has(target))fail(`Duplicate instance or overlapping instance: ${name} ${target}`,token);
    const instance={target,head,context,implementations:new Map(),token};c.instances.set(target,instance);
    const parts=members(body);instance.associated=new Map();instance.associatedSources=new Map();
    for(const associated of c.associated||[]) {
      const matches=parts.filter(p=>p[0]?.value===associated.name && p[1]?.value===':');
      if(matches.length!==1)fail((matches.length?'Duplicate':'Missing')+' associated type: '+associated.name,token);
      const part=matches[0],source=part.slice(2).map(t=>t.value),parser=typeSyntax(source,definitions.dataTypes,params,m=>fail(m,token)),types=parser.types();
      if(!parser.done() || types.length!==1)fail('Associated type requires one type: '+associated.name,token);
      instance.associated.set(associated.name,types[0]);instance.associatedSources.set(associated.param,source);parts.splice(parts.indexOf(part),1);
    }
    if(name==='streem') {
      const item=parts.find(p=>p[0]?.value==='item' && p[1]?.value===':');
      if(item){const p=typeSyntax(item.slice(2).map(t=>t.value),definitions.dataTypes,params,m=>fail(m,token));const ts=p.types();if(!p.done()||ts.length!==1)fail('item requires one type',token);instance.item=ts[0];parts.splice(parts.indexOf(item),1);}
      else instance.item=head.tag==='adt'?head.args[0]:null;
      if(!instance.item)fail('streem instance requires item : elementType',token);
    }
    for(const part of parts) {
      let depth=0,sep=-1;
      for(let i=0;i<part.length;i++){const t=part[i];if(!depth && ['=','|'].includes(t.value)){sep=i;break;}if(['(','[','{'].includes(t.kind))depth++;if([')',']','}'].includes(t.kind))depth--;}
      if(part[0]?.kind==='(' && part[2]?.kind===')'){part.splice(0,3,part[1]);sep-=2;}
      const method=part[0];
      if(sep<1 || !c.methods.has(method.value))fail('Instance must define a method declared by its class',method||part[0]);
      const hidden=`__tc_${name.length}_${name}_${target.length}_${target}_${[...method.value].map(c=>c.charCodeAt(0)).join('_')}`;
      instance.implementations.set(method.value,hidden);
      ordinary.push(part.map((t,i)=>i===0?{...t,value:hidden,internal:true}:t));
    }
    for(const [method,m] of c.methods) {
      if(!instance.implementations.has(method))fail(`Missing instance method: ${method}`,token);
      const used=new Set(m.signature?.match(/'[A-Za-z0-9_]+/g)||[]);let fresh=0;
      const renamed=new Map([...params].map(p=>{let n;do{n=`'instance${fresh++}`;}while(used.has(n));used.add(n);return [p,n];}));
      const targetSource='( '+headTokens.map(t=>renamed.get(t)||t).join(' ')+' )';
      const prefix=context.map(([cls,...ps])=>`${cls} ${ps.map(p=>renamed.get(p)).join(' ')}`).join(', ');
      const signature=name==='streem'?{each:instance}: (prefix?prefix+' => ':'')+m.signature.split(' ').map(t=>t===c.param?targetSource:instance.associatedSources.has(t)?'( '+instance.associatedSources.get(t).map(x=>renamed.get(x)||x).join(' ')+' )':t).join(' ');
      const hidden=instance.implementations.get(method);
      // compile() installs these specialized signatures after all bodies are parsed.
      instance.signatures ??= new Map();instance.signatures.set(hidden,signature);
    }
  }
  installOperatorClasses(classes,methods);
  definitions.classes=classes;definitions.methods=methods;
  return ordinary;
}
