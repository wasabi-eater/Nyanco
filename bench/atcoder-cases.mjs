export const problemIDs = [
 'abc438_e',
 'abc480_a','abc480_b','abc480_c','abc480_d',
 'abc481_a','abc481_b','abc481_c','abc481_d',
 'abc482_c',
 'abc483_e','abc483_e-unpacked',
];
export const problemLimit = id => id==='abc438_e' ? 3000 : id.startsWith('abc483_e') ? 4000 : 2000;

function bucketInput(successors,queries){
 return [`${successors.length} ${queries.length}`,successors.join(' '),...queries.map(q=>q.join(' '))].join('\n')+'\n';
}

function bandInput(size,points,queries){
 return [`${size} ${size} ${points.length} ${queries.length}`,...points.map(p=>p.join(' ')),...queries.map(q=>q.join(' '))].join('\n')+'\n';
}

function typoInput(words){return `${words.length} ${words[0].length}\n${words.join('\n')}\n`;}

function typoPairsByBlock(words){
 // For six letters a qualifying pair agrees on at least one two-letter
 // block. Compare it only in its first such bucket.
 const buckets=Array.from({length:3},()=>Array.from({length:1024},()=>[]));
 const blockMask=1023, lowBits=0x02108421;
 let answer=0;
 for(const word of words){
  let code=0;for(const ch of word)code=(code<<5)|(ch.charCodeAt(0)-97);
  for(let block=0;block<3;block++){
   const bucket=buckets[block][(code>>>(10*block))&blockMask];
   for(const other of bucket){
    const diff=code^other;
    if(block>0&&(diff&blockMask)===0||block>1&&((diff>>>10)&blockMask)===0)continue;
    const flags=(diff|diff>>>1|diff>>>2|diff>>>3|diff>>>4)&lowBits;
    const rest=flags&(flags-1);
    if((rest&(rest-1))===0)answer++;
   }
   bucket.push(code);
  }
 }
 return answer;
}

export function stressCases(id){
 if(id==='abc438_e'){
  const n=200000,queries=Array.from({length:n},(_,i)=>[1000000000-i*4831,i*7919%n+1]);
  const triangular=x=>x*(x+1)/2;
  return [true,false].map(cycle=>{
   const successors=Array.from({length:n},(_,i)=>i+1<n?i+2:cycle?1:n);
   const output=queries.map(([turns,start])=>{
    if(!cycle){
     const before=Math.min(turns,n-start);
     return triangular(start+before-1)-triangular(start-1)+(turns-before)*n;
    }
    const remainder=turns%n, first=Math.min(remainder,n-start+1);
    return Math.floor(turns/n)*triangular(n)+triangular(start+first-1)-triangular(start-1)+triangular(remainder-first);
   }).join('\n')+'\n';
   return {name:cycle?'max-cycle':'max-chain',input:bucketInput(successors,queries),output};
  });
 }
 if(id==='abc482_c'){
  const n=300000,points=Array.from({length:n},(_,i)=>[i+1,n-i]);
  const queries=Array.from({length:n},(_,i)=>{
   const a=i*7919%n+1,b=i*104729%n+1;
   return [i%2+1,Math.min(a,b),Math.max(a,b)];
  });
  return [{name:'max-permutation',input:bandInput(n,points,queries),output:queries.map(([,lo,hi])=>hi-lo+1).join('\n')+'\n'}];
 }
 if(id.startsWith('abc483_e')){
  const n=200000;let seed=0x483;
  const letter=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return 97+(seed>>>0)%26;};
  const random=Array.from({length:n},()=>String.fromCharCode(...Array.from({length:6},letter)));
  const same=Array(n).fill('zzzzzz');
  const clustered=Array.from({length:n},(_,i)=>['aaaaaa','aaaaab','aaaabb','aaabbb'][i%4]);
  // In the clustered case only the first/last groups have distance > 2.
  const allPairs=n*(n-1)/2;
  return [{name:'max-random',input:typoInput(random),output:typoPairsByBlock(random)+'\n'},
   {name:'max-identical',input:typoInput(same),output:allPairs+'\n'},
   {name:'max-clustered',input:typoInput(clustered),output:allPairs-(n/4)**2+'\n'}];
 }
 if(id==='abc480_a')return [{name:'diagonal',input:'DC\nBA\n',output:'No\n'}];
 if(id==='abc481_a')return [{name:'max',input:'9 9\n',output:'2\n'}];
 if(id==='abc481_b'){const a=Array.from({length:100},(_,i)=>i%2?51:49);return [{name:'max-crossings',input:'100 50\n'+a.join(' ')+'\n',output:'99\n'}];}
 if(id==='abc480_b'){
  const names=Array.from({length:100},(_,i)=>'candidate'+String.fromCharCode(97+i%26));
  // Exactly 100 distinct lower-case names of length 10.
  names.forEach((_,i)=>names[i]='votename'+String.fromCharCode(97+Math.floor(i/26),97+i%26));
  const votes=names.map((s,i)=>i%2?s:'x'+s.slice(1)),answer=Array(100).fill(0);
  for(const v of votes){let index=names.indexOf(v);if(index<0){const close=names.map((s,i)=>[s,i]).filter(([s])=>s.length===v.length&&[...s].filter((c,j)=>c!==v[j]).length===1);if(close.length===1)index=close[0][1];}if(index>=0)answer[index]++;}
  return [{name:'max',input:'100 100\n'+names.join('\n')+'\n'+votes.join('\n')+'\n',output:answer.join('\n')+'\n'}];
 }
 if(id==='abc480_c'){
  const n=200000,k=3,t=1000000000,a=Array.from({length:n},(_,i)=>(i*7919)%1000000001),sorted=[...a].sort((a,b)=>a-b);let end=0,answer=0;
  for(const x of sorted){if(x>t)break;if(x>end)answer+=Math.ceil((x-end)/k);end=x+k;}if(t>end)answer+=Math.ceil((t-end)/k);
  return [{name:'max-unsorted',input:`${n} ${k} ${t}\n`+a.join(' ')+'\n',output:answer+'\n'}];
 }
 if(id==='abc481_c'){
  const n=200000,name=i=>{let s='';for(let j=0;j<10;j++){s+=String.fromCharCode(97+i%26);i=Math.floor(i/26);}return s;};
  return [n,100].map(unique=>({name:unique===n?'max-unique':'max-repeated',input:n+'\n'+Array.from({length:n},(_,i)=>name(i%unique)).join('\n')+'\n',output:Array.from({length:n},(_,i)=>i%unique+1).join('\n')+'\n'}));
 }
 if(id==='abc481_d'){
  const n=200000;
  return [{name:'max-chain',input:`${n} ${n} 1 ${n}\n`+Array.from({length:n-1},(_,i)=>`${i+1} ${i+2}`).join('\n')+`\n${n} 1\n`,output:'0\n'},
   {name:'max-star',input:`${n} ${n} 1 ${n}\n`+Array.from({length:n-1},(_,i)=>`1 ${i+2}`).join('\n')+`\n${n} 1\n`,output:'1\n'}];
 }
 if(id==='abc480_d'){
  const n=100000,q=100000,a=Array.from({length:n},(_,i)=>BigInt(i%7===0?-100000000:100000000-i%1000));
  const p=[0n],pp=[0n];for(const x of a)p.push(p.at(-1)+x);for(const x of p)pp.push(pp.at(-1)+x);
  const sum=x=>{let lo=0,hi=n+1;while(lo+1<hi){const mid=Math.floor((lo+hi)/2);if(mid*(mid+1)/2<=x)lo=mid;else hi=mid;}return pp[lo+1]+p[x-lo*(lo+1)/2];};
  const total=n*(n+1)/2,lines=[`${n} ${q}`,a.join(' ')],answers=[];
  for(let i=0;i<q;i++){let l=i*104729%total+1,r=(i*7919+total-1)%total+1;if(l>r)[l,r]=[r,l];lines.push(`${l} ${r}`);answers.push(String(sum(r)-sum(l-1)));}
  return [{name:'max-negative-int64',input:lines.join('\n')+'\n',output:answers.join('\n')+'\n'}];
 }
 return [];
}

export function smallCases(id){
 let seed=123456789;const rnd=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;};
 const out=[],emit=(input,answer)=>out.push({name:'small-'+out.length,input,output:Array.isArray(answer)?answer.join('\n')+'\n':answer+'\n'});
 if(id==='abc438_e'){
  emit(bucketInput([2,1],[[1000000000,1],[999999999,2]]),[1500000000,1499999999]);
  for(let trial=0;trial<20;trial++){
   const n=2+rnd(12),successors=Array.from({length:n},()=>1+rnd(n));
   const queries=Array.from({length:12},()=>[1+rnd(73),1+rnd(n)]);
   emit(bucketInput(successors,queries),queries.map(([turns,start])=>{
    let sum=0,person=start;
    for(let t=0;t<turns;t++){sum+=person;person=successors[person-1];}
    return sum;
   }));
  }
  return out;
 }
 if(id==='abc482_c'){
  for(let trial=0;trial<20;trial++){
   const size=1+rnd(11),points=[];
   for(let r=1;r<=size;r++)for(let c=1;c<=size;c++)if(rnd(9)<3)points.push([r,c]);
   if(!points.length)points.push([1,1]);
   const queries=Array.from({length:14},()=>{
    const a=1+rnd(size),b=1+rnd(size);
    return [1+rnd(2),Math.min(a,b),Math.max(a,b)];
   });
   emit(bandInput(size,points,queries),queries.map(([kind,lo,hi])=>points.filter(p=>lo<=p[kind-1]&&p[kind-1]<=hi).length));
  }
  return out;
 }
 if(id.startsWith('abc483_e')){
  const check=words=>{
   let count=0;
   for(let i=0;i<words.length;i++)for(let j=0;j<i;j++){
    let distance=0;for(let k=0;k<words[i].length;k++)if(words[i][k]!==words[j][k])distance++;
    if(distance<=2)count++;
   }
   emit(typoInput(words),count);
  };
  check(['aaaaaa','aaaaaa','baaaaa','bbaaaa','bbbaaa','bbbbaa','bbbbba','bbbbbb']);
  for(let length=2;length<=6;length++)for(const alphabet of [1,2,3,7,26]){
   check(Array.from({length:2+rnd(20)},()=>Array.from({length},()=>String.fromCharCode(97+(rnd(65521)%alphabet))).join('')));
  }
  return out;
 }
 if(id==='abc480_a'){
  const permute=(prefix,left)=>{if(!left.length){const a=prefix.indexOf('A'),d=prefix.indexOf('D');emit(prefix.slice(0,2)+'\n'+prefix.slice(2)+'\n',Math.abs(Math.floor(a/2)-Math.floor(d/2))+Math.abs(a%2-d%2)===1?'Yes':'No');}else for(const c of left)permute(prefix+c,left.replace(c,''));};permute('','ABCD');return out;
 }
 if(id==='abc481_a'){for(let a=1;a<=9;a++)for(let b=1;b<=9;b++)emit(`${a} ${b}\n`,String(a+b).length);return out;}
 for(let test=0;test<20;test++){
  if(id==='abc480_b'){
   const names=new Set();while(names.size<8){let s='';for(let i=0,n=rnd(4)+1;i<n;i++)s+='abc'[rnd(3)];names.add(s);}const xs=[...names],votes=Array.from({length:10},()=>{let s='';for(let i=0,n=rnd(4)+1;i<n;i++)s+='abc'[rnd(3)];return s;}),answer=xs.map(()=>0);
   for(const vote of votes){let i=xs.indexOf(vote);if(i<0){const near=xs.flatMap((s,j)=>s.length===vote.length&&[...s].filter((c,k)=>c!==vote[k]).length===1?[j]:[]);if(near.length===1)i=near[0];}if(i>=0)answer[i]++;}emit(`8 10\n${xs.join('\n')}\n${votes.join('\n')}\n`,answer);
  }else if(id==='abc480_c'){
   const n=rnd(8)+1,k=rnd(8)+1,t=rnd(30)+1,a=Array.from({length:n},()=>rnd(40)),sorted=[...a].sort((a,b)=>a-b);let end=0,answer=0,i=0;
   while(end<t){while(i<n&&sorted[i]<=end){end=Math.max(end,sorted[i++]+k);}if(end<t){end+=k;answer++;}}
   emit(`${n} ${k} ${t}\n${a.join(' ')}\n`,answer);
  }else if(id==='abc480_d'){
   const n=rnd(9)+1,a=Array.from({length:n},()=>rnd(21)-10),b=[];for(let i=1;i<=n;i++)b.push(...a.slice(0,i));let lines=[`${n} 10`,a.join(' ')],answer=[];for(let q=0;q<10;q++){let l=rnd(b.length),r=rnd(b.length);if(l>r)[l,r]=[r,l];lines.push(`${l+1} ${r+1}`);answer.push(b.slice(l,r+1).reduce((a,b)=>a+b,0));}emit(lines.join('\n')+'\n',answer);
  }else if(id==='abc481_b'){
   const n=rnd(18)+2,k=rnd(10)+1,a=[];while(a.length<n){const x=rnd(10)+1;if(a.at(-1)!==x)a.push(x);}const points=new Set(),gcd=(a,b)=>b?gcd(b,a%b):a;for(let i=0;i<n-1;i++)if(Math.min(a[i],a[i+1])<=k&&k<=Math.max(a[i],a[i+1])){let d=a[i+1]-a[i],p=(i+1)*d+k-a[i];if(d<0){d=-d;p=-p;}const g=gcd(Math.abs(p),d);points.add(`${p/g}/${d/g}`);}emit(`${n} ${k}\n${a.join(' ')}\n`,points.size);
  }else if(id==='abc481_c'){
   const names=Array.from({length:30},()=>['a','b','ab','abc','aa','zzz'][rnd(6)]),ids=new Map(),answer=[];for(const name of names){if(!ids.has(name))ids.set(name,ids.size+1);answer.push(ids.get(name));}emit('30\n'+names.join('\n')+'\n',answer);
  }else if(id==='abc481_d'){
   const n=rnd(10)+2,m=rnd(35)+1,s=rnd(n);let t=rnd(n-1);if(t>=s)t++;const edges=Array.from({length:m},()=>{const a=rnd(n);let b=rnd(n-1);if(b>=a)b++;return [a,b];});const adj=Array.from({length:n},()=>[]);edges.forEach(([a,b])=>adj[a].push(b));const dist=Array(n).fill(Infinity),done=new Set();dist[s]=0;
   for(let i=0;i<n;i++){let u=-1;for(let j=0;j<n;j++)if(!done.has(j)&&(u<0||dist[j]<dist[u]))u=j;if(u<0||dist[u]===Infinity)break;done.add(u);const free=Math.min(...adj[u]);for(const v of adj[u])dist[v]=Math.min(dist[v],dist[u]+(v===free?0:1));}
   emit(`${n} ${m} ${s+1} ${t+1}\n`+edges.map(([a,b])=>`${a+1} ${b+1}`).join('\n')+'\n',dist[t]===Infinity?-1:dist[t]);
  }
 }
 return out;
}
