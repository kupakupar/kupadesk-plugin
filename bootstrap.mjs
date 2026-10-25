// The public entry understands only signed bootstrap delivery, not licensing.
import fs from 'node:fs/promises';
import path from 'node:path';
import {webcrypto,createHash,randomUUID} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {pathToFileURL} from 'node:url';
const TRUST={kid:'5adfe035daf51b95',publicKey:'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAERAj6iK17hps+g9geH9eH7I2W8lpUJKFdMXI8WefJ1m0flTZ1giqZCg91DX7N16baUMghkr0vfrmpefHZr5O4cg=='};
const FILES=new Set(['bootstrap-runtime.mjs','activation-ui.js','cloud.mjs','cloud-helper.mjs','managed-prompt.js','license.mjs','license-index.js','loader-worker.mjs','plugin-update.mjs','update-trust.mjs','package.json']);
const sha=b=>createHash('sha256').update(b).digest('hex');
export async function verifyBootstrap(value,trust=TRUST){
 const s=value?.signature;
 if(!s||s.format!==1||s.alg!=='ES256'||s.kid!==trust.kid||typeof s.payload!=='string'||s.payload.length>4096)throw Error('bootstrap_signature');
 const key=await webcrypto.subtle.importKey('spki',Buffer.from(trust.publicKey,'base64'),{name:'ECDSA',namedCurve:'P-256'},false,['verify']);
 if(!await webcrypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},key,Buffer.from(s.signature||'','base64'),Buffer.from('KupaDesk/receipt/v1\n'+s.payload)))throw Error('bootstrap_signature');
 const m=JSON.parse(s.payload),raw=Buffer.from(value.archive||'','base64');
 if(m.format!==1||m.audience!=='kupadesk-bootstrap'||m.purpose!=='activation-helper'||m.sequence!==20||m.version!=='0.0.20'||!Number.isSafeInteger(m.bytes)||m.bytes<1||raw.length!==m.bytes||raw.length>320*1024||sha(raw)!==m.sha256)throw Error('bootstrap_hash');
 const b=JSON.parse(gunzipSync(raw,{maxOutputLength:1024*1024}));
 if(b.format!==1||!Array.isArray(b.files)||b.files.length!==FILES.size)throw Error('bootstrap_files');
 const seen=new Set();let bytes=0;
 for(const f of b.files){const data=Buffer.from(f.data||'','base64');if(!FILES.has(f.path)||seen.has(f.path)||sha(data)!==f.sha256||(bytes+=data.length)>1024*1024)throw Error('bootstrap_file');seen.add(f.path);}
 return {meta:m,files:b.files};
}
async function atomic(file,data){await fs.mkdir(path.dirname(file),{recursive:true});const tmp=file+'.'+randomUUID();try{await fs.writeFile(tmp,data,{flag:'wx',mode:0o600});await fs.rename(tmp,file);}finally{await fs.unlink(tmp).catch(e=>{if(e.code!=='ENOENT')throw e;});}}
async function noLinks(root,parts){let p=root;for(const part of parts){p=path.join(p,part);try{if((await fs.lstat(p)).isSymbolicLink())throw Error('bootstrap_symlink');}catch(e){if(e.code!=='ENOENT')throw e;}}}
export async function startBootstrap(input,shellDir,{origin='https://kupakupa.vip',trust=TRUST,fetchImpl=fetch,native,coreTrust}={}){
 const home=path.join(input.directory,'kupadesk-bootstrap');await noLinks(input.directory,['kupadesk-bootstrap']);
 let signed;
 try{signed=JSON.parse(await fs.readFile(path.join(home,'signed.json'),'utf8'));await verifyBootstrap(signed,trust);}
 catch{const r=await fetchImpl(origin+'/api/v1/catalog?resource=magpie-bootstrap',{method:'POST',headers:{'content-type':'application/json'},body:'{}',redirect:'error',signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('bootstrap_unavailable');const text=await r.text();if(text.length>512*1024)throw Error('bootstrap_size');signed=JSON.parse(text);await verifyBootstrap(signed,trust);await atomic(path.join(home,'signed.json'),JSON.stringify(signed));}
 const {meta,files}=await verifyBootstrap(signed,trust),folder=path.join(home,meta.sha256);
 await noLinks(home,[meta.sha256]);await fs.mkdir(folder,{recursive:true});
 for(const f of files){await noLinks(folder,[f.path]);const file=path.join(folder,f.path),b=Buffer.from(f.data,'base64');try{if(sha(await fs.readFile(file))===f.sha256)continue;}catch(e){if(e.code!=='ENOENT')throw e;}await atomic(file,b);}
 const helper=await import(pathToFileURL(path.join(folder,'bootstrap-runtime.mjs')).href);
 return helper.start({directory:input.directory,shellDir,required:JSON.parse(await fs.readFile(path.join(shellDir,'target.json'),'utf8')),origin,...(native?{native}:{}),...(coreTrust?{trust:coreTrust}:{})});
}
