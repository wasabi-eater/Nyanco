import {typeName} from './type-names.mjs';
// Shared syntax for constructor fields and explicit stack-effect annotations.
export function typeSyntax(tokens, dataTypes, parameters, fail) {
  let i = 0;
  const expect = value => { if (tokens[i++] !== value) fail(`Expected ${value} in type`); };
  function type() {
    const raw = tokens[i++],name=typeName(raw);
    if(name==='vector')return {tag:'list',item:type()};
    if(name==='stream'){const item=type(),block=type();if(block.tag!=='quote'||block.input.length||block.output.length||block.never)fail('stream requires item type and { -> / effects }');return {tag:'stream',item,block};}
    if(name==='#') {
      expect('(');const items=types(')');let tail=null;
      if(tokens[i]==='|'){i++;tail=tokens[i++];if(!/^'?[a-z][a-zA-Z0-9_']*$/.test(tail||'') || parameters && !parameters.has(tail))fail('Expected tuple row parameter');}
      expect(')');return {tag:'tuple',items,tail};
    }
    if (name === '(') { const result=types(')'); expect(')'); if(result.length!==1)fail('Expected one grouped type'); return result[0]; }
    if (name === '[') { const items=types(']'); expect(']'); if(items.length!==1)fail('Expected one vector element type'); return {tag:'list',item:items[0]}; }
    if(name==='{' && ([':','|'].includes(tokens[i]) || tokens[i+1]===':')) {
      const fields=[],names=new Set();let tail=null;
      if(tokens[i]===':'){i++;expect('}');return {tag:'record',fields,tail};}
      if(tokens[i]==='|'){i++;tail=tokens[i++];if(!/^'?[a-z][a-zA-Z0-9_']*$/.test(tail||'') || parameters && !parameters.has(tail))fail('Expected record row parameter');expect('}');return {tag:'record',fields,tail};}
      while(true) {
        const key=tokens[i++];if(!/^[a-zA-Z_][a-zA-Z0-9_']*$/.test(key||''))fail('Expected record field name');
        if(names.has(key))fail(`Duplicate record field: ${key}`);names.add(key);expect(':');
        const field=types(',');if(field.length!==1)fail('Expected one record field type');fields.push([key,field[0]]);
        if(tokens[i]===','){i++;continue;}
        if(tokens[i]==='|'){i++;tail=tokens[i++];if(!/^'?[a-z][a-zA-Z0-9_']*$/.test(tail||'') || parameters && !parameters.has(tail))fail('Expected record row parameter');}
        expect('}');return {tag:'record',fields,tail};
      }
    }
    if (name === '{') { const result=effect('}'); expect('}'); return result; }
    
    if (['num','bool','string','range'].includes(name)) return {tag:'atom',name};
    if (dataTypes.has(name) && !dataTypes.get(name).postfix) {
      const args=dataTypes.get(name).parameters.map(()=>type());
      return {tag:'adt',name,args};
    }
    if (raw===name && name && /^'?[a-z][a-zA-Z0-9_']*$/.test(name) && (!parameters || parameters.has(name)) && !dataTypes.has(name))
      return {tag:'param',name};
    fail(`Unknown type or undeclared type parameter: ${name ?? '<end>'}`);
  }
  function types(stop) {
    const items=[];
    while(i<tokens.length && ![stop,'}',')',',','|','/'].includes(tokens[i])) {
      const name=typeName(tokens[i]),declaration=dataTypes.get(name);
      if(declaration?.postfix) {
        i++;
        const count=declaration.parameters.length;
        if(items.length<count)fail(`Type ${name} requires ${count} preceding type arguments`);
        items.push({tag:'adt',name,args:count ? items.splice(-count) : []});
      } else items.push(type());
    }
    return items;
  }
  function side(stop) {
    let close=i,depth=0;
    if(tokens[i]==='(')do{if(tokens[close]==='(')depth++;if(tokens[close]===')')depth--;close++;}while(depth && close<tokens.length);
    const grouped=tokens[i]==='(' && (tokens[close]===stop || tokens[close]===undefined);
    if(grouped)i++;
    const items=types(stop);
    if(grouped)expect(')');
    return items;
  }
  function effect(end) {
    const input=side('->');expect('->');
    const never=tokens[i]==='!';if(never)i++;
    const result={tag:'quote',input,output:never?[]:side(end),...(never?{never:true}:{})};
    if(tokens[i]==='/') {
      i++;expect('{');result.effects=[];
      while(tokens[i]!=='}' && tokens[i]!=='|') {
        let j=i,depth=0;
        while(j<tokens.length){const t=tokens[j];if(!depth && [',','}','|'].includes(t))break;if(['(','[','{'].includes(t))depth++;if([')',']','}'].includes(t))depth--;j++;}
        const name=tokens[i];if(!/^[a-z][a-zA-Z0-9_']*$/.test(name||''))fail('Expected effect operation name');
        const parser=typeSyntax(tokens.slice(i+1,j),dataTypes,parameters,fail),args=parser.types();
        if(!parser.done())fail('Invalid effect arguments');
        result.effects.push({name,args});i=j;
        if(tokens[i]!==',')break;i++;
      }
      if(tokens[i]==='|') {
        i++;result.effectTail=tokens[i++];
        if(!/^'[a-z][a-zA-Z0-9_']*$/.test(result.effectTail||''))fail('Expected effect row parameter');
      }
      expect('}');
    }
    return result;
  }
  return {type,types,effect,done:()=>i===tokens.length};
}

export function patternNames(patterns, names = []) {
  for (const p of patterns) {
    if (['constructor','list-pattern','push-pattern','tuple-pattern'].includes(p.kind)) patternNames(p.fields,names);
    else if (p.kind === 'word' && p.value !== '_') names.push(p.value);
  }
  return names;
}
