export const combinationNames=new Set(['permutations','combinations','combinationsWithReplacement','cartesianProduct','powerset']);
export function* selections(xs,k,mode,tick=()=>{}){
 if(k===0){yield [];return;}
 if(!xs.length||mode!=='combinationsWithReplacement'&&k>xs.length)return;
 const indices=[],next=[0];let depth=0;
 while(depth>=0){tick();
  if(depth===k){yield indices.map(i=>xs[i]);depth--;continue;}
  const i=next[depth]++;
  if(i>=xs.length){next.pop();depth--;continue;}
  if(mode==='permutations'&&indices.slice(0,depth).includes(i))continue;
  indices[depth]=i;depth++;next[depth]=mode==='permutations'?0:i+(mode==='combinations'?1:0);
 }
}
