// Encrypts Google refresh tokens at rest with AES-256-GCM.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64"), tag.toString("base64"), body.toString("base64")].join(".");
}

export function decrypt(sealed: string, key: Buffer): string {
  const [version, iv, tag, body] = sealed.split(".");
  if (version !== "v1" || !iv || !tag || !body) throw new Error("Unrecognized encrypted value");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString("utf8");
}

export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}
