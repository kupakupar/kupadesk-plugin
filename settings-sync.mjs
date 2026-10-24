import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash, createDecipheriv, pbkdf2, randomBytes} from 'node:crypto';
import {promisify} from 'node:util';

const derive=promisify(pbkdf2);
const LIMIT=64*1024;
const SAVE_SPEC='github:kupakupar/kupadesk-plugin';
const object=x=>x&&typeof x==='object'&&!Array.isArray(x);
const canonical=x=>JSON.stringify(sort(x));
function sort(x){return Array.isArray(x)?x.map(sort):object(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,sort(x[k])])):x;}
const hash=x=>createHash('sha256').update(typeof x==='string'||Buffer.isBuffer(x)?x:canonical(x)).digest('hex');
const same=(a,b)=>canonical(a)===canonical(b);
const copy=x=>x===undefined?undefined:structuredClone(x);
export const portableKupa=spec=>typeof spec==='string'&&( /^kupadesk(?:@|$)/i.test(spec) || /^(?:github:kupakupar\/kupadesk-plugin|https:\/\/github\.com\/kupakupar\/kupadesk-plugin(?:\.git)?|git\+https:\/\/github\.com\/kupakupar\/kupadesk-plugin(?:\.git)?)(?:#.*)?$/i.test(spec) );

export async function openBackup(raw, passphrase) {
  const e=JSON.parse(raw.toString('utf8').replace(/^\uFEFF/,''));
  if(e.format!=='magpie-backup'||e.version!==1||e.kdf!=='pbkdf2-sha256'||
    !Number.isSafeInteger(e.iterations)||e.iterations<100000||e.iterations>10000000)throw Error('backup_unsupported');
  const salt=Buffer.from(e.salt,'base64'),nonce=Buffer.from(e.nonce,'base64'),data=Buffer.from(e.data,'base64');
  if(salt.length<16||nonce.length!==12||data.length<16)throw Error('backup_invalid');
  const key=await derive(passphrase,salt,e.iterations,32,'sha256');
  try {
    const cipher=createDecipheriv('aes-256-gcm',key,nonce);
    cipher.setAAD(Buffer.from(`${e.format}/${e.version}/${e.kdf}/${e.iterations}/${salt.toString('hex')}`));
    cipher.setAuthTag(data.subarray(-16));
    return JSON.parse(Buffer.concat([cipher.update(data.subarray(0,-16)),cipher.final()]).toString('utf8'));
  } finally {key.fill(0);}
}

// Three-way merge: unrelated edits combine; concurrent edits to the same
// prompt retain an inactive, unbound copy instead of overwriting either one.
export function mergeSettings(local={},remote={},base) {
  const L=object(local)?local:{},R=object(remote)?remote:{},B=object(base)?base:{};
  const out={...copy(R),...copy(L)};
  const initial=base===undefined;
  const preferRemote=initial&&!(L.bindings||[]).length&&(R.bindings||[]).length>0;
  for(const key of new Set([...Object.keys(L),...Object.keys(R)])) {
    if(key==='bindings')continue;
    if(preferRemote||!initial&&same(L[key],B[key])) {
      if(R[key]===undefined)delete out[key];else out[key]=copy(R[key]);
    }
  }
  const lm=new Map((L.bindings||[]).map(x=>[x.id,x])),rm=new Map((R.bindings||[]).map(x=>[x.id,x])),bm=new Map((B.bindings||[]).map(x=>[x.id,x]));
  const bindings=[],ids=new Set(),conflicts=[];
  const add=x=>{if(x&&!ids.has(x.id)){bindings.push(copy(x));ids.add(x.id);}};
  for(const id of new Set([...lm.keys(),...rm.keys(),...bm.keys()])) {
    const l=lm.get(id),r=rm.get(id),b=bm.get(id);
    if(same(l,r)||!initial&&same(r,b)){add(l);continue;}
    if(!initial&&same(l,b)){add(r);continue;}
    if(initial&&(!l||!r)){add(l||r);continue;}
    add(l);
    if(r) {
      const conflictId='conflict-'+hash([id,r]).slice(0,24);
      add({...r,id:conflictId,name:(r.name||'提示词').slice(0,65)+'（同步保留副本）',enabled:false,models:[]});
      conflicts.push(id);
    }
  }
  // A model remains bound to one active prompt. Preserve the other prompt's
  // full text in a disabled copy if distinct new prompts chose the same model.
  const used=new Set();
  for(const b of bindings) {
    if(b.enabled===false)continue;
    if((b.models||[]).some(m=>used.has(m))){b.enabled=false;b.models=[];conflicts.push(b.id);continue;}
    for(const m of b.models||[])used.add(m);
  }
  out.schemaVersion=1;out.bindings=bindings;
  if(Buffer.byteLength(JSON.stringify({spec:SAVE_SPEC,options:out}))>LIMIT)throw Error('settings_merge_too_large');
  return {options:out,conflicts};
}

async function read(file,limit=64*1024*1024){const st=await fs.stat(file);if(st.size>limit)throw Error('sync_file_too_large');return fs.readFile(file);}
const json=async file=>JSON.parse((await read(file)).toString('utf8').replace(/^\uFEFF/,''));
async function atomic(file,data){await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});const tmp=file+'.'+process.pid+'.'+randomBytes(6).toString('hex')+'.tmp';try{await fs.writeFile(tmp,JSON.stringify(data,null,2)+'\n',{flag:'wx',mode:0o600});await fs.rename(tmp,file);}finally{await fs.unlink(tmp).catch(()=>{});}}
function scope(c){let key=c.url||'';if(c.endpoint)key+='\0'+c.endpoint;if(key.startsWith('github://'))key+='\0'+(c.branch||'');return hash(key+'\0'+(c.user||'')+'\0'+c.passphrase);}

export class SettingsSync {
  constructor({directory,log=()=>{}}){this.directory=directory;this.log=log;this.stateDir=path.join(directory,'kupadesk-private-sync');this.memo={};}
  async tick(){
    if(this.busy)return;this.busy=true;
    try {
      const c=await json(path.join(this.directory,'sync.json'));
      if(typeof c.passphrase!=='string'||!c.passphrase)return;
      const st=await json(path.join(this.directory,'sync-state.json'));
      const ownScope=scope(c);
      if(st.key!==ownScope)return;
      const raw=await read(path.join(this.directory,'sync-server.magpie-backup'));
      const fingerprint=hash(raw);
      if(st.sum&&st.sum!==fingerprint)return; // Only the official, fully read/written server copy.
      if(this.memo.fingerprint!==fingerprint||this.memo.scope!==ownScope){
        this.memo={fingerprint,scope:ownScope,bundle:await openBackup(raw,c.passphrase)};
      }
      const entries=this.memo.bundle.plugins;
      if(!Array.isArray(entries))return;
      const remotes=entries.filter(x=>portableKupa(x.spec)&&object(x.options));
      if(!remotes.length)return;
      let remote=remotes[0].options;
      for(const e of remotes.slice(1))remote=mergeSettings(remote,e.options).options;
      const file=path.join(this.directory,'plugins.json'),before=await read(file,16*1024*1024),doc=JSON.parse(before.toString('utf8'));
      const target=doc.plugins?.find(x=>portableKupa(x.spec));
      if(!target||target.off)return;
      let previous;
      try{previous=await json(path.join(this.stateDir,'state.json'));}catch{}
      const base=previous?.scope===ownScope?previous.base:undefined;
      const {options,conflicts}=mergeSettings(target.options||{},remote,base);
      if(!same(options,target.options||{})){
        if(!(await fs.readFile(file)).equals(before))throw Error('settings_changed_retry');
        await fs.mkdir(path.join(this.stateDir,'backups'),{recursive:true,mode:0o700});
        await fs.writeFile(path.join(this.stateDir,'backups',Date.now()+'-'+randomBytes(4).toString('hex')+'.json'),before,{flag:'wx',mode:0o600});
        target.options=options;
        if(!(await fs.readFile(file)).equals(before))throw Error('settings_changed_retry');
        await atomic(file,doc);
      }
      const next={scope:ownScope,base:remote};
      if(!previous||!same(previous,next))await atomic(path.join(this.stateDir,'state.json'),next);
      await this.status({code:conflicts.length?'merged_conflicts_preserved':'synced',bindings:options.bindings.length,conflicts:conflicts.length});
    }catch(error){
      if(error.code!=='ENOENT'){
        await this.status({code:error.message==='settings_merge_too_large'?'settings_merge_too_large':'settings_sync_waiting'}).catch(()=>{});
      }
    }finally{this.busy=false;}
  }
  async status(value){if(same(value,this.lastStatus))return;this.lastStatus=value;await atomic(path.join(this.stateDir,'status.json'),{...value,at:new Date().toISOString()});}
  start(){void this.tick();this.timer=setInterval(()=>{void this.tick();},10000);this.timer.unref?.();return this;}
  stop(){clearInterval(this.timer);}
}
const active=new Map();
export function startSettingsSync(options){if(!options?.directory)return;const key=path.resolve(options.directory);if(!active.has(key))active.set(key,new SettingsSync(options).start());return active.get(key);}
