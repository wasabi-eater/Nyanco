export const lowerName=name=>name ? name[0].toLowerCase()+name.slice(1) : name;
export const typeName=name=>name==='int'?'num':lowerName(name);
export const instanceKey=t=>t.tag==='list'?'vector':['atom','adt'].includes(t.tag)?t.name:null;
