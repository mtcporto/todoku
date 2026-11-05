import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";

export type Scope = { tenantId: string; applicationId: string };
export type Keyring = { activeId: string; keys: Record<string, string> };
const envelopeSchema = z.strictObject({ v: z.literal(1), kid: z.string().min(1), iv: z.string(), tag: z.string(), ciphertext: z.string() });

export function serverKeyring(): Keyring {
  const keys = z.record(z.string(), z.string()).parse(JSON.parse(process.env.TODOKU_MASTER_KEYS ?? "{}"));
  const activeId = process.env.TODOKU_ACTIVE_MASTER_KEY ?? "";
  const ring = { activeId, keys };
  key(ring, activeId);
  return ring;
}
function key(ring: Keyring, id: string) {
  const value = Buffer.from(ring.keys[id] ?? "", "base64");
  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(id) || value.length !== 32) throw new Error("Encryption key unavailable");
  return value;
}
function aad(scope: Scope, configId: string, purpose: string) {
  return Buffer.from(JSON.stringify(["todoku", 1, scope.tenantId, scope.applicationId, configId, purpose]));
}
type SecretPurpose = "api_key" | "webhook" | "oidc_context";
export function sealSecret(secret: string, scope: Scope, configId: string, purpose: SecretPurpose, ring = serverKeyring()) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(ring, ring.activeId), iv);
  cipher.setAAD(aad(scope, configId, purpose));
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return JSON.stringify({ v: 1, kid: ring.activeId, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") });
}
export function openSecret(encrypted: string, scope: Scope, configId: string, purpose: SecretPurpose, ring = serverKeyring()) {
  try {
    const envelope = envelopeSchema.parse(JSON.parse(encrypted));
    const decipher = createDecipheriv("aes-256-gcm", key(ring, envelope.kid), Buffer.from(envelope.iv, "base64"));
    decipher.setAAD(aad(scope, configId, purpose));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]).toString("utf8");
  } catch { throw new Error("Secret unavailable"); }
}
