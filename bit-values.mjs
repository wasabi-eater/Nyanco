import {scalar,scalarType,scalarValue} from './numeric-values.mjs';
export const bitOperators=['.&.','.|.','.<<.','.>>.'];
export const bitFunctions=['xor','testBit','setBit','clearBit'];
export function bitOperation(name,a,b){
 const type=scalarType(a),logical=['.&.','.|.','xor'].includes(name);
 if(typeof a==='boolean'&&typeof b==='boolean'&&logical)return name==='.&.'?a&&b:name==='.|.'?a||b:a!==b;
 if(!['int','byte'].includes(type)||logical&&scalarType(b)!==type||!logical&&scalarType(b)!=='int')throw new Error('Bit operands require int or byte of the same type; positions require int');
 const width=type==='byte'?8:64,x=BigInt(scalarValue(a));let y=BigInt(scalarValue(b)),r;
 if(!logical&&(y<0n||y>=BigInt(width)))throw Object.assign(new Error('Bit position or shift count is outside 0..'+(width-1)),{bitIndex:true});
 switch(name){case '.&.':r=x&y;break;case '.|.':r=x|y;break;case 'xor':r=x^y;break;case '.<<.':r=x<<y;break;case '.>>.':r=(type==='byte'?BigInt.asUintN(8,x):BigInt.asIntN(64,x))>>y;break;case 'testBit':return (x&(1n<<y))!==0n;case 'setBit':r=x|(1n<<y);break;case 'clearBit':r=x&~(1n<<y);break;}
 return scalar(type,Number(type==='byte'?BigInt.asUintN(8,r):BigInt.asIntN(64,r)));
}
