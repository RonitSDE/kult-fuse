import fs from 'node:fs/promises';
import path from 'node:path';

export class FileStore {
  constructor(dir = './.data') { this.dir = dir; }
  async init() { await fs.mkdir(this.dir, { recursive: true }); }
  file(name) { return path.join(this.dir, `${name}.json`); }
  async read(name, fallback = null) {
    try { return JSON.parse(await fs.readFile(this.file(name), 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
  }
  async write(name, value) {
    await this.init();
    const dest = this.file(name);
    const tmp = `${dest}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(value, null, 2));
    await fs.rename(tmp, dest);
    return value;
  }
  async remove(name) { try { await fs.unlink(this.file(name)); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
}
