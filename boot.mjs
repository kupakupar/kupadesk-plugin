import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL,fileURLToPath} from 'node:url';

const shellDir=fileURLToPath(new URL('.',import.meta.url));
const json=async file=>JSON.parse(await fs.readFile(file,'utf8'));
let ready;
async function localFile(root,...parts) {
  let p=root;
  for(const part of parts) {
    p=path.join(p,part);
    if((await fs.lstat(p)).isSymbolicLink())throw Error('private_core_invalid');
  }
  return p;
}
export function initialize(input,options) {
  ready??=(async()=>{
    if(typeof input?.directory!=='string')throw Error('private_core_missing');
    const home=await localFile(path.resolve(input.directory),'kupadesk-runtime');
    const pointer=await json(await localFile(home,'current.json'));
    if(pointer.format!==1||!Number.isSafeInteger(pointer.sequence)||pointer.sequence<1||
      !/^[a-f0-9]{64}$/.test(pointer.sha256)||!/^[a-f0-9]{64}$/.test(pointer.entrySha256))throw Error('private_core_invalid');
    const file=await localFile(home,'releases',pointer.sha256,'loader-runtime.mjs');
    const data=await fs.readFile(file);
    if(data.length>128*1024||createHash('sha256').update(data).digest('hex')!==pointer.entrySha256)throw Error('private_core_invalid');
    const required=await json(path.join(shellDir,'target.json'));
    if(required.format!==1||!/^0\.\d+\.\d+$/.test(required.version)||!Number.isSafeInteger(required.sequence)||required.sequence<1)throw Error('loader_target_invalid');
    const module=await import(pathToFileURL(file).href);
    return module.start({input,options,shellDir,required,pointer});
  })();
  return ready;
}
export async function request(body,ctx) {
  if(!ready)throw Error('KupaDesk：私有核心尚未就绪。');
  const core=await ready;
  return core.onRequest(body,ctx);
}
export async function response(body,ctx) {
  if(!ready)return;
  const core=await ready;
  return core.onResponse?.(body,ctx);
}
