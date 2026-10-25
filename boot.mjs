import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {startBootstrap} from './bootstrap.mjs';

const shellDir=fileURLToPath(new URL('.',import.meta.url));
const json=async file=>JSON.parse(await fs.readFile(file,'utf8'));
let ready,activation,loaded;
async function localFile(root,...parts) {
  let p=root;
  for(const part of parts) {
    p=path.join(p,part);
    if((await fs.lstat(p)).isSymbolicLink())throw Error('private_core_invalid');
  }
  return p;
}
function loadRuntime(input,options,required,pointer,activationUrl){
  if(loaded?.sha===pointer.sha256)return loaded.promise;
  const promise=(async()=>{
    const home=await localFile(path.resolve(input.directory),'kupadesk-runtime');
    if(pointer.format!==1||!Number.isSafeInteger(pointer.sequence)||pointer.sequence<1||
      !/^[a-f0-9]{64}$/.test(pointer.sha256)||!/^[a-f0-9]{64}$/.test(pointer.entrySha256))throw Error('private_core_invalid');
    const file=await localFile(home,'releases',pointer.sha256,'loader-runtime.mjs');
    const data=await fs.readFile(file);
    if(data.length>128*1024||createHash('sha256').update(data).digest('hex')!==pointer.entrySha256)throw Error('private_core_invalid');
    if(required.format!==1||!/^0\.\d+\.\d+$/.test(required.version)||!Number.isSafeInteger(required.sequence)||required.sequence<1)throw Error('loader_target_invalid');
    const module=await import(pathToFileURL(file).href);
    return module.start({input:{...input,kupadeskActivationUrl:activationUrl},options,shellDir,required,pointer});
  })();
  loaded={sha:pointer.sha256,promise};return promise;
}
export function initialize(input,options) {
  ready??=(async()=>{
    if(typeof input?.directory!=='string')throw Error('private_core_missing');
    const required=await json(path.join(shellDir,'target.json'));
    if(required.format!==1||!/^0\.\d+\.\d+$/.test(required.version)||!Number.isSafeInteger(required.sequence)||required.sequence<1)throw Error('loader_target_invalid');
    activation=await startBootstrap(input,shellDir,{onPrepared:async(pointer,url)=>{ready=loadRuntime(input,options,required,pointer,url);await ready;}});
    let pointer;try{const home=await localFile(path.resolve(input.directory),'kupadesk-runtime');pointer=await json(await localFile(home,'current.json'));}catch(e){if(e.code!=='ENOENT')throw e;}
    if(!pointer||pointer.sequence<required.sequence)return {onRequest:body=>body,onResponse:()=>{},stop:()=>activation.stop()};
    return loadRuntime(input,options,required,pointer,activation.url);
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
