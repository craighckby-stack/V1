/**
 * BinaryShield Cryptographic Helper Engine (server-safe)
 *
 * Node-native implementation using the built-in `crypto` module. The original
 * project relied on `window.crypto.subtle`; in the Next.js server runtime we
 * use `crypto.createHash` (SHA-256) and `crypto.randomBytes` (IV) so the
 * pipeline can run inside API routes and the autonomous loop service.
 */

import { createHash, randomBytes, createCipheriv, createDecipheriv } from "crypto";

export interface EncryptionPacket {
  readonly data: string; // Base64 ciphertext
  readonly iv: string; // Base64 IV
  readonly timestamp: number;
  readonly algorithm: string;
}

export interface DecryptionPacket {
  readonly data: string;
  readonly iv: string;
}

const ALGO = "aes-256-gcm";
const SECRET_SEED = process.env.BINARY_SHIELD_SEED ?? "HELPER_SECURITY_KEY_2026";
const IV_LENGTH = 12;
const MIN_CIPHERTEXT_LENGTH = 16;
const GCM_TAG_LENGTH = 16;

function getKeyBuffer(): Buffer {
  // Derive a 32-byte key from the seed using SHA-256.
  return createHash("sha256").update(SECRET_SEED).digest();
}

export class BinaryShield {
  public async encrypt(plainText: string): Promise<EncryptionPacket> {
    const key = getKeyBuffer();
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGO, key, iv);
    const enc = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    // Pack the GCM tag with the ciphertext so decryption can verify it.
    const combined = Buffer.concat([enc, tag]);
    return {
      data: combined.toString("base64"),
      iv: iv.toString("base64"),
      timestamp: Date.now(),
      algorithm: "AES-GCM-256",
    };
  }

  public async decrypt(packet: DecryptionPacket): Promise<string> {
    const key = getKeyBuffer();
    const iv = Buffer.from(packet.iv, "base64");
    const combined = Buffer.from(packet.data, "base64");
    if (combined.length < MIN_CIPHERTEXT_LENGTH) throw new Error("Ciphertext too short");
    const tag = combined.subarray(combined.length - GCM_TAG_LENGTH);
    const enc = combined.subarray(0, combined.length - GCM_TAG_LENGTH);
    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
    return dec.toString("utf8");
  }

  public async computeHash(data: string): Promise<string> {
    return createHash("sha256").update(data).digest("hex");
  }
}

export const binaryShieldInstance = new BinaryShield();