export const numericTypes=new Set(['int','float','byte']);
export const scalar=(type,value)=>type==='int'?Number(value):{kind:'scalar',type,value};
export const scalarType=v=>typeof v==='number'?'int':v?.kind==='scalar'?v.type:null;
export const scalarValue=v=>v?.kind==='scalar'?v.value:v;
export function numericBinary(op,a,b){
 const type=scalarType(a);if(type==='char'&&scalarType(b)==='char'&&['<','>','<=','>='].includes(op)){const x=a.value.codePointAt(0),y=b.value.codePointAt(0);return op==='<'?x<y:op==='>'?x>y:op==='<='?x<=y:x>=y;}
 if(!numericTypes.has(type)||type!==scalarType(b))throw new Error('Numeric operands must have the same type');
 const x=scalarValue(a),y=scalarValue(b);let r;
 if(op==='^'&&type!=='float'&&y<0)throw new Error('Integer exponent must be nonnegative');
 if(['/', '%'].includes(op)&&y===0)throw new Error('Division by zero');
 switch(op){case '+':r=x+y;break;case '-':r=x-y;break;case '*':r=x*y;break;case '/':r=type==='float'?x/y:Math.trunc(x/y);break;case '%':r=x%y;break;case '^':r=x**y;break;case '<':return x<y;case '>':return x>y;case '<=':return x<=y;case '>=':return x>=y;default:throw new Error('Unknown numeric operator');}
 if(!Number.isFinite(r))throw new Error('Non-finite numeric result');
 if(type==='byte'&&(!Number.isInteger(r)||r<0||r>255))throw new Error('byte overflow');
 return scalar(type,r);
}

export function charText(value){
 const n=value.codePointAt(0),special=new Map([[0,'\\0'],[9,'\\t'],[10,'\\n'],[13,'\\r'],[39,"\\'"],[92,'\\\\']]);
 return "'"+(special.get(n)??(n<32||n===127?'\\u{'+n.toString(16)+'}':value))+"'";
}
