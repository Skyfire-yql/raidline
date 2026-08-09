export const SHARE_ID_PATTERN = /^[0-9A-Za-z]{16}$/;
export const EDIT_ID_PATTERN = /^[0-9A-Za-z]{4}$/;
export const BASE62 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

export function randomBase62(length: number, randomValues: (array: Uint8Array) => Uint8Array = (array) => crypto.getRandomValues(array)) {
  if (!Number.isInteger(length) || length < 1) throw new Error("ID 长度无效");
  let result = "";
  while (result.length < length) {
    const bytes = randomValues(new Uint8Array(Math.max(16, (length - result.length) * 2)));
    for (const byte of bytes) {
      if (byte >= 248) continue;
      result += BASE62[byte % 62];
      if (result.length === length) break;
    }
  }
  return result;
}

export function assertShareId(shareId: string) {
  if (!SHARE_ID_PATTERN.test(shareId)) throw new Error("分享 ID 无效");
}

export function assertEditId(editId: string) {
  if (!EDIT_ID_PATTERN.test(editId)) throw new Error("编辑 ID 无效");
}
