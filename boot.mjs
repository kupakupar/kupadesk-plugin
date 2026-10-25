import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {startBootstrap} from './bootstrap.mjs';

const shellDir=fileURLToPath(new URL('.',import.meta.url));
const json=async file=>JSON.parse(await fs.readFile(file,'utf8'));
let ready,activation;
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
    activation=await startBootstrap(input,shellDir);
    const home=await localFile(path.resolve(input.directory),'kupadesk-runtime');
    const required=await json(path.join(shellDir,'target.json'));
    let pointer;try{pointer=await json(await localFile(home,'current.json'));}catch(e){if(e.code!=='ENOENT')throw e;}
    if(!pointer||pointer.sequence<required.sequence)return {onRequest:body=>body,onResponse:()=>{},stop:()=>activation.stop()};
    if(pointer.format!==1||!Number.isSafeInteger(pointer.sequence)||pointer.sequence<1||
      !/^[a-f0-9]{64}$/.test(pointer.sha256)||!/^[a-f0-9]{64}$/.test(pointer.entrySha256))throw Error('private_core_invalid');
    const file=await localFile(home,'releases',pointer.sha256,'loader-runtime.mjs');
    const data=await fs.readFile(file);
    if(data.length>128*1024||createHash('sha256').update(data).digest('hex')!==pointer.entrySha256)throw Error('private_core_invalid');
    if(required.format!==1||!/^0\.\d+\.\d+$/.test(required.version)||!Number.isSafeInteger(required.sequence)||required.sequence<1)throw Error('loader_target_invalid');
    const module=await import(pathToFileURL(file).href);
    return module.start({input:{...input,kupadeskActivationUrl:activation.url},options,shellDir,required,pointer});
  })();
  return ready;
}
export async function request(body,ctx) {
  if(!ready)return body;
  const core=await ready;
  return core.onRequest(body,ctx);
}
export async function response(body,ctx) {
  if(!ready)return;
  const core=await ready;
  return core.onResponse?.(body,ctx);
}
