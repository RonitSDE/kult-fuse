// Regenerate the source integrity list after the final manifest and IDL are committed.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const ignoredDirs = new Set(['.git', '.data', '.wrangler', 'node_modules', 'target']);
const ignoredFiles = new Set(['.env', 'SOURCE_MANIFEST.sha256', '.DS_Store']);
async function filesUnder(dir = '.') {
  const result = [];
  for (const item of await fs.readdir(dir, { withFileTypes: true })) {
    if (item.isDirectory()) {
      if (!ignoredDirs.has(item.name)) result.push(...await filesUnder(path.join(dir, item.name)));
    } else if (item.isFile() && !ignoredFiles.has(item.name) && !item.name.endsWith('.log')) {
      result.push(path.join(dir, item.name).replaceAll(path.sep, '/').replace(/^\.\//, ''));
    }
  }
  return result;
}
const paths = (await filesUnder()).sort();
const lines = await Promise.all(paths.map(async (file) =>
  `${createHash('sha256').update(await fs.readFile(file)).digest('hex')}  ${file}`));
await fs.writeFile('SOURCE_MANIFEST.sha256', lines.join('\n') + '\n');
console.log(`SOURCE_MANIFEST.sha256: ${paths.length} source files`);
