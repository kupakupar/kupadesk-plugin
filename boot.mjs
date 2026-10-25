import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {startBootstrap} from './bootstrap.mjs';

const shellDir=fileURLToPath(new URL('.',import.meta.url));
const json=async file=>JSON.parse(await fs.readFile(file,'utf8'));
let ready,activation,loaded;
function followMiddleware(input,core){
  let last,checking=false,stopped=false,warned=false;
  async function refresh(){
    if(stopped||checking)return;checking=true;
    try{
      const source=await localFile(shellDir,'.runtime','kupadesk.middleware.js');
      const target=await localFile(shellDir,'kupadesk.middleware.js');
      const stat=await fs.stat(source),stamp=stat.mtimeMs+':'+stat.size;
      if(stamp===last)return;
      // The host watches the public entry, not its imported private module.
      // Reflect generated-index changes without touching plugin options.
      if(await fs.readFile(target,'utf8')!=="export {onRequest} from './.runtime/kupadesk.middleware.js';\n")return;
      const now=new Date();await fs.utimes(target,now,now);last=stamp;
    }catch{
      if(!warned){warned=true;try{void input?.client?.app?.log?.({body:{service:'kupadesk-loader',level:'warn',message:'middleware_freshness_unavailable'}})?.catch?.(()=>{});}catch{}}
    }finally{checking=false;}
  }
  const timer=setInterval(()=>void refresh(),250);timer.unref?.();void refresh();
  return {async onRequest(body,ctx){const result=await core.onRequest(body,ctx);await refresh();return result;},onResponse:core.onResponse,
    stop(){stopped=true;clearInterval(timer);core.stop?.();}};
}
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
    const core=await module.start({input:{...input,kupadeskActivationUrl:activationUrl},options,shellDir,required,pointer});
    return followMiddleware(input,core);
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
