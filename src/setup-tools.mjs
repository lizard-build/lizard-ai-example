// Runs inside one user's sandbox. Executables persist; credentials are never copied between users.
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, chmod, lstat, readlink, symlink, rename, access } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { persistGitHubConfig } from './persistent-gh.mjs';
import { managedLizardAvailable, installManagedLizard } from './managed-lizard.mjs';

await persistGitHubConfig();

const restoring = process.argv.includes('--restore');
const run = (file, args) => execFileSync(file, args, { timeout: 240000, stdio: 'pipe', env: { ...process.env, npm_config_cache: '/tmp/telegram-npm-cache' } });
const versionIs = (file, expected) => { try { return run(file, ['--version']).toString().trim().split('\n')[0] === expected; } catch { return false; } };
const usable = async (file, version) => restoring ? access(file, 1).then(()=>true,()=>false) : versionIs(file, version);
const root = `/workspace/.tools/linux-${process.arch}-node${process.versions.node.split('.')[0]}-v1`;
const npm = `${root}/lizard-4.0.6-browser-0.27.0`;
await mkdir(root, { recursive: true });
const paths = { lizard: `${npm}/node_modules/.bin/lizard`, 'agent-browser': `${npm}/node_modules/.bin/agent-browser` };
if (!await usable(paths.lizard, '4.0.6') || !await usable(paths['agent-browser'], 'agent-browser 0.27.0')) {
  if (restoring) throw new Error('Persistent CLI cache is incomplete');
  run('npm', ['install', '--prefix', npm, '--no-audit', '--no-fund', '--save-exact', '@lizard-build/cli@4.0.6', 'agent-browser@0.27.0']);
  console.log('Installed persistent npm CLIs');
}
const releases = {
  x64: ['amd64', '9bca2d1c16825f109907a23307628a2f0698fbf99662b73a5cf0b020293072b8'],
  arm64: ['arm64', 'b57e8063f18862647c9d22727c32e9da1b963f8bf9db648fe123a6975695640f'],
};
const release = releases[process.arch];
if (process.platform !== 'linux' || !release) throw new Error('Unsupported CLI installation platform');
const [arch, digest] = release;
const name = `gh_2.101.0_linux_${arch}`;
paths.gh = `${root}/${name}/bin/gh`;
if (!await usable(paths.gh, 'gh version 2.101.0 (2026-09-15)')) {
  if (restoring) throw new Error('Persistent GitHub CLI is missing');
  const response = await fetch(`https://github.com/cli/cli/releases/download/v2.101.0/${name}.tar.gz`, { signal: AbortSignal.timeout(90000) });
  if (!response.ok) throw new Error(`GitHub CLI download failed: ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(archive).digest('hex') !== digest) throw new Error('GitHub CLI checksum mismatch');
  // Compressed archives are disposable; only the installed executable needs the volume.
  const file = `/opt/telegram-codex/${name}.tar.gz`;
  await writeFile(file, archive);
  run('tar', ['--no-same-owner', '-xzf', file, '-C', root, `${name}/bin/gh`]);
  await chmod(paths.gh, 0o755);
  console.log('Installed persistent GitHub CLI');
}
await mkdir('/usr/local/bin', { recursive: true });
for (const [tool, source] of Object.entries(paths)) {
  if(tool==='lizard' && await managedLizardAvailable()) continue;
  const target = `/usr/local/bin/${tool}`;
  const existing = await lstat(target).catch(e => { if (e.code !== 'ENOENT') throw e; });
  if (!existing?.isSymbolicLink() || await readlink(target) !== source) {
    if (existing) await rename(target, `/opt/telegram-codex/${tool}-previous-${randomUUID()}`);
    await symlink(source, target);
  }
  if (!restoring) console.log(run(target, ['--version']).toString().trim());
}
await installManagedLizard({binary:paths.lizard});
await writeFile('/opt/telegram-codex/tools-ready-v3', root);
