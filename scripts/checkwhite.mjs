import fs from 'fs';
import zlib from 'zlib';
function readPNG(p){
  const buf=fs.readFileSync(p);let off=8,w,h,ct,idat=[];
  while(off<buf.length){const len=buf.readUInt32BE(off);const t=buf.toString('ascii',off+4,off+8);const d=buf.subarray(off+8,off+8+len);
    if(t==='IHDR'){w=d.readUInt32BE(0);h=d.readUInt32BE(4);ct=d[9];}else if(t==='IDAT')idat.push(d);else if(t==='IEND')break;off+=12+len;}
  const raw=zlib.inflateSync(Buffer.concat(idat));
  const ch=ct===6?4:ct===2?3:ct===3?1:4;const st=w*ch;const out=Buffer.alloc(h*st);let pos=0;
  for(let y=0;y<h;y++){const ft=raw[pos++];for(let x=0;x<st;x++){const rb=raw[pos++];const a=x>=ch?out[y*st+x-ch]:0;const b=y>0?out[(y-1)*st+x]:0;const c=(x>=ch&&y>0)?out[(y-1)*st+x-ch]:0;let v;
    switch(ft){case 0:v=rb;break;case 1:v=rb+a;break;case 2:v=rb+b;break;case 3:v=rb+((a+b)>>1);break;
      case 4:{const pp=a+b-c;const pa=Math.abs(pp-a),pb=Math.abs(pp-b),pc=Math.abs(pp-c);const pr=pa<=pb&&pa<=pc?a:pb<=pc?b:c;v=rb+pr;break;}default:v=rb;}out[y*st+x]=v&0xff;}}
  return {w,h,ch,out};
}
for(const p of process.argv.slice(2)){
  const {w,h,ch,out}=readPNG(p);
  let white=0,colored=0,total=w*h;
  for(let i=0;i<total;i++){const o=i*ch;const r=out[o],g=out[o+1],b=out[o+2];
    if(r>238&&g>238&&b>238)white++;
    else if(Math.max(r,g,b)-Math.min(r,g,b)>25||r<210||g<210||b<210)colored++;}
  console.log(p,'=>',w+'x'+h,'white%='+(white/total*100).toFixed(1),'nonWhite%='+(colored/total*100).toFixed(1));
}
