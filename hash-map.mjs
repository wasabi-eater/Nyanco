// Persistent binary hash trie. Updates copy only the search path; leaves with
// identical hashes keep collision buckets and still compare the full key.
const bit=(hash,depth)=>(hash>>>depth)&1;
function pairAt(node,key,hash,equal,depth=0){
  if(!node)return null;
  if(node.bucket)return node.hash===hash?node.bucket.find(p=>equal(p.key,key))||null:null;
  return pairAt(bit(hash,depth)?node.one:node.zero,key,hash,equal,depth+1);
}
function merge(a,b,depth){
  const x=bit(a.hash,depth),y=bit(b.hash,depth);
  if(x!==y)return x?{zero:b,one:a}:{zero:a,one:b};
  const child=merge(a,b,depth+1);return x?{zero:null,one:child}:{zero:child,one:null};
}
function insert(node,pair,hash,equal,depth=0){
  if(!node)return {hash,bucket:[pair]};
  if(node.bucket){
    if(node.hash!==hash)return merge(node,{hash,bucket:[pair]},depth);
    const index=node.bucket.findIndex(p=>equal(p.key,pair.key)),bucket=[...node.bucket];
    if(index<0)bucket.push(pair);else bucket[index]=pair;
    return {hash,bucket};
  }
  return bit(hash,depth)?{zero:node.zero,one:insert(node.one,pair,hash,equal,depth+1)}:{zero:insert(node.zero,pair,hash,equal,depth+1),one:node.one};
}
function* pairs(node){if(!node)return;if(node.bucket)yield* node.bucket;else{yield* pairs(node.zero);yield* pairs(node.one);}}
export function* dictHashedEntries(dict){function* walk(node){if(!node)return;if(node.bucket){for(const p of node.bucket)yield [p.key,p.value,node.hash];}else{yield* walk(node.zero);yield* walk(node.one);}}yield* walk(dict.root);}
export function* dictEntries(dict){for(const p of pairs(dict.root))yield [p.key,p.value];}
class Dictionary {
  kind='dict';
  constructor(root=null,size=0){this.root=root;this.size=size;}
  // Stable presentation is an implementation detail, never an iteration contract.
  get entries(){return [...pairs(this.root)].sort((a,b)=>a.index-b.index).map(p=>[p.key,p.value]);}
}
export const emptyDict=()=>new Dictionary();
export const dictGet=(dict,key,hash,equal)=>pairAt(dict.root,key,hash>>>0,equal);
export function dictBucket(dict,hash){let node=dict.root,depth=0;hash>>>=0;while(node&&!node.bucket)node=bit(hash,depth++)?node.one:node.zero;return node?.hash===hash?node.bucket:[];}
export function dictDelete(dict,key,hash,equal){
 hash>>>=0;if(!pairAt(dict.root,key,hash,equal))return dict;
 const remove=(node,depth)=>{
  if(node.bucket){const bucket=node.bucket.filter(p=>!equal(p.key,key));return bucket.length?{hash:node.hash,bucket}:null;}
  const side=bit(hash,depth)?'one':'zero',next={...node,[side]:remove(node[side],depth+1)};
  return next.zero||next.one?next:null;
 };
 return new Dictionary(remove(dict.root,0),dict.size-1);
}
export function dictSet(dict,key,value,hash,equal){
  hash>>>=0;const old=pairAt(dict.root,key,hash,equal);
  return new Dictionary(insert(dict.root,{key,value,index:old?.index??dict.size},hash,equal),dict.size+(old?0:1));
}
export const hashMix=(hash,value)=>Math.imul((hash^value)>>>0,16777619)>>>0;
export function hashBytes(bytes){let hash=2166136261;for(const b of bytes)hash=hashMix(hash,b);return hash;}
export const hashText=text=>hashBytes(new TextEncoder().encode(text));
export function scalarHash(value,type){
  if(type==='string')return hashText(value);
  if(type==='bool')return value?1:0;
  if(type==='char')return value.codePointAt(0)>>>0;
  if(type==='byte')return value>>>0;
  if(type==='int'){const bits=BigInt.asUintN(64,BigInt(value));return Number((bits^(bits>>32n))&0xffffffffn);}
  if(type==='float'){const bytes=new ArrayBuffer(8),view=new DataView(bytes);view.setFloat64(0,value===0?0:value,true);return hashBytes(new Uint8Array(bytes));}
  return null;
}
