/**
 * Web Push with WebCrypto only (DESIGN-v2 T11, after Shepherdr `service/push.ts`): RFC 8291 message encryption
 * (`aes128gcm` content coding of RFC 8188, one record), RFC 8292 VAPID (an ES256 JWT per push), and the push-service
 * allowlist of DESIGN-v2 §1.2 — the bridge's `--allow-net` names exactly these hosts, on port 443.
 */

import { base64url } from "../auth/secret.ts";

/** The Web Push services the bridge sends to (Safari/iOS, Chrome/Android, Firefox). */
export const PUSH_SERVICE_HOSTS = ["web.push.apple.com", "fcm.googleapis.com", "updates.push.services.mozilla.com"];

/** `rs` of the one record each message is. */
export const RECORD_SIZE = 4096;
/** Largest plaintext that fits that record: minus the padding delimiter and the 16-byte GCM tag. */
export const MAX_PAYLOAD_BYTES = RECORD_SIZE - 1 - 16;
/** Lifetime of a VAPID token (RFC 8292 allows at most 24 h). */
export const VAPID_TOKEN_TTL_S = 12 * 3600;

const encoder = new TextEncoder();
const WEBPUSH_INFO = encoder.encode("WebPush: info\0");
const CEK_INFO = encoder.encode("Content-Encoding: aes128gcm\0");
const NONCE_INFO = encoder.encode("Content-Encoding: nonce\0");
const LAST_RECORD = new Uint8Array([2]);

/** `PushSubscription.keys`: the browser's P-256 key (`p256dh`) and auth secret, base64url. */
export interface SubscriptionKeys {
  p256dh: string;
  auth: string;
}

/** The application server's VAPID key pair: raw public key (base64url, 65 bytes) and the ES256 signing key. */
export interface VapidKeys {
  publicKey: string;
  privateKey: CryptoKey;
}

/** {@link SubscriptionKeys} decoded: an uncompressed P-256 point (65 bytes) and the 16-byte auth secret. */
export interface SubscriptionKeyBytes {
  p256dh: Uint8Array<ArrayBuffer>;
  auth: Uint8Array<ArrayBuffer>;
}

/** Fixed inputs for reproducing a known message (RFC 8291 Appendix A); both are random by default. */
export interface EncryptOptions {
  /** 16 bytes. */
  salt?: Uint8Array<ArrayBuffer>;
  /** The sender's ECDH key pair: private key and raw public key (65 bytes). */
  serverKeys?: { privateKey: CryptoKey; publicKey: Uint8Array<ArrayBuffer> };
}

/** Whether `endpoint` is an `https:` URL without credentials on one of {@link PUSH_SERVICE_HOSTS}, port 443. */
export function isAllowedEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  return url.protocol === "https:" && url.port === "" && url.username === "" && url.password === "" &&
    PUSH_SERVICE_HOSTS.includes(url.hostname);
}

/** Decodes base64url, with or without `=` padding. Throws `TypeError` on anything else. */
export function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(text)) throw new TypeError("not base64url");
  const bare = text.replace(/=+$/, "");
  if (bare.length % 4 === 1) throw new TypeError("not base64url");
  const binary = atob(bare.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - bare.length % 4) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** The subscription's keys decoded and checked. Throws `TypeError` when they are not a P-256 key and auth secret. */
export function decodeSubscriptionKeys(keys: SubscriptionKeys): SubscriptionKeyBytes {
  const p256dh = fromBase64url(keys.p256dh);
  const auth = fromBase64url(keys.auth);
  if (p256dh.length !== 65 || p256dh[0] !== 4) throw new TypeError("p256dh is not an uncompressed P-256 key");
  if (auth.length !== 16) throw new TypeError("auth is not a 16-byte secret");
  return { p256dh, auth };
}

/**
 * RFC 8291 §3.4: `plaintext` encrypted for one subscription, as the `aes128gcm` body
 * `salt(16) ‖ rs(u32 BE) ‖ idlen ‖ keyid(sender public key) ‖ record`.
 */
export async function encryptPayload(
  plaintext: Uint8Array,
  keys: SubscriptionKeys,
  options: EncryptOptions = {},
): Promise<Uint8Array<ArrayBuffer>> {
  if (plaintext.length > MAX_PAYLOAD_BYTES) {
    throw new RangeError(`push payload of ${plaintext.length} bytes exceeds ${MAX_PAYLOAD_BYTES}`);
  }
  const { p256dh, auth } = decodeSubscriptionKeys(keys);
  const salt = options.salt ?? crypto.getRandomValues(new Uint8Array(16));
  if (salt.length !== 16) throw new RangeError("the salt must be 16 bytes");
  let sender = options.serverKeys;
  if (!sender) {
    const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    sender = {
      privateKey: pair.privateKey,
      publicKey: new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)),
    };
  }
  const receiver = await crypto.subtle.importKey("raw", p256dh, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = await crypto.subtle.deriveBits({ name: "ECDH", public: receiver }, sender.privateKey, 256);
  const ikm = await hkdf(auth, new Uint8Array(ecdhSecret), concat(WEBPUSH_INFO, p256dh, sender.publicKey), 32);
  const cek = await hkdf(salt, ikm, CEK_INFO, 16);
  const nonce = await hkdf(salt, ikm, NONCE_INFO, 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const record = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, concat(plaintext, LAST_RECORD));
  const header = new Uint8Array(21);
  header.set(salt);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE, false);
  header[20] = sender.publicKey.length;
  return concat(header, sender.publicKey, new Uint8Array(record));
}

/** RFC 8292 `Authorization` header value for a push to `endpoint`: `vapid t=<ES256 JWT>, k=<public key>`. */
export async function vapidAuthorization(
  endpoint: string,
  vapid: VapidKeys,
  subject: string,
  now: number = Date.now(),
): Promise<string> {
  const header = base64url(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = base64url(encoder.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(now / 1000) + VAPID_TOKEN_TTL_S,
    sub: subject,
  })));
  // WebCrypto's ECDSA signature is r ‖ s (64 bytes), the JWS ES256 form.
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    vapid.privateKey,
    encoder.encode(`${header}.${claims}`),
  );
  return `vapid t=${header}.${claims}.${base64url(new Uint8Array(signature))}, k=${vapid.publicKey}`;
}

async function hkdf(
  salt: Uint8Array<ArrayBuffer>,
  ikm: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
  bytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
