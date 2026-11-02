// Explicit v0.37 -> v0.38 source migration. The production front end never
// loads the archived parser; it is used only to preserve old source semantics.
import * as old from './v037/language.mjs';
import {typeSyntax} from './v037/type-syntax.mjs';
import {classConstraint} from './v037/class-syntax.mjs';
export const marker='-- Nyanco 0.38 prefix';
const lit=x=>typeof x==='boolean'?(x?'True':'False'):JSON.stringify(x);
export function typeText(t){
  if(t.tag==='param'||t.tag==='atom')return t.name;
  if(t.tag==='adt')return t.args.length?`(${t.name} ${t.args.map(typeText).join(' ')})`:t.name;
  if(t.tag==='list')return `[${typeText(t.item)}]`;
  if(t.tag==='tuple')return `#(${t.items.map(typeText).join(' ')}${t.tail?' | '+t.tail:''})`;
  if(t.tag==='record')return `{${t.fields.map(([n,v])=>n+': '+typeText(v)).join(', ')}${t.tail?' | '+t.tail:t.fields.length?'':':'}}`;
  if(t.tag==='quote')return `{${effectText(t)}}`;
  throw Error('Unknown type syntax '+t.tag);
}
function effectText(t){return `${t.input.map(typeText).join(' ')} -> ${t.never?'!':t.output.map(typeText).join(' ')}${t.effects?' / {'+t.effects.map(e=>[e.name,...e.args.map(typeText)].join(' ')).join(', ')+(t.effectTail?' | '+t.effectTail:'')+'}':''}`;}
export function signatureText(source,dataTypes){
  if(source.trim()==='!')return source;
  const parts=source.split('=>'),body=parts.at(-1),tokens=old.lex(body).map(t=>t.value),parser=typeSyntax(tokens,dataTypes,null,m=>{throw new old.StaticTypeError(m)});
  let depth=0,arrow=false;for(const t of tokens){if(t==='->'&&!depth)arrow=true;if(['(','[','{'].includes(t))depth++;if([')',']','}'].includes(t))depth--;}
  const value=arrow?effectText(parser.effect()):parser.types().map(typeText).join(' ');
  if(!parser.done())throw new old.StaticTypeError('Unexpected type annotation token');
  const constraints=parts.length===2?parts[0].split(',').map(x=>{const c=classConstraint(x);return [c.name==='each'?'streem':c.name,...c.args].join(' ')}).join(', ')+' => ':'';
  return constraints+value;
}
export function patternText(p){
  if(p.kind==='literal')return lit(p.value);
  if(p.kind==='constructor')return p.fields.length?`(${p.value} ${p.fields.map(patternText).join(' ')})`:p.value;
  if(p.kind==='push-pattern')return `(${patternText(p.fields[0])} :: ${patternText(p.fields[1])})`;
  if(p.kind==='list-pattern')return `[${p.fields.map(patternText).join(' ')}]`;
  if(p.kind==='tuple-pattern')return `#(${p.fields.map(patternText).join(' ')})`;
  return p.value;
}
export function sequenceText(nodes){
  let text='';
  for(const n of nodes){
    if(n.kind==='capture'){if(text)text+='; ';continue;}
    const part=nodeText(n);if(!part)continue;
    if(text && !text.endsWith('; '))text+=', ';
    text+=part;
  }
  return text;
}
const operand=ns=>ns.length===1&&ns[0].kind==='missing'?'':`(${sequenceText(ns)})`;
function nodeText(n){
  if(n.kind==='literal')return lit(n.value);
  if(n.kind==='word'||n.kind==='reference')return n.value;
  if(n.kind==='missing')return '';
  if(n.kind==='field')return '.'+n.name;
  if(n.kind==='tuple-index')return '.'+n.index;
  if(n.kind==='scope')return '('+sequenceText(n.body)+')';
  if(n.kind==='quote')return '{'+sequenceText(n.body)+'}';
  if(n.kind==='list')return '['+sequenceText(n.body)+']';
  if(n.kind==='tuple')return '#('+sequenceText(n.body)+')';
  if(n.kind==='record')return n.fields.length?'{'+n.fields.map(f=>f.name+': '+(f.body.length===1&&f.body[0].kind==='missing'?'':'('+sequenceText(f.body)+')')).join(', ')+'}':'{:}';
  if(n.kind==='binary')return `(${operand(n.left)} ${n.value==='and'?'.&.':n.value==='or'?'.|.':n.value} ${operand(n.right)})`;
  if(n.kind==='comparison-chain')return '('+n.operands.map((o,i)=>(i?n.operators[i-1].value+' ':'')+operand(o)).join(' ')+')';
  if(n.kind==='update')return `(${n.name} <<- (${sequenceText(n.body)}))`;
  if(n.kind==='bind')return '-> '+n.patterns.map(p=>n.mutable[n.names.indexOf(p.value)]?'mut '+patternText(p):patternText(p)).join(' ');
  if(n.kind==='local-function')return `${n.name} = (${sequenceText(n.body)})`;
  if(n.kind==='case')return 'case\n'+n.branches.map(b=>'  -> '+b.patterns.map(patternText).join(' ')+(b.guard?' | '+sequenceText(b.guard):'')+' ? '+sequenceText(b.body).replaceAll('\n','\n  ')).join('\n')+'\nend';
  throw Error('Cannot migrate node '+n.kind);
}
export function programText(program){
  const d=program.definitions,out=[marker];
  for(const t of d.dataTypes.values())out.push(`data ${t.name} ${t.parameters.join(' ')} = `+[...d.constructors.values()].filter(c=>c.typeName===t.name).map(c=>[c.name,...c.fields.map(typeText)].join(' ')).join(' | '));
  for(const op of d.effects.values())out.push(`effect ${op.name} ${(op.parameters||[]).join(' ')}: ${effectText(op.syntax)}`);
  for(const c of d.classes.values()){
    if(c.standard)continue;
    const aliases=new Map((c.associated||[]).map(a=>[a.param,a.name]));
    out.push(`class ${c.name} ${c.param} where\n`+[...(c.associated||[]).map(a=>'  type '+a.name),...[...c.methods.values()].map(m=>'  '+m.name+' : '+signatureText(m.signature,d.dataTypes).split(' ').map(t=>aliases.get(t)||t).join(' '))].join('\n'));
  }
  const clauseText=(name,c)=>`${name}${c.patterns.length?' '+c.patterns.map(patternText).join(' '):''}${c.guard?' | '+sequenceText(c.guard):''} =\n  ${sequenceText(c.body).replaceAll('\n','\n  ')}`;
  for(const c of d.classes.values())for(const inst of c.instances.values()){
    const context=inst.context.length?inst.context.map(([n,...args])=>[n==='each'?'streem':n,...args].join(' ')).join(', ')+' => ':'';
    const members=[];
    if(c.name==='each')members.push('item : '+typeText(inst.item));
    for(const [n,t] of inst.associated||[])members.push(n+' : '+typeText(t));
    for(const [name,hidden] of inst.implementations)for(const clause of d.get(hidden))members.push(clauseText(name,clause));
    out.push(`instance ${context}${c.name==='each'?'streem':c.name} ${typeText(inst.head)} where\n  `+members.join('\n').replaceAll('\n','\n  '));
  }
  for(const [name,clauses] of d){
    if(name.startsWith('__tc_'))continue;
    if(typeof clauses.signature==='string')out.push(name+' : '+signatureText(clauses.signature,d.dataTypes));
    for(const c of clauses)out.push(clauseText(name,c));
  }
  if(d.initializers?.length)out.push(sequenceText(d.initializers));
  return out.join('\n\n')+'\n';
}
export function migrateSource(source,file='<migration>',previous=new Map(),globals=new Map()){
  const legacy=old.compile(source,file,previous,{checkTypes:false,globals});return {source:programText(legacy),legacy};
}
export function migrateExpression(source,constructors){return sequenceText(old.parseExpression(source,'<migration>',constructors));}
