import { env } from "cloudflare:workers";

export interface ObjectStore {
  getJson<T>(key: string): Promise<T | null>;
  putJson(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

function bucket() {
  const bindings = env as unknown as { OBJECTS?: R2Bucket };
  if (!bindings.OBJECTS) throw new Error("R2 对象存储尚未绑定");
  return bindings.OBJECTS;
}

export const objectStore: ObjectStore = {
  async getJson<T>(key: string) {
    const object = await bucket().get(key);
    if (!object) return null;
    return object.json<T>();
  },
  async putJson(key: string, value: unknown) {
    await bucket().put(key, JSON.stringify(value), { httpMetadata: { contentType: "application/json; charset=utf-8" } });
  },
  async delete(key: string) {
    await bucket().delete(key);
  },
  async exists(key: string) {
    return Boolean(await bucket().head(key));
  },
};
