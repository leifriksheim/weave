/**
 * A directory on disk, shaped like the browser's FileSystemDirectoryHandle.
 *
 * The folder adapter was written against the File System Access API so a
 * browser could keep data in a folder the user picked. Giving Node and Bun the
 * same shape means the CLI and the daemon read and write *exactly* the layout a
 * browser does — point both at one folder and they share an account.
 *
 * Writes land in a temporary file and are renamed into place, so a reader in
 * another process never sees half a file.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DirectoryHandleLike, FileHandleLike, WritableFileLike } from '../../src/storage/folder-adapter.js';

function notFound(name: string): Error {
  const error = new Error(`${name} was not found`);
  error.name = 'NotFoundError';
  return error;
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function fileHandle(file: string): FileHandleLike {
  return {
    async getFile() {
      const bytes = await fs.readFile(file);
      return {
        async arrayBuffer() {
          return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        },
      };
    },
    async createWritable(): Promise<WritableFileLike> {
      const chunks: Uint8Array[] = [];
      return {
        async write(data: Uint8Array | string) {
          chunks.push(typeof data === 'string' ? new TextEncoder().encode(data) : data);
        },
        async close() {
          const temporary = `${file}.${randomUUID()}.tmp`;
          await fs.writeFile(temporary, Buffer.concat(chunks), { mode: 0o600 });
          await fs.rename(temporary, file);
        },
      };
    },
  };
}

/**
 * Opens a directory, creating it if needed.
 * @param root An absolute or relative path
 */
export async function openFsDirectory(root: string): Promise<DirectoryHandleLike> {
  const absolute = path.resolve(root);
  await fs.mkdir(absolute, { recursive: true, mode: 0o700 });
  return directory(absolute);
}

function directory(dir: string): DirectoryHandleLike {
  return {
    name: path.basename(dir),

    async getFileHandle(name, options) {
      const file = path.join(dir, name);
      if (!(await exists(file))) {
        if (!options?.create) throw notFound(name);
        await fs.writeFile(file, new Uint8Array(0), { mode: 0o600 });
      }
      return fileHandle(file);
    },

    async getDirectoryHandle(name, options) {
      const sub = path.join(dir, name);
      if (!(await exists(sub))) {
        if (!options?.create) throw notFound(name);
        await fs.mkdir(sub, { recursive: true, mode: 0o700 });
      }
      return directory(sub);
    },

    async removeEntry(name, options) {
      const target = path.join(dir, name);
      if (!(await exists(target))) throw notFound(name);
      await fs.rm(target, { recursive: options?.recursive ?? false, force: false });
    },

    async *keys() {
      for (const entry of await fs.readdir(dir)) {
        // Another writer's file mid-rename is not an entry yet.
        if (!entry.endsWith('.tmp')) yield entry;
      }
    },
  };
}
