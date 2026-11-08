import {typePosition} from '../frontend/modules.mjs';
import {tokenLine} from '../frontend/source-layout.mjs';
import {standardModule,standardModuleNames} from '../frontend/std-modules.mjs';
import {classParameters,superConstraints,syntaxSource} from '../types/class-relations.mjs';
import {basename} from 'node:path';

const key=t=>`${t?.line}:${t?.col}`;
const codeBlock=text=>'```nyanco\n'+text+'\n```';
const standardNames=new Map();
for(const module of standardModuleNames()){
  if(module==='std.prelude')continue;
  for(const symbol of standardModule(module).exports.values())
    if(symbol.kinds.has('data')||symbol.kinds.has('class'))standardNames.set(symbol.internal,module+'.'+symbol.name);
}

const nativeTypes=new Map([
  ['int', ['', '符号付き整数型。ネイティブ実行時は64ビットです。']],
  ['float', ['', '64ビットの浮動小数点数型です。']],
  ['byte', ['', '0から255までの符号なし8ビット整数型です。']],
  ['char', ['', 'Unicodeのスカラー値を1つ表します。']],
  ['bool', ['', '`True` と `False` の真偽値型です。']],
  ['string', ['', 'UTF-8文字列型。インデックスアクセスは `byte` を返します。']],
  ['range', ['', '`..` と `..=` が生成する整数範囲の型です。']],
  ['vector', ["'a", "要素型が `'a` のvectorです。`['a]` とも書けます。"]],
  ['dict', ["'k 'v", "キー型が `'k`、値型が `'v` の辞書です。"]],
  ['set', ["'a", "要素型が `'a` のハッシュ集合です。"]],
  ['deque', ["'a", "要素型が `'a` の両端キューです。"]],
  ['heap', ["'a", "要素型が `'a` の二分ヒープです。"]],
  ['stream', ["'a {-> / { | 'e}}", "走査時に `'e` のエフェクトを伴う、要素型が `'a` の遅延streamです。"]],
  ['mutref', ["'r 'a", "借用領域 `'r` で値型 `'a` を排他的に借用した可変参照です。"]],
  ['continuation', ["{'a -> 'b}", "再開時に `'a` を受け取り、続きの計算が `'b` を返す継続の型です。"]],
]);

export function typeHoverTokens(groups,rewritten,imports,{classes,dataTypes}){
  const resolved=new Map(rewritten.filter(t=>t.sourceName).map(t=>[key(t),t])),tokens=[];
  const resolve=t=>resolved.get(key(t))||t;
  for(let group of groups){
    if(['pub','open'].includes(group[0]?.value))group=group.slice(1);
    if(group[0]?.value==='import'){
      const start=group.findIndex(t=>t.kind==='{');
      if(start<0)continue;
      const module=imports.get(key(group[2]?.value==='as'?group[3]:group[1]));
      if(!module)continue;
      for(let i=start+1;i<group.length-1;i++){
        const member=group[i];if(member.kind===',')continue;
        const alias=group[i+1]?.value==='as'?group[i+2]:null;
        if(alias)i+=2;
        const symbol=module.exports.get(member.value);
        if(symbol?.access.has('type')){
          tokens.push({...member,value:symbol.internal});
          if(alias)tokens.push({...alias,value:symbol.internal});
        }
      }
      continue;
    }
    if(!typePosition(group,1))continue;
    const kind=group[0]?.value;
    const where=['class','instance'].includes(kind)?group.findIndex(t=>t.value==='where'):-1;
    const arrow=where<0?-1:group.findIndex((t,i)=>i<where&&t.value==='=>');
    const cls=where<0?null:classes.get(resolve(group[arrow<0?1:arrow+1])?.value);
    for(let i=1;i<group.length;i++){
      const t=group[i];
      if((t.kind!=='word'&&t.kind!=='[')||group[i-1]?.value==='..')continue;
      const reference=t.kind==='['?{...t,value:'vector'}:resolve(t);
      const associated=i>where&&cls?.associated?.find(a=>a.name===t.value);
      if(!associated&&!classes.has(reference.value)&&!dataTypes.has(reference.value)&&!nativeTypes.has(reference.value))continue;
      if(kind==='instance'&&!typePosition(group,i))continue;
      const label=group[i+1]?.value===':';
      const member=label&&t.col===group[where+1]?.col&&tokenLine(t)!==tokenLine(group[i-1]);
      if(associated&&(kind==='class'&&!label||kind==='instance'&&member)){
        tokens.push({...t,associated:{name:t.value,owner:associated.owner||cls.name}});
      }else if(!label)tokens.push(reference);
    }
  }
  return tokens;
}

function standardClassDefinition(cls,types){
  const constraints=superConstraints(cls).map(c=>[c.name,...c.args.map(syntaxSource)].join(' '));
  const associated=new Map((cls.associated||[]).map(a=>[a.param,a.name]));
  const members=(cls.associated||[]).filter(a=>a.owner===cls.name).map(a=>'type '+a.name),inferred=[];
  for(const method of cls.methods.values()){
    if(method.className!==cls.name)continue;
    if(method.signature)members.push(method.name+' : '+method.signature.replace(/'[a-z][A-Za-z0-9_']*/g,p=>associated.get(p)||p));
    else if(types.has(method.name))inferred.push(method.name+' : '+types.get(method.name));
  }
  const header='class '+(constraints.length?constraints.join(', ')+' => ':'')+[cls.name,...classParameters(cls)].join(' ')+' where';
  return codeBlock([header,...members.map(line=>'    '+line)].join('\n'))+(inferred.length?'\n\nメソッドの型\n\n'+codeBlock(inferred.join('\n')):'');
}

export function typeHoverDetails(program,token,readDeclaration){
  const {definitions,modules,types}=program;
  const {associated}=token,name=associated?.owner||token.value;
  const cls=definitions.classes.get(name),data=definitions.dataTypes.get(name),native=nativeTypes.get(name);
  if(!cls&&!data&&!native)return null;
  const declaration=cls||data,sourceRange=declaration?.sourceRange;
  const module=sourceRange&&modules?.ordered.find(m=>m.id===sourceRange.start.moduleID);
  const shortName=module?.prefix?name.slice(module.prefix.length):name;
  const qualified=module?basename(module.dir)+'.'+shortName:sourceRange?shortName:standardNames.get(name)||name;
  if(associated)return '**関連型** `'+qualified+'.'+associated.name+'`\n\n'+codeBlock('type '+associated.name);
  const title='**'+(cls?'型クラス':'型')+'** `'+qualified+'`\n\n';
  const opaque=data&&sourceRange&&!data.transparent&&modules&&data.moduleID!==modules.root.id;
  if(sourceRange&&!opaque){
    const source=readDeclaration(sourceRange);
    if(source)return title+codeBlock(source);
  }
  if(cls)return title+standardClassDefinition(cls,types);
  if(data){
    const header=(opaque?'pub ':'')+(data.alias?'type ':'data ')+[shortName,...data.parameters].join(' ');
    const constructors=data.builtin?[...definitions.constructors.values()].filter(c=>c.typeName===name).map(c=>[c.name,...c.fields.map(syntaxSource)].join(' ')):[];
    return title+codeBlock(header+(constructors.length?' = '+constructors.join(' | '):''))+(opaque?'\n\nモジュール外では内部表現が非公開です。':'');
  }
  const [parameters,description]=native;
  return title+codeBlock(parameters?name+' '+parameters:name)+'\n\n'+description;
}
