import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export interface ObjectStore {
  getJson<T>(key: string): Promise<T | null>;
  putJson(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

function objectPath(root: string, key: string) {
  if (!/^[0-9A-Za-z][0-9A-Za-z._/-]{0,499}$/.test(key) || key.split("/").some((part) => part === "." || part === "..")) {
    throw new Error("对象存储键无效");
  }
  const path = resolve(root, key);
  const nested = relative(root, path);
  if (!nested || nested.startsWith("..") || isAbsolute(nested)) throw new Error("对象存储键超出数据目录");
  return path;
}

function missing(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function createFileObjectStore(rootDirectory: string): ObjectStore {
  const root = resolve(rootDirectory);
  return {
    async getJson<T>(key: string) {
      try {
        return JSON.parse(await readFile(objectPath(root, key), "utf8")) as T;
      } catch (error) {
        if (missing(error)) return null;
        throw error;
      }
    },
    async putJson(key: string, value: unknown) {
      const path = objectPath(root, key);
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(value)}\n`, "utf8");
      try {
        await rename(temporary, path);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
    },
    async delete(key: string) {
      await rm(objectPath(root, key), { force: true });
    },
    async exists(key: string) {
      try {
        await access(objectPath(root, key));
        return true;
      } catch (error) {
        if (missing(error)) return false;
        throw error;
      }
    },
  };
}

export const objectStore = createFileObjectStore(process.env.RAIDLINE_DATA_DIR?.trim() || ".raidline-data");
