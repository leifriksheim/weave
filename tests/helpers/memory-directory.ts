import type {
  DirectoryHandleLike,
  FileHandleLike,
  WritableFileLike,
} from '../../src/storage/folder-adapter.js';

/**
 * An in-memory stand-in for a File System Access directory handle.
 *
 * Node has no such API, and the point of the folder adapter is precisely what
 * happens when two *different* holders look at one directory — so the test
 * double stores its files in a shared Map and hands out as many handles over it
 * as a test wants. Two handles on the same tree are two origins.
 */

/** Thrown for a missing entry, matching what a browser raises. */
function notFound(name: string): Error {
  const error = new Error(`No entry named ${name}`);
  error.name = 'NotFoundError';
  return error;
}

/** One directory's contents: files by name, and nested directories by name. */
interface Node {
  readonly files: Map<string, Uint8Array>;
  readonly dirs: Map<string, Node>;
}

function emptyNode(): Node {
  return { files: new Map(), dirs: new Map() };
}

/**
 * Creates a directory handle over an in-memory tree.
 * @param name What the directory calls itself
 * @param node The tree it points at — pass the same node twice for two origins
 * @returns A handle satisfying the slice of the API the adapter uses
 */
function handleOver(name: string, node: Node): DirectoryHandleLike {
  return {
    name,

    async getFileHandle(fileName: string, options?: { create?: boolean }): Promise<FileHandleLike> {
      if (!node.files.has(fileName)) {
        if (!options?.create) throw notFound(fileName);
        node.files.set(fileName, new Uint8Array(0));
      }

      return {
        async getFile() {
          const bytes = node.files.get(fileName);
          if (!bytes) throw notFound(fileName);
          return {
            async arrayBuffer(): Promise<ArrayBuffer> {
              return bytes.slice().buffer;
            },
          };
        },
        async createWritable(): Promise<WritableFileLike> {
          const chunks: Uint8Array[] = [];
          return {
            async write(data: Uint8Array | string) {
              chunks.push(typeof data === 'string' ? new TextEncoder().encode(data) : data.slice());
            },
            async close() {
              const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
              const merged = new Uint8Array(total);
              let offset = 0;
              for (const chunk of chunks) {
                merged.set(chunk, offset);
                offset += chunk.length;
              }
              node.files.set(fileName, merged);
            },
          };
        },
      };
    },

    async getDirectoryHandle(dirName: string, options?: { create?: boolean }): Promise<DirectoryHandleLike> {
      let child = node.dirs.get(dirName);
      if (!child) {
        if (!options?.create) throw notFound(dirName);
        child = emptyNode();
        node.dirs.set(dirName, child);
      }
      return handleOver(dirName, child);
    },

    async removeEntry(entryName: string): Promise<void> {
      if (node.files.delete(entryName) || node.dirs.delete(entryName)) return;
      throw notFound(entryName);
    },

    async *keys(): AsyncIterableIterator<string> {
      // A copy, so deleting while iterating behaves the way a real listing does.
      for (const key of [...node.files.keys(), ...node.dirs.keys()]) yield key;
    },
  };
}

/** A directory tree plus a way to open more handles onto it */
export interface MemoryDirectory {
  readonly handle: DirectoryHandleLike;
  /** Another handle over the same files — a second origin looking at one folder */
  open(): DirectoryHandleLike;
  /** Every file path in the tree, for asserting on layout */
  paths(): ReadonlyArray<string>;
}

/**
 * Creates an empty in-memory directory.
 * @param name What to call it
 * @returns The directory, and a way to open further handles onto the same tree
 */
export function createMemoryDirectory(name: string = 'data'): MemoryDirectory {
  const root = emptyNode();

  function walk(node: Node, prefix: string, out: string[]): void {
    for (const file of node.files.keys()) out.push(`${prefix}${file}`);
    for (const [dirName, child] of node.dirs) walk(child, `${prefix}${dirName}/`, out);
  }

  return {
    handle: handleOver(name, root),
    open: () => handleOver(name, root),
    paths() {
      const out: string[] = [];
      walk(root, '', out);
      return out.sort();
    },
  };
}
