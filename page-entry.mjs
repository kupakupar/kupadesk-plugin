// Public presentation bootstrap only. No license, prompt or device-key logic.
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {chromePage,THEME_SCRIPT} from './ui-chrome.mjs';

export const ENTRY_FILE='entry-036.html',SCRIPT_FILE='entry-036.js';
export const ENTRY_HTML=chromePage({subtitle:'正在连接本机页面',content:'<h2>正在准备 KupaDesk</h2><p id="status" class="kupa-status" role="status" aria-live="polite">本机页面服务正在准备。</p><p id="detail" class="field-help">若停留在此页，请稍后点击 Magpie 顶部刷新，再打开 KupaDesk。现有核心、绑定和设置不会被清空。</p><div class="kupa-actions"><button class="button button-primary" id="retry" type="button" hidden>重试连接</button></div>',script:'entry-036.js'})+'\n';
function validView(url){const m=typeof url==='string'&&/^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/kupa-activate\/[a-f0-9]{64}\/view$/.exec(url);return !!m&&Number(m[1])<=65535;}
export function readyHTML(url){
 if(!validView(url))throw Error('page_entry_url');
 // Navigation works in the native opaque sandbox, where Wails virtual-host
 // subresources cannot be loaded. Do not depend on entry JS for this hop.
 return chromePage({head:'<meta http-equiv="refresh" content="0;url='+url+'">',subtitle:'正在进入核心库',content:'<h2>准备就绪</h2><p class="kupa-status" role="status">正在打开 KupaDesk…</p><div class="kupa-actions"><a class="button button-primary" href="'+url+'">打开 KupaDesk</a></div><p id="detail" class="field-help">若未打开，请使用 Magpie 顶部刷新。</p>'})+'\n';
}
export const ENTRY_SCRIPT=THEME_SCRIPT+'\n'+String.raw`(() => {
  const status=document.getElementById('status'),retry=document.getElementById('retry');
  retry.hidden=false;
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
      // Web-mode fallback only. Native startup uses the prepared HTML hop.
      const value=await readConnection(),url=value?.url;
      if(value?.format!==1||value.entry!==36||typeof url!=='string'||!/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/kupa-activate\/[a-f0-9]{64}\/view$/.test(url)||Number(new URL(url).port)>65535)throw Error('invalid');
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
const queues=new Map();
function serialized(shellDir,fn){
 const key=path.resolve(shellDir),prev=queues.get(key)||Promise.resolve();
 const next=prev.catch(()=>{}).then(fn);queues.set(key,next);
 void next.finally(()=>{if(queues.get(key)===next)queues.delete(key);}).catch(()=>{});
 return next;
}
async function savedView(dir){
 const file=path.join(dir,'connection.js'),st=await fs.lstat(file).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
 if(!st)return null;
 if(!st.isFile()||st.isSymbolicLink())throw Error('page_entry_path');
 if(st.size>1024)return null;
 const text=await fs.readFile(file,'utf8'),match=/^window\.KUPADESK_CONNECTION = (\{[^\r\n]+\});\r?\n?$/.exec(text);
 try{const value=JSON.parse(match?.[1]||'null');return value?.format===1&&[35,36].includes(value.entry)&&validView(value.url)?value.url:null;}catch{return null;}
}
async function ensure(shellDir,url){
 const dir=await directory(shellDir);
 const view=url||await savedView(dir);
 if(view)await put(path.join(dir,'connection.js'),'window.KUPADESK_CONNECTION = '+JSON.stringify({format:1,entry:36,url:view})+';\n');
 await put(path.join(dir,SCRIPT_FILE),ENTRY_SCRIPT);await put(path.join(dir,ENTRY_FILE),view?readyHTML(view):ENTRY_HTML);
 if(Date.now()-lastCleanup>3600000){
  lastCleanup=Date.now();
  for(const name of await fs.readdir(dir)){
   if(!/^(?:index\.html|activate\.html|activate\.js|entry-03[56]\.(?:html|js)|connection\.js)\.tmp-[a-f0-9-]{36}$/.test(name))continue;
   const f=path.join(dir,name),st=await fs.lstat(f).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
   if(st?.isFile()&&!st.isSymbolicLink()&&Date.now()-st.mtimeMs>86400000)await fs.unlink(f).catch(e=>{if(e.code!=='ENOENT')throw e;});
  }
 }
}
export function ensureEntry(shellDir){return serialized(shellDir,()=>ensure(shellDir));}
export async function publishEntry(shellDir,url){
 if(typeof url!=='string'||!url.endsWith('/page'))throw Error('page_entry_url');
 const view=url.replace(/\/page$/,'/view');if(!validView(view))throw Error('page_entry_url');
 return serialized(shellDir,()=>ensure(shellDir,view));
}
