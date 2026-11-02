import {classParameters,instanceHeads,relationKey,superConstraints,substitute,ancestorArguments,lookupInstance,builtinConversion,syntaxSource} from './class-relations.mjs';
import {resolveInheritance} from './class-inheritance.mjs';
import {classConstraint} from './class-syntax.mjs';
import {lowerName,instanceKey} from './type-names.mjs';
import {typeSyntax} from './type-syntax.mjs';
import {operatorSpecs,standardOperatorClasses,primitiveOperatorClass,operatorFallback,builtinInstance,installOperatorClasses} from './operator-classes.mjs';
// Layout-based type class declarations are expanded into ordinary checked functions.
import {LanguageError} from './language.mjs';
export function expandClasses(groups,definitions,previous,builtins,globals) {
  const classes=new Map([...definitions.classes||previous.classes||[]].map(([n,c])=>[n,{...c,methods:new Map(c.methods),instances:new Map(c.instances)}]));
  const methods=new Map(definitions.methods||previous.methods||[]),ordinary=[],pending=[];
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
    if(header.length<4 || header.at(-1).value!=='where' || body[0]?.col<=(first.declarationCol||first.col))fail('Expected class Name \'a where or instance Name Type where with indented members',first);
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
    const superArrow=header.findIndex(t=>t.value==='=>'),superParts=superArrow<0?[]:header.slice(1,superArrow).map(t=>t.value).join(' ').split(',');
    const own=header.slice(superArrow<0?1:superArrow+1,-1);name=lowerName(own[0]?.value);
    const classParams=own.slice(1).map(t=>t.value);arg=classParams[0];
    if(!/^[a-z][A-Za-z0-9_]*$/.test(name||'')||!classParams.length||new Set(classParams).size!==classParams.length||classParams.some(p=>!/^'[a-z][A-Za-z0-9_']*$/.test(p)))fail('Class requires a lowercase name and distinct type parameters',first);
    if(classes.has(name))fail(`Class already declared: ${name}`,first);
    const constraints=superParts.map(part=>{const sc=classConstraint(part,n=>classes.has(n)||standardOperatorClasses.has(n));if(!sc)fail('Invalid superclass constraint',first);const parser=typeSyntax(sc.args,definitions.dataTypes,new Set(classParams),m=>fail('Superclass: '+m,first)),args=parser.types();if(!parser.done())fail('Invalid superclass arguments',first);return {name:sc.name,args};});
    const supers=[...new Set(constraints.map(sc=>sc.name))];
    const c={name,param:arg,params:classParams,supers,superConstraints:constraints,associated:[],methods:new Map(),instances:new Map(),token:first};
    const classMembers=members(body),associatedParts=classMembers.filter(p=>p[0]?.value==='type');
    const used=new Set([...body.map(t=>t.value),...classParams]);
    for(const part of associatedParts){
      const label=part[1]?.value;
      if(part.length!==2 || !/^[a-z][A-Za-z0-9_]*$/.test(label||''))fail('Associated type declaration requires type name',part[0]);
      if(c.associated.some(a=>a.name===label) || definitions.dataTypes.has(label) || ['int','float','byte','char','bool','string','range','stream','continuation'].includes(label))fail('Duplicate or reserved associated type: '+label,part[0]);
      let param="'associated_"+label;while(used.has(param))param+='_';used.add(param);c.associated.push({name:label,param,owner:name});
    }
    for(const part of classMembers.filter(p=>p[0]?.value!=='type')) {
      // Parenthesized symbols are accepted in declarations as well as bare symbols.
      if(part[0]?.kind==='(' && part[2]?.kind===')')part.splice(0,3,part[1]);
      const [method,colon]=part;
      if(method.kind!=='word' || (!/^[a-z][A-Za-z0-9_']*$/.test(method.value) && !operatorSpecs.has(method.value)) || colon?.value!==':' || part.length<3)fail('Class member requires method : input -> output',method);
      if(methods.has(method.value) || builtins.has(method.value) && !operatorSpecs.has(method.value) || definitions.has(method.value) || globals.has(method.value) || definitions.constructors.has(method.value))fail(`Method name already used: ${method.value}`,method);
      const m={name:method.value,className:name,param:arg,params:classParams,...(method.value==='xor'?{specialBits:true}:{}),signature:part.slice(2).map((t,i,ts)=>ts[i+1]?.value===':'?t.value:(c.associated.find(a=>a.name===t.value)?.param||t.value)).join(' '),token:method};
      c.methods.set(m.name,m);methods.set(m.name,m);
    }
    if(!c.methods.size&&!supers.length)fail('Class requires a method or superclass',first);
    const operators=[...c.methods.values()].filter(m=>operatorSpecs.has(m.name));
    if(operators.length) {
      if(operators.length!==c.methods.size)fail('Operator classes cannot mix primitive operators and other methods',first);
      for(const m of operators) {
        m.signature=m.signature.replace(/\b(Num|Bool|String)\b/g,x=>lowerName(x));
        const expected=`${arg} ${operatorSpecs.get(m.name).right||arg} -> ${operatorSpecs.get(m.name).result==="'a"?arg:operatorSpecs.get(m.name).result}${operatorSpecs.get(m.name).exn?' / {exn}':''}`;
        if(m.signature.replace(/\s/g,'')!==expected.replace(/\s/g,''))fail(`Operator ${m.name} requires ${expected}`,m.token);
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
  resolveInheritance(classes,fail);
  const depth=name=>1+Math.max(-1,...(classes.get(name)?.supers||[]).map(depth));
  pending.sort((a,b)=>depth(a.head[0])-depth(b.head[0]));
  for(const {head:header,context,body,token} of pending) {
    const postfix=false;
    const name=lowerName(postfix?header.at(-1):header[0]),headTokens=postfix?header.slice(0,-1):header.slice(1);
    enableStandard(name,token);
    const c=classes.get(name);if(!c)fail(`Unknown class: ${name}`,token);
    const parser=typeSyntax(headTokens,definitions.dataTypes,null,m=>fail(m,token)),heads=parser.types();
    if(!parser.done() || heads.length!==classParameters(c).length)fail('Instance requires '+classParameters(c).length+' complete type argument(s)',token);
    const head=heads[0],target=relationKey(heads);
    if(!target||heads.length===1&&head.tag==='param')fail('Instance head must be a data type, scalar or vector',token);
    const params=new Set();
    const visit=t=>{if(t?.tag==='param')params.add(t.name);else if(t && typeof t==='object')for(const v of Object.values(t)){if(Array.isArray(v))v.forEach(visit);else visit(v);}};heads.forEach(visit);
    for(let i=0;i<context.length;i++){
      const [cls,...tokens]=context[i],constraintClass=classes.get(cls);if(!constraintClass)fail('Unknown class: '+cls,token);
      const parser=typeSyntax(tokens,definitions.dataTypes,params,m=>fail('Instance constraint: '+m,token)),args=parser.types();if(!parser.done())fail('Invalid instance constraint',token);
      const count=cls==='streem'?2:classParameters(constraintClass).length+(constraintClass.associated?.length||0);
      if(args.length!==count&&!(args.length===classParameters(constraintClass).length&&count>args.length))fail('Invalid instance constraint arity: '+cls,token);
      context[i]=[cls,...args];
    }
    if(c.bitClass&&head.tag==='atom'&&['int','byte'].includes(head.name))fail('Built-in bits instance already exists',token);
    if(c.intoClass&&heads.every(t=>t.tag==='param'||t.tag==='atom'&&['int','float','byte','char'].includes(t.name)))fail('Built-in conversion instance already exists',token);
    if((c.castClass||c.numClass)&&head.tag==='atom'&&(['int','float','byte'].includes(head.name)||c.castClass&&head.name==='char'))fail('Built-in numeric instance already exists',token);
    if(c.operatorClass && head.tag!=='adt' && operatorFallback(c,head))fail(`Primitive operator instance already exists: ${name} ${target}`,token);
    if(c.indexClass&&(head.tag==='adt'&&head.name==='dict'||head.tag==='list'||head.tag==='atom'&&head.name==='string'))fail('Built-in indexer instance already exists',token);
    if(name==='streem' && ['vector','range','dict'].includes(target))fail('Built-in streem instance already exists',token);
    if([...c.instances.values()].some(i=>instanceHeads(i).every((t,n)=>t.tag==='param'||heads[n].tag==='param'||instanceKey(t)===instanceKey(heads[n]))))fail(`Duplicate instance or overlapping instance: ${name} ${target}`,token);
    const instance={target,head,heads,context,implementations:new Map(),token};c.instances.set(target,instance);
    const parts=members(body);instance.associated=new Map();instance.associatedSources=new Map();
    for(const associated of c.associated||[]) {
      const matches=parts.filter(p=>p[0]?.value===associated.name && p[1]?.value===':');
      if(matches.length!==1)fail((matches.length?'Duplicate':'Missing')+' associated type: '+associated.name,token);
      const part=matches[0],source=part.slice(2).map(t=>t.value),parser=typeSyntax(source,definitions.dataTypes,params,m=>fail(m,token)),types=parser.types();
      if(!parser.done() || types.length!==1)fail('Associated type requires one type: '+associated.name,token);
      instance.associated.set(associated.name,types[0]);instance.associatedSources.set(associated.param,source);parts.splice(parts.indexOf(part),1);
    }
    if(name!=='streem'&&c.methods.get('each')?.specialEach)instance.item=instance.associated.get('item');
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
      if(c.conversion&&part[0]?.value==='from')part[0]={...part[0],value:c.name};
      const method=part[0];
      if(sep<1 || !c.methods.has(method.value))fail('Instance must define a method declared by its class',method||part[0]);
      const owner=classes.get(c.methods.get(method.value).className);if(owner!==c&&(lookupInstance(owner,ancestorArguments(classes,c,heads,owner.name))?.implementations.has(method.value)||!owner.showClass&&(owner.intoClass?builtinConversion(ancestorArguments(classes,c,heads,owner.name)):builtinInstance(owner,head))))fail('Inherited method already has a superclass instance: '+method.value,method);
      const hidden=`__tc_${name.length}_${name}_${target.length}_${[...target].map(c=>c.charCodeAt(0)).join('_')}_${[...method.value].map(c=>c.charCodeAt(0)).join('_')}`;
      instance.implementations.set(method.value,hidden);
      ordinary.push(part.map((t,i)=>i===0?{...t,value:hidden,internal:true}:t));
    }
    for(const [method,m] of c.methods) {
      if(!instance.implementations.has(method)){
        const owner=classes.get(m.className),parent=owner!==c&&owner&&lookupInstance(owner,ancestorArguments(classes,c,heads,owner.name));
        if(parent&&parent.implementations.get(method)){instance.implementations.set(method,parent.implementations.get(method));continue;}
        if(builtinInstance(owner,head)||owner?.intoClass&&builtinConversion(ancestorArguments(classes,c,heads,owner.name))||owner?.conversion&&lookupInstance(classes.get('into'),owner.conversion.map(t=>substitute(t,new Map([[owner.param,ancestorArguments(classes,c,heads,owner.name)[0]]])))))continue;
        // Derived superclass instances are expanded in the next compile pass.
        if(owner!==c&&head.tag==='adt'&&definitions.dataTypes.get(head.name)?.deriving?.includes(owner.name))continue;
        fail(`Missing instance method: ${method}`,token);
      }
      const used=new Set(m.signature?.match(/'[A-Za-z0-9_]+/g)||[]);let fresh=0;
      const renamed=new Map([...params].map(p=>{let n;do{n=`'instance${fresh++}`;}while(used.has(n));used.add(n);return [p,n];}));
      const sources=new Map(classParameters(c).map((p,i)=>[p,'( '+(heads.length===1?headTokens.map(t=>renamed.get(t)||t).join(' '):syntaxSource(substitute(heads[i],new Map([...renamed].map(([a,b])=>[a,{tag:'param',name:b}])))))+' )']));
      const prefix=context.map(([cls,...ps])=>`${cls} ${ps.map(p=>syntaxSource(substitute(p,new Map([...renamed].map(([a,b])=>[a,{tag:'param',name:b}]))))).join(' ')}`).join(', ');
      const signature=m.specialEach?{each:instance}: (prefix?prefix+' => ':'')+m.signature.split(' ').map(t=>sources.has(t)?sources.get(t):instance.associatedSources.has(t)?'( '+instance.associatedSources.get(t).map(x=>renamed.get(x)||x).join(' ')+' )':t).join(' ');
      const hidden=instance.implementations.get(method);
      // compile() installs these specialized signatures after all bodies are parsed.
      instance.signatures ??= new Map();instance.signatures.set(hidden,signature);
    }
    publishParents(c,instance);
  }
  function publishParents(c,instance,seen=new Set()){
    const identity=c.name+':'+instance.target;if(seen.has(identity))return;seen.add(identity);
    const bindings=new Map(classParameters(c).map((p,i)=>[p,instanceHeads(instance)[i]]));
    for(const sc of superConstraints(c)){const parent=classes.get(sc.name),heads=sc.args.map(t=>substitute(t,bindings)),key=relationKey(heads);let inherited=lookupInstance(parent,heads);
      const implementations=c.conversion&&parent.intoClass?new Map([['from',instance.implementations.get(c.name)]]):new Map([...parent.methods.keys()].map(m=>[m,instance.implementations.get(m)]));
      const hasImplementation=[...implementations.values()].some(Boolean),builtin=parent.intoClass?builtinConversion(heads):builtinInstance(parent,heads[0]);
      if(!inherited&&!hasImplementation&&(builtin||heads[0]?.tag==='adt'&&definitions.dataTypes.get(heads[0].name)?.deriving?.includes(parent.name)))continue;
      if(!inherited){inherited={...instance,target:key,head:heads[0],heads,implementations,signatures:new Map()};parent.instances.set(key,inherited);}
      else if(hasImplementation&&[...implementations].some(([m,fn])=>fn&&inherited.implementations.get(m)!==fn))fail('Conflicting superclass instance: '+parent.name,instance.token);
      publishParents(parent,inherited,seen);
    }
  }
  for(const c of classes.values())for(const instance of c.instances.values())publishParents(c,instance);
  installOperatorClasses(classes,methods);
  definitions.classes=classes;definitions.methods=methods;
  return ordinary;
}
