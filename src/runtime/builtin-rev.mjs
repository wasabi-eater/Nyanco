const token={file:'<std.rev>',line:1,col:1};
const item={tag:'param',name:"'a"};

export function installRevType(definitions) {
  if(definitions.dataTypes?.has('rev')||definitions.constructors?.has('Rev'))return;
  const parameters=[item.name];
  definitions.dataTypes=new Map(definitions.dataTypes);
  definitions.constructors=new Map(definitions.constructors);
  definitions.dataTypes.set('rev',{name:'rev',parameters,token,postfix:false,builtin:true});
  definitions.constructors.set('Rev',{name:'Rev',typeName:'rev',parameters,fields:[item],token});
}

export function installRevInstances(definitions,add) {
  if(!definitions.dataTypes?.get('rev')?.builtin)return;
  const head={tag:'adt',name:'rev',args:[item]},wrapped="(rev 'a)";
  for(const [name,methods] of [
    ['eq',['==','/=']],
    ['ord',['<','<=','>','>=']],
    ['hash',['hash']],
    ['show',['show']],
  ]){
    const cls=definitions.classes.get(name);
    if(!cls||cls.instances.has('rev')||methods.some(method=>definitions.methods.get(method)?.className!==name))continue;
    if(name==='ord'&&!definitions.classes.get('eq')?.instances.has('rev'))continue;
    const implementations=new Map();
    for(const [index,method] of methods.entries()){
      const implementation=`__tc_rev_${name}_${index}`;
      if(name==='eq'||name==='ord'){
        const comparison=name==='ord'?`b ${method} a`:`a ${method} b`;
        add(implementation,['left','right'],`left; -> Rev a; right; -> Rev b; ${comparison}`,
          `${name} 'a => ${wrapped} ${wrapped} -> bool / {}`);
      }else{
        const body=name==='hash'?'hash a':'"(Rev " ++ show a ++ ")"';
        add(implementation,['value'],`value; -> Rev a; ${body}`,
          `${name} 'a => ${wrapped} -> ${name==='hash'?'int':'string'} / {}`);
      }
      implementations.set(method,implementation);
    }
    const instances=new Map(cls.instances);
    instances.set('rev',{target:'rev',head,context:[[name,item]],implementations,token});
    definitions.classes.set(name,{...cls,instances});
  }
}
