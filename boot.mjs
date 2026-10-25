import fs from 'node:fs/promises';
import fsEvents from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {startBootstrap} from './bootstrap.mjs';

const shellDir=fileURLToPath(new URL('.',import.meta.url));
const json=async file=>JSON.parse(await fs.readFile(file,'utf8'));
let context,required,initializing,loaded,activation,startingHelper,retryTimer;
function warn(code){try{void context?.input?.client?.app?.log?.({body:{service:'kupadesk-loader',level:'warn',message:code}})?.catch?.(()=>{});}catch{}}
function observeMiddleware(core){
  let watcher,retry,notificationRetry,closed=false,updating=false,again=false;
  async function refresh(){
    if(closed)return;if(updating){again=true;return;}updating=true;
    try{
      const file=await localFile(shellDir,'kupadesk.middleware.js');
      if(await fs.readFile(file,'utf8')!=="export {onRequest} from './.runtime/kupadesk.middleware.js';\n")return;
      const stat=await fs.stat(file),date=new Date(Math.max(Date.now(),stat.mtimeMs+2));await fs.utimes(file,date,date);
    }catch{warn('middleware_notification_failed');if(!closed&&!notificationRetry){notificationRetry=setTimeout(()=>{notificationRetry=null;void refresh();},1000);notificationRetry.unref?.();}}
    finally{updating=false;if(again){again=false;void refresh();}}
  }
  function watch(){
    if(closed)return;
    try{
      const handle=fsEvents.watch(path.join(shellDir,'.runtime'),{persistent:false},(_event,name)=>{if(name==null||String(name)==='kupadesk.middleware.js')void refresh();});watcher=handle;
      handle.on('error',()=>{if(watcher!==handle)return;handle.close();watcher=null;warn('middleware_notification_failed');retry=setTimeout(watch,1000);retry.unref?.();});
      void refresh();
    }catch{warn('middleware_notification_failed');retry=setTimeout(watch,1000);retry.unref?.();}
  }
  watch();
  return {...core,stop(){closed=true;clearTimeout(retry);clearTimeout(notificationRetry);watcher?.close();core.stop?.();}};
}
async function localFile(root,...parts){
  let file=root;
  for(const part of parts){file=path.join(file,part);if((await fs.lstat(file)).isSymbolicLink())throw Error('private_core_invalid');}
  return file;
}
function loadRuntime(pointer,url){
  if(loaded?.sha===pointer.sha256){
    if(url)void loaded.promise.then(core=>core.setActivationUrl?.(url)).catch(()=>{});
    return loaded.promise;
  }
  const promise=(async()=>{
    const home=await localFile(path.resolve(context.input.directory),'kupadesk-runtime');
    if(pointer.format!==1||!Number.isSafeInteger(pointer.sequence)||pointer.sequence<1||
      !/^[a-f0-9]{64}$/.test(pointer.sha256)||!/^[a-f0-9]{64}$/.test(pointer.entrySha256))throw Error('private_core_invalid');
    const file=await localFile(home,'releases',pointer.sha256,'loader-runtime.mjs'),data=await fs.readFile(file,'utf8');
    if(Buffer.byteLength(data)>128*1024||createHash('sha256').update(data).digest('hex')!==pointer.entrySha256)throw Error('private_core_invalid');
    const module=await import(pathToFileURL(file).href);
    const core=await module.start({input:{...context.input,kupadeskActivationUrl:url},options:context.options,shellDir,required,pointer});
    return observeMiddleware(core);
  })();
  loaded={sha:pointer.sha256,promise};
  void promise.catch(()=>{if(loaded?.promise===promise)loaded=null;});
  return promise;
}
function startHelper(){
  if(activation||startingHelper)return startingHelper;
  clearTimeout(retryTimer);
  startingHelper=startBootstrap(context.input,shellDir,{onPrepared:(pointer,url)=>loadRuntime(pointer,url)})
    .then(async helper=>{activation=helper;const core=loaded?await loaded.promise:null;core?.setActivationUrl?.(helper.url);})
    .catch(()=>{warn('activation_helper_unavailable');retryTimer=setTimeout(()=>void startHelper(),3000);retryTimer.unref?.();})
    .finally(()=>{startingHelper=null;});
  return startingHelper;
}
export function initialize(input,options={}){
  context={input,options};
  initializing??=(async()=>{
    if(typeof input?.directory!=='string')throw Error('private_core_missing');
    required=await json(path.join(shellDir,'target.json'));
    if(required.format!==1||!/^0\.\d+\.\d+$/.test(required.version)||!Number.isSafeInteger(required.sequence)||required.sequence<1)throw Error('loader_target_invalid');
    // A verified local runtime must not depend on an optional UI service.
    void startHelper();
    let pointer;
    try{const home=await localFile(path.resolve(input.directory),'kupadesk-runtime');pointer=await json(await localFile(home,'current.json'));}
    catch(error){if(error.code!=='ENOENT')throw error;}
    if(pointer)return loadRuntime(pointer,activation?.url);
    return null;
  })();
  const current=initializing;
  void current.catch(()=>{if(initializing===current)initializing=null;});
  return current;
}
async function runtime(){
  if(loaded)return loaded.promise;
  if(!context)return null;
  // Absence is cached. Preparation callbacks or a host reload supply the core.
  return initialize(context.input,context.options);
}
export async function request(body,ctx){const core=await runtime();return core?core.onRequest(body,ctx):body;}
export async function response(body,ctx){const core=await runtime();return core?.onResponse?.(body,ctx);}
