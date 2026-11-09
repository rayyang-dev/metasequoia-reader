import fs from 'fs';
import zlib from 'zlib';
import path from 'path';
import { fileURLToPath } from 'url';

function crc32(buf){let c=~0;for(let i=0;i<buf.length;i++){c^=buf[i];for(let k=0;k<8;k++)c=(c>>>1)^(0xEDB88320&-(c&1));}return ~c;}

function readPNG(p){
  const buf=fs.readFileSync(p);
  let off=8,width,height,bitDepth,colorType,idat=[],plte=null,trns=null;
  while(off<buf.length){
    const len=buf.readUInt32BE(off); const type=buf.toString('ascii',off+4,off+8);
    const data=buf.subarray(off+8,off+8+len);
    if(type==='IHDR'){width=data.readUInt32BE(0);height=data.readUInt32BE(4);bitDepth=data[8];colorType=data[9];}
    else if(type==='IDAT'){idat.push(data);}
    else if(type==='PLTE'){plte=data;}
    else if(type==='tRNS'){trns=data;}
    else if(type==='IEND'){break;}
    off+=12+len;
  }
  const raw=zlib.inflateSync(Buffer.concat(idat));
  const ch = colorType===6?4:colorType===4?2:colorType===2?3:colorType===3?1:colorType===0?1:3;
  const stride=width*ch;
  const out=Buffer.alloc(height*stride);
  let pos=0;
  for(let y=0;y<height;y++){
    const ft=raw[pos++];
    for(let x=0;x<stride;x++){
      const rb=raw[pos++];
      const a=x>=ch?out[y*stride+x-ch]:0;
      const b=y>0?out[(y-1)*stride+x]:0;
      const c=(x>=ch&&y>0)?out[(y-1)*stride+x-ch]:0;
      let v;
      switch(ft){case 0:v=rb;break;case 1:v=rb+a;break;case 2:v=rb+b;break;case 3:v=rb+((a+b)>>1);break;
        case 4:{const pp=a+b-c;const pa=Math.abs(pp-a),pb=Math.abs(pp-b),pc=Math.abs(pp-c);const pr=pa<=pb&&pa<=pc?a:pb<=pc?b:c;v=rb+pr;break;}
        default:v=rb;}
      out[y*stride+x]=v&0xff;
    }
  }
  const rgba=Buffer.alloc(width*height*4);
  for(let i=0;i<width*height;i++){
    let r,g,b,al=255;
    if(colorType===6){r=out[i*4];g=out[i*4+1];b=out[i*4+2];al=out[i*4+3];}
    else if(colorType===2){r=out[i*3];g=out[i*3+1];b=out[i*3+2];}
    else if(colorType===3){const idx=out[i];r=plte[idx*3];g=plte[idx*3+1];b=plte[idx*3+2];if(trns&&idx<trns.length)al=trns[idx];}
    else if(colorType===0){const v=out[i];r=g=b=v;}
    else if(colorType===4){const v=out[i*2];al=out[i*2+1];r=g=b=v;}
    rgba[i*4]=r;rgba[i*4+1]=g;rgba[i*4+2]=b;rgba[i*4+3]=al;
  }
  return {width,height,rgba};
}

function writePNG(p,{width,height,rgba}){
  const stride=width*4;
  const raw=Buffer.alloc(height*(stride+1));
  let pos=0;
  for(let y=0;y<height;y++){raw[pos++]=0;for(let x=0;x<stride;x++)raw[pos++]=rgba[y*stride+x];}
  const comp=zlib.deflateSync(raw);
  const chunk=(type,data)=>{const len=Buffer.alloc(4);len.writeUInt32BE(data.length);const t=Buffer.from(type,'ascii');const crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(Buffer.concat([t,data]))>>>0);return Buffer.concat([len,t,data,crc]);};
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width,0);ihdr.writeUInt32BE(height,4);ihdr[8]=8;ihdr[9]=6;
  const sig=Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
  fs.writeFileSync(p,Buffer.concat([sig,chunk('IHDR',ihdr),chunk('IDAT',comp),chunk('IEND',Buffer.alloc(0))]));
}

const base=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../android/app/src/main/res');
const dens=['mdpi','hdpi','xhdpi','xxhdpi','xxxhdpi'];
const RED=[0xa8,0x1f,0x1f];

for(const d of dens){
  const src=path.join(base,`mipmap-${d}`,'ic_launcher.png');
  if(!fs.existsSync(src)){console.log('skip',d);continue;}
  const {width,height,rgba}=readPNG(src);
  const cx=width/2, cy=height/2, r=Math.min(width,height)/2 - 2;

  // 1) square: full-bleed opaque (fill transparent corner pixels with red)
  const sq=Buffer.from(rgba);
  for(let i=0;i<width*height;i++){
    const o=i*4;
    if(sq[o+3]<255){ sq[o]=RED[0]; sq[o+1]=RED[1]; sq[o+2]=RED[2]; sq[o+3]=255; }
  }
  const sqPath=path.join(base,`mipmap-${d}`,'ic_launcher.png');
  writePNG(sqPath,{width,height,rgba:sq});

  // 2) round: true red circle (transparent outside inscribed circle)
  const rd=Buffer.from(rgba);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const o=(y*width+x)*4;
    const dx=x-cx+0.5, dy=y-cy+0.5;
    if(Math.sqrt(dx*dx+dy*dy) > r-0.5) rd[o+3]=0;
  }
  const rdPath=path.join(base,`mipmap-${d}`,'ic_launcher_round.png');
  writePNG(rdPath,{width,height,rgba:rd});
  console.log(`regenerated ${d}: square=${width}x${height} (opaque full-bleed), round=red circle`);
}
console.log('DONE');
