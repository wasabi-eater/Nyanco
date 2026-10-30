export function implies(classes,child,parent,seen=new Set()){
 if(child===parent)return true;if(seen.has(child))return false;seen.add(child);
 return (classes.get(child)?.supers||[]).some(name=>implies(classes,name,parent,seen));
}
export function resolveInheritance(classes,fail){
 const done=new Set(),active=new Set();
 function visit(c){if(done.has(c.name))return;if(active.has(c.name))fail('Cyclic class inheritance: '+c.name,c.token);active.add(c.name);
  for(const name of c.supers||[]){const parent=classes.get(name);if(!parent)fail('Unknown superclass: '+name,c.token);visit(parent);
   for(const a of parent.associated||[]){const prior=c.associated?.find(x=>x.name===a.name);if(prior&&(prior.param!==a.param||prior.owner&&a.owner&&prior.owner!==a.owner))fail('Conflicting inherited associated type: '+a.name,c.token);if(!prior)(c.associated??=[]).push({...a});}
   for(const [name,m] of parent.methods){if(c.methods.has(name)&&c.methods.get(name).className!==m.className)fail('Conflicting inherited method: '+name,c.token);
    if(m.specialEach){if(!c.associated?.some(a=>a.name==='item'))(c.associated??=[]).push({name:'item',param:"'inheritedItem"});if(!c.methods.has(name))c.methods.set(name,{...m});continue;}
    if(!m.signature)fail('Superclass has a specialized method without a class signature: '+name,c.token);
    if(!c.methods.has(name))c.methods.set(name,{...m,signature:m.signature.split(' ').map(t=>t===parent.param?c.param:t).join(' ')});
   }
  }
  for(const m of c.methods.values())if(m.signature)m.signature=m.signature.split(' ').map((t,i,ts)=>ts[i+1]===':'?t:(c.associated?.find(a=>a.name===t)?.param||t)).join(' ');
  active.delete(c.name);done.add(c.name);
 }
 for(const c of classes.values())visit(c);
}
