// Runs inside Sandboxes before Codex starts. Keep the skill on the shared volume.
import { mkdir, readFile, writeFile, rename, lstat, readlink, symlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

for (const name of ['lizard', 'agent-browser']) {
const root = `/workspace/.telegram-codex/skills/${name}`;
const target = `/etc/codex/skills/${name}`;
await mkdir(root, { recursive: true });
await mkdir('/etc/codex/skills', { recursive: true });
// Preserve an existing admin installation rather than replacing it silently.
const existing = await lstat(target).catch(error => {
  if (error.code !== 'ENOENT') throw error;
});
if (existing && (!existing.isSymbolicLink() || await readlink(target) !== root)) {
  throw new Error('An unrelated Lizard Skill already exists in the admin skill directory');
}
const source = await readFile(new URL(`${name}-SKILL.md`, import.meta.url), 'utf8');
const installed = await readFile(`${root}/SKILL.md`, 'utf8').catch(error => {
  if (error.code !== 'ENOENT') throw error;
});
if (installed !== source) {
  const temporary = `${root}/.SKILL-${randomUUID()}.tmp`;
  await writeFile(temporary, source, { mode: 0o644 });
  await rename(temporary, `${root}/SKILL.md`);
}
if (!existing) await symlink(root, target, 'dir');
}
console.log('Shared skills are installed for all Codex sessions');
