import {test,expect} from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createCipheriv,pbkdf2Sync,createHash} from 'node:crypto';
import {mergeSettings,openBackup,SettingsSync,portableKupa} from '../settings-sync.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');
const write=async(f,x)=>fs.writeFile(f,JSON.stringify(x));
const read=async f=>JSON.parse(await fs.readFile(f,'utf8'));
const binding=(id,prompt,model=id)=>({id,name:id,prompt,enabled:true,models:[model],chatRole:'auto'});
const options=bindings=>({schemaVersion:1,enabled:true,bindings});
function seal(bundle,pass='fixture-pass'){
 const salt=Buffer.alloc(16,1),nonce=Buffer.alloc(12,2),iterations=100000;
 const cipher=createCipheriv('aes-256-gcm',pbkdf2Sync(pass,salt,iterations,32,'sha256'),nonce);
 cipher.setAAD(Buffer.from(`magpie-backup/1/pbkdf2-sha256/${iterations}/${salt.toString('hex')}`));
 const data=Buffer.concat([cipher.update(JSON.stringify(bundle)),cipher.final(),cipher.getAuthTag()]);
 return Buffer.from(JSON.stringify({format:'magpie-backup',version:1,kdf:'pbkdf2-sha256',iterations,salt:salt.toString('base64'),nonce:nonce.toString('base64'),data:data.toString('base64')}));
}
test('authenticated official backup decrypts and rejects a changed payload or password',async()=>{
 const raw=seal({plugins:[{spec:'kupadesk@fixture',options:options([binding('a','private fixture')])}]});
 expect((await openBackup(raw,'fixture-pass')).plugins[0].options.bindings.length).toBe(1);
 expect(openBackup(raw,'wrong-pass')).rejects.toThrow();
 const changed=JSON.parse(raw);changed.data=Buffer.from('tampered fixture payload and auth tag').toString('base64');
 expect(openBackup(Buffer.from(JSON.stringify(changed)),'fixture-pass')).rejects.toThrow();
});
test('initial empty destination imports all prompts; empty cloud does not erase existing local prompts',()=>{
 const a=options([binding('a','first'),binding('b','second')]);
 expect(mergeSettings({},a).options).toEqual(a);
 expect(mergeSettings(a,{}).options).toEqual(a);
});

test('016 optional view and diagnostic preferences use the existing merge without changing prompts or model bindings',()=>{
 const base=options([binding('a','PRIVATE_FULL_TEXT','provider/model')]);
 const local={...structuredClone(base),view:{hiddenProviders:['hidden'],favoriteModels:['provider/model'],collapsePrompt:true}};
 const remote={...structuredClone(base),diagnostics:{checks:false,routes:false}};
 const merged=mergeSettings(local,remote,base);
 expect(merged.options.bindings).toEqual(base.bindings);
 expect(merged.options.view).toEqual(local.view);
 expect(merged.options.diagnostics).toEqual(remote.diagnostics);
 expect(merged.conflicts).toEqual([]);
 const imported=mergeSettings({},merged.options).options;
 expect(imported).toEqual(merged.options);
});
test('different edits merge, and concurrent same-prompt edits retain an inactive unbound copy',()=>{
 const base=options([binding('a','first'),binding('b','second')]);
 const local=structuredClone(base),remote=structuredClone(base);
 local.bindings[0].prompt='local edit';remote.bindings[1].prompt='remote edit';
 expect(mergeSettings(local,remote,base).options.bindings.map(x=>x.prompt)).toEqual(['local edit','remote edit']);
 remote.bindings[0].prompt='remote concurrent edit';
 const merged=mergeSettings(local,remote,base);
 expect(merged.options.bindings.map(x=>x.prompt)).toContain('local edit');
 expect(merged.options.bindings.find(x=>x.prompt==='remote concurrent edit')).toMatchObject({enabled:false,models:[]});
 expect(mergeSettings(merged.options,remote,remote).options).toEqual(merged.options);
});
test('cached cloud changes update an already-installed plugin without overwriting pending local edits or other plugins',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'kupa-sync-fixture-'));
 const module=new SettingsSync({directory:dir});
 const c={url:'https://example.invalid/private-dav',user:'fixture',passphrase:'fixture-pass'};
 const scope=sha(c.url+'\0'+c.user+'\0'+c.passphrase);
 const file=path.join(dir,'plugins.json');
 const initial=options([binding('a','original')]);
 const other={spec:'unrelated-plugin',options:{setting:'retain'}};
 const setCloud=async opts=>{
  const raw=seal({plugins:[{spec:'kupadesk@https://example.invalid/plugin.tgz',options:opts}]});
  await fs.writeFile(path.join(dir,'sync-server.magpie-backup'),raw);
  await write(path.join(dir,'sync-state.json'),{key:scope,sum:sha(raw)});
 };
 try{
  await write(path.join(dir,'sync.json'),c);
  await write(file,{plugins:[other,{spec:'kupadesk@fixture',options:initial}]});
  await setCloud(initial);await module.tick();
  const newer=options([binding('a','cloud update'),binding('b','new cloud prompt')]);
  await setCloud(newer);await module.tick();
  expect((await read(file)).plugins[1].options).toEqual(newer);
  expect((await read(file)).plugins[0]).toEqual(other);
  const pending=structuredClone(newer);pending.bindings[0].prompt='unsent local edit';
  await write(file,{plugins:[other,{spec:'kupadesk@fixture',options:pending}]});
  await module.tick();expect((await read(file)).plugins[1].options).toEqual(pending);
  const st=await read(path.join(dir,'sync-state.json'));st.sum='not-the-cache';await write(path.join(dir,'sync-state.json'),st);
  await module.tick();expect((await read(file)).plugins[1].options).toEqual(pending);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('official git installation and legacy tarball identify the same plugin only',()=>{
 expect(portableKupa('github:kupakupar/kupadesk-plugin#v0.0.3')).toBe(true);
 expect(portableKupa('KupaDesk@https://example.invalid/plugin.tgz')).toBe(true);
 expect(portableKupa('github:other/kupadesk-plugin')).toBe(false);
 expect(portableKupa('github:kupakupar/kupadesk-plugin-other')).toBe(false);
});

test('oversized cloud settings retain local prompts, bindings and the last merge base',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'kupa-sync-budget-'));
 const c={url:'https://example.invalid/dav',user:'fixture',passphrase:'fixture-pass'};
 const local=options([binding('a','LOCAL_FULL_TEXT','one/model')]);
 const original={plugins:[{spec:'github:kupakupar/kupadesk-plugin',options:local}]};
 const stateDir=path.join(dir,'kupadesk-private-sync');
 const key=sha(c.url+'\0'+c.user+'\0'+c.passphrase);
 try {
  await fs.mkdir(stateDir,{recursive:true});
  await write(path.join(dir,'sync.json'),c);
  await write(path.join(dir,'plugins.json'),original);
  const previous={scope:key,base:local};
  await write(path.join(stateDir,'state.json'),previous);
  const remote=options([binding('a','中'.repeat(30000),'one/model')]);
  const raw=seal({plugins:[{spec:'github:kupakupar/kupadesk-plugin',options:remote}]});
  await fs.writeFile(path.join(dir,'sync-server.magpie-backup'),raw);
  await write(path.join(dir,'sync-state.json'),{key,sum:sha(raw)});
  await new SettingsSync({directory:dir}).tick();
  expect(await read(path.join(dir,'plugins.json'))).toEqual(original);
  expect(await read(path.join(stateDir,'state.json'))).toEqual(previous);
  expect((await read(path.join(stateDir,'status.json'))).code).toBe('settings_merge_too_large');
 } finally {await fs.rm(dir,{recursive:true,force:true});}
});
