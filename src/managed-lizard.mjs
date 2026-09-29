// Runs inside a single user's sandbox. Only that user's scoped key is accepted.
import {mkdir,readFile,writeFile,rename,unlink,access,chmod} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
const defaultRoot='/workspace/.telegram-codex';
export async function managedLizardAvailable(root=defaultRoot) {
  return await access(join(root,'lizard-account-input.json')).then(()=>true,()=>false)
    || await access(join(root,'lizard-cli/.lizard/config.json')).then(()=>true,()=>false);
}
export async function installManagedLizard({root=defaultRoot,
  binary=`/workspace/.tools/linux-${process.arch}-node${process.versions.node.split('.')[0]}-v1/lizard-4.0.6-browser-0.27.0/node_modules/.bin/lizard`,
  target='/usr/local/bin/lizard'}={}) {
  const home=join(root,'lizard-cli'),folder=join(home,'.lizard'),configPath=join(folder,'config.json'),inputPath=join(root,'lizard-account-input.json');
  let account;
  try {account=JSON.parse(await readFile(inputPath,'utf8'));} catch(e){if(e.code!=='ENOENT')throw new Error('Invalid managed account input');}
  if(!account && !await access(configPath).then(()=>true,()=>false)) return false;
  await mkdir(folder,{recursive:true,mode:0o700});await chmod(home,0o700);await chmod(folder,0o700);
  if(account) {
    if(typeof account.token!=='string' || !account.token.startsWith('liz_') || !account.workspaceId || !account.keyId) throw new Error('Invalid scoped account');
    let config={};try {config=JSON.parse(await readFile(configPath,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
    if(config.managedWorkspaceId && config.managedWorkspaceId!==account.workspaceId) throw new Error('Managed workspace changed');
    config.credentials={accessToken:account.token};
    config.managedWorkspaceId=account.workspaceId;config.managedKeyId=account.keyId;
    const pending=`${configPath}.pending-${randomUUID()}`;
    await writeFile(pending,JSON.stringify(config),{mode:0o600});await rename(pending,configPath);
    await writeFile(join(root,'lizard-account.json'),JSON.stringify({workspaceId:account.workspaceId,workspaceName:account.workspaceName,keyId:account.keyId}),{mode:0o600});
    // Remove only the one-use transport file created by this installer.
    await unlink(inputPath);
  }
  const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
  // The managed CLI always uses the scoped credential, even if a shell has a
  // leftover LIZARD_TOKEN or LIZARD_HOME from an earlier manual login.
  const script=`#!/bin/sh\nexport LIZARD_HOME=${quote(home)}\nunset LIZARD_TOKEN LIZARD_API_KEY\nexec ${quote(binary)} "$@"\n`;
  await mkdir(dirname(target),{recursive:true});
  const pending=`${target}.pending-${randomUUID()}`;
  await writeFile(pending,script,{mode:0o755});await rename(pending,target);
  return true;
}
if(process.argv[1]===fileURLToPath(import.meta.url)) await installManagedLizard();
