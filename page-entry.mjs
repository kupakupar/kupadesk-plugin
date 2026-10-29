// Public presentation bootstrap only. No license, prompt or device-key logic.
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

export const ENTRY_FILE='entry-035.html',SCRIPT_FILE='entry-035.js';
export const ENTRY_HTML='<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>KupaDesk</title><style>html{color-scheme:light dark}body{font:15px/1.7 system-ui;margin:0;padding:32px;color:CanvasText;background:Canvas}main{max-width:680px;margin:auto}button{font:inherit;padding:8px 16px}#detail{opacity:.75}</style><main><h1>KupaDesk</h1><p id="status" role="status">正在连接本机页面服务…</p><p id="detail">更新期间会自动重试，现有核心、绑定和设置不会被清空。</p><button id="retry" type="button">立即重试</button></main><script src="entry-035.js"></script></html>\n';
export const ENTRY_SCRIPT=String.raw`(() => {
  const status=document.getElementById('status'),retry=document.getElementById('retry');
  let timer,busy=false,stopped=false,attempts=0,script,cancelLoad;
  parent.postMessage({magpie:1,id:'kupa-entry-ready',method:'hello'},'*');
  function readConnection(){
    return new Promise((resolve,reject)=>{
      window.KUPADESK_CONNECTION=undefined;script=document.createElement('script');
      let complete=false;const finish=error=>{if(complete)return;complete=true;clearTimeout(deadline);script?.remove();script=null;cancelLoad=null;error?reject(error):resolve(window.KUPADESK_CONNECTION);};
      const deadline=setTimeout(()=>finish(Error('waiting')),3000);cancelLoad=()=>finish(Error('closed'));
      script.onload=()=>finish();script.onerror=()=>finish(Error('preparing'));
      script.src=new URL('connection.js?check='+Date.now(),location.href).href;document.head.append(script);
    });
  }
  async function connect(){
    if(stopped||busy)return;busy=true;
    try{
      // Magpie 1883 forbids fetch but permits this page's own scripts.
      const value=await readConnection(),url=value?.url;
      if(value?.format!==1||value.entry!==35||typeof url!=='string'||!/^http:\/\/127\.0\.0\.1:\d{1,5}\/kupa-activate\/[a-f0-9]{64}\/view$/.test(url)||Number(new URL(url).port)<1||Number(new URL(url).port)>65535)throw Error('invalid');
      if(stopped)return;location.replace(url);stopped=true;
    }catch{
      attempts++;status.textContent=attempts<5?'本机页面正在准备，完成后会自动打开。':'本机页面服务尚未就绪，正在继续重试。';
    }finally{
      busy=false;clearTimeout(timer);if(!stopped)timer=setTimeout(connect,1500);
    }
  }
  retry.addEventListener('click',()=>{clearTimeout(timer);void connect();});
  addEventListener('pagehide',()=>{stopped=true;clearTimeout(timer);cancelLoad?.();});
  void connect();
})();
`.replaceAll('\\\\','\\');

async function directory(shellDir){
 for(const p of [shellDir,path.join(shellDir,'page')]){
  const st=await fs.lstat(p).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
  if(st&&(st.isSymbolicLink()||!st.isDirectory()))throw Error('page_entry_path');
 }
 await fs.mkdir(path.join(shellDir,'page'),{recursive:true});return path.join(shellDir,'page');
}
async function put(file,text){
 const st=await fs.lstat(file).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
 if(st&&(!st.isFile()||st.isSymbolicLink()))throw Error('page_entry_path');
 if(st&&st.size===Buffer.byteLength(text)&&await fs.readFile(file,'utf8')===text)return;
 const temp=file+'.tmp-'+randomUUID();
 try{await fs.writeFile(temp,text,{flag:'wx',mode:0o600});await fs.rename(temp,file);}
 finally{await fs.unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
}
let lastCleanup=0;
export async function ensureEntry(shellDir){
 const dir=await directory(shellDir);
 await put(path.join(dir,SCRIPT_FILE),ENTRY_SCRIPT);await put(path.join(dir,ENTRY_FILE),ENTRY_HTML);
 if(Date.now()-lastCleanup>3600000){
  lastCleanup=Date.now();
  for(const name of await fs.readdir(dir)){
   if(!/^(?:index\.html|activate\.html|activate\.js|entry-035\.(?:html|js)|connection\.js)\.tmp-[a-f0-9-]{36}$/.test(name))continue;
   const f=path.join(dir,name),st=await fs.lstat(f).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
   if(st?.isFile()&&!st.isSymbolicLink()&&Date.now()-st.mtimeMs>86400000)await fs.unlink(f).catch(e=>{if(e.code!=='ENOENT')throw e;});
  }
 }
}
export async function publishEntry(shellDir,url){
 if(!/^http:\/\/127\.0\.0\.1:\d{1,5}\/kupa-activate\/[a-f0-9]{64}\/page$/.test(url||''))throw Error('page_entry_url');
 await ensureEntry(shellDir);
 await put(path.join(shellDir,'page/connection.js'),'window.KUPADESK_CONNECTION = '+JSON.stringify({format:1,entry:35,url:url.replace(/\/page$/,'/view')})+';\n');
}
