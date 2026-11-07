import {syntaxSource,substitute,lookupInstance} from './class-relations.mjs';

// Expand deriving into normal instances so inference, dictionaries and native
// specialization use exactly the same paths as hand-written implementations.
export function derivingSources(definitions,fail){
  const classes=definitions.classes,data=definitions.dataTypes;
  function match(pattern,type,bindings){
    if(pattern.tag==='param'){bindings.set(pattern.name,type);return;}
    if(pattern.tag==='list')return match(pattern.item,type.item,bindings);
    if(pattern.tag==='adt')pattern.args.forEach((t,i)=>match(t,type.args[i],bindings));
  }
  function evidence(cls,type,seen=new Set()){
    if(type.tag==='param')return [[cls,type.name]];
    if(type.tag==='adt'){
      const id=cls+':'+type.name;if(seen.has(id))return [];seen=new Set([...seen,id]);
      const instance=lookupInstance(classes.get(cls),[type]);
      if(instance){
        const bindings=new Map();match(instance.head,type,bindings);
        return instance.context.flatMap(([name,...args])=>{
          const actual=args.map(t=>substitute(t,bindings)),owner=classes.get(name);
          if((owner?.params?.length||1)>1||owner?.associated?.length||name==='streem')return [[name,...actual.map(syntaxSource)]];
          return actual.flatMap(t=>evidence(name,t,seen));
        });
      }
      const declaration=data.get(type.name);
      if(declaration?.deriving?.includes(cls)){
        const bindings=new Map(declaration.parameters.map((p,i)=>[p,type.args[i]]));
        return [...definitions.constructors.values()].filter(c=>c.typeName===type.name).flatMap(c=>c.fields.flatMap(t=>evidence(cls,substitute(t,bindings),seen)));
      }
      if(['option','result','dict'].includes(type.name))return type.args.flatMap(t=>evidence(cls,t,seen));
      return [];
    }
    if(type.tag==='list')return evidence(cls,type.item,seen);
    if(type.tag==='tuple')return type.items.flatMap(t=>evidence(cls,t,seen));
    if(type.tag==='record')return type.fields.flatMap(([,t])=>evidence(cls,t,seen));
    return [];
  }
  const out=[];
  for(const declaration of data.values())for(const cls of declaration.deriving||[]){
    if(!['show','eq','hash','ord'].includes(cls))fail('Cannot derive '+cls,declaration.token);
    const constructors=[...definitions.constructors.values()].filter(c=>c.typeName===declaration.name);
    const type={tag:'adt',name:declaration.name,args:declaration.parameters.map(name=>({tag:'param',name}))};
    const constraints=[...new Set(evidence(cls,type).map(parts=>parts.join(' ')))];
    const lines=[`instance ${constraints.length?constraints.join(', ')+' => ':''}${cls} ${syntaxSource(type)} where`];
    const pattern=(c,prefix)=>c.fields.length?'('+c.name+' '+c.fields.map((_,i)=>prefix+i).join(' ')+')':c.name;
    if(cls==='show')for(const c of constructors){
      const display=c.token.sourceName||c.name;
      const body=c.fields.length?JSON.stringify('('+display+' ')+' ++ '+c.fields.map((_,i)=>`show left${i}`).join(' ++ " " ++ ')+' ++ ")"':JSON.stringify(display);
      lines.push(`  show ${pattern(c,'left')} = ${body}`);
    }
    if(cls==='hash')for(const c of constructors){
      const values=[JSON.stringify(declaration.name+':'+c.name),...c.fields.map((_,i)=>'left'+i)];
      lines.push(`  hash ${pattern(c,'left')} = hash #(${values.join(', ')})`);
    }
    if(cls==='eq'){
      for(const c of constructors)lines.push(`  (==) ${pattern(c,'left')} ${pattern(c,'right')} = ${c.fields.length?c.fields.map((_,i)=>`(left${i} == right${i})`).join(' && '):'True'}`);
      lines.push('  (==) _ _ = False','  (/=) left right = not (left == right)');
    }
    if(cls==='ord')for(const op of ['<','<=','>','>='])for(let i=0;i<constructors.length;i++)for(let j=0;j<constructors.length;j++){
      const left=constructors[i],right=constructors[j];let body;
      if(i!==j)body=({'<':i<j,'<=':i<=j,'>':i>j,'>=':i>=j}[op])?'True':'False';
      else{body=op.length===2?'True':'False';const less=op.startsWith('<');for(let k=left.fields.length-1;k>=0;k--)body=`(left${k} ${less?'<':'>'} right${k}) || ((not (left${k} ${less?'>':'<'} right${k})) && (${body}))`;}
      lines.push(`  (${op}) ${pattern(left,'left')} ${pattern(right,'right')} = ${body}`);
    }
    out.push({source:lines.join('\n'),declaration,cls});
  }
  return out;
}
