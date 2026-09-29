import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath, readdir, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { persistGitHubConfig } from '../src/persistent-gh.mjs';

test('GitHub login survives a fresh home, remains writable and stays isolated per user',async()=>{
  const root=await mkdtemp(join(tmpdir(),'persistent-gh-'));
  const workspace=join(root,'user-a-volume'),home=join(root,'first-home');
  const original=join(home,'.config','gh');await mkdir(original,{recursive:true});
  await writeFile(join(original,'hosts.yml'),'fixture-login-a');
  const target=await persistGitHubConfig({workspace,home});
  assert.equal(await realpath(original),await realpath(target));
  assert.equal(await readFile(join(target,'hosts.yml'),'utf8'),'fixture-login-a');
  await persistGitHubConfig({workspace,home});
  assert.equal((await readdir(join(home,'.config'))).filter(n=>n.startsWith('gh.before-volume')).length,1);
  const freshHome=join(root,'replacement-home');
  await persistGitHubConfig({workspace,home:freshHome});
  assert.equal(await readFile(join(freshHome,'.config','gh','hosts.yml'),'utf8'),'fixture-login-a');
  await writeFile(join(freshHome,'.config','gh','hosts.yml'),'fixture-login-refreshed');
  assert.equal(await readFile(join(target,'hosts.yml'),'utf8'),'fixture-login-refreshed');
  const other=await persistGitHubConfig({workspace:join(root,'user-b-volume'),home:join(root,'user-b-home')});
  await assert.rejects(readFile(join(other,'hosts.yml')), {code:'ENOENT'});
});

test('a newer current login moves onto the volume while the earlier login remains backed up',async()=>{
  const root=await mkdtemp(join(tmpdir(),'persistent-gh-upgrade-'));
  const workspace=join(root,'volume'),home=join(root,'home');
  const persistent=join(workspace,'.config','gh'),ephemeral=join(home,'.config','gh');
  for(const dir of [persistent,ephemeral]) await mkdir(dir,{recursive:true});
  await writeFile(join(persistent,'hosts.yml'),'yesterday-fixture');
  await utimes(join(persistent,'hosts.yml'),new Date(0),new Date(0));
  await writeFile(join(ephemeral,'hosts.yml'),'today-fixture');
  await persistGitHubConfig({workspace,home});
  assert.equal(await readFile(join(persistent,'hosts.yml'),'utf8'),'today-fixture');
  const backups=join(workspace,'.telegram-codex','gh-backups');
  const names=await readdir(backups);assert.equal(names.length,1);
  assert.equal(await readFile(join(backups,names[0]),'utf8'),'yesterday-fixture');
  assert.equal(await realpath(ephemeral),await realpath(persistent));
});

test('a stale home cannot overwrite a newer saved login',async()=>{
  const root=await mkdtemp(join(tmpdir(),'persistent-gh-stale-'));
  const workspace=join(root,'volume'),home=join(root,'home');
  for(const dir of [join(workspace,'.config','gh'),join(home,'.config','gh')]) await mkdir(dir,{recursive:true});
  const stale=join(home,'.config','gh','hosts.yml');
  await writeFile(stale,'stale-fixture');await utimes(stale,new Date(0),new Date(0));
  await writeFile(join(workspace,'.config','gh','hosts.yml'),'current-fixture');
  await persistGitHubConfig({workspace,home});
  assert.equal(await readFile(stale,'utf8'),'current-fixture');
});
