import { mkdir, readFile, writeFile, stat, lstat, rename, symlink, realpath, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

// Runs only inside one user's sandbox. Never reads controller credentials.
export async function persistGitHubConfig({workspace='/workspace',home=process.env.HOME || '/root'}={}) {
  const target=join(workspace,'.config','gh'), source=join(home,'.config','gh');
  await mkdir(target,{recursive:true,mode:0o700});await chmod(target,0o700);
  if(resolve(source)===resolve(target) || await realpath(source).catch(()=>null)===await realpath(target)) return target;
  for(const name of ['hosts.yml','config.yml']) {
    const from=join(source,name),to=join(target,name);
    const incoming=await stat(from).catch(()=>null),saved=await stat(to).catch(()=>null);
    if(!incoming?.isFile() || saved && incoming.mtimeMs<=saved.mtimeMs) continue;
    const bytes=await readFile(from);
    if(saved) {
      const previous=await readFile(to);
      if(previous.equals(bytes)) continue;
      const backup=join(workspace,'.telegram-codex','gh-backups');
      await mkdir(backup,{recursive:true,mode:0o700});
      await writeFile(join(backup,`${randomUUID()}-${name}`),previous,{mode:0o600});
    }
    const pending=`${to}.${randomUUID()}.pending`;
    await writeFile(pending,bytes,{mode:0o600});await rename(pending,to);
  }
  await mkdir(join(home,'.config'),{recursive:true});
  // Keep the old directory intact. All future default gh reads/writes use the volume.
  if(await lstat(source).catch(()=>null)) await rename(source,`${source}.before-volume-${randomUUID()}`);
  await symlink(target,source);
  return target;
}
