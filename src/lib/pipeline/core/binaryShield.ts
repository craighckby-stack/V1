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

const ALGORITHM = "aes-256-gcm";
const SECRET_SEED = process.env.BINARY_SHIELD_SEED ?? "HELPER_SECURITY_KEY_2026";
const KEY_DERIVATION_ALGORITHM = "sha256";
const HASH_ALGORITHM = "sha256";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const ALGORITHM_NAME = "AES-GCM-256";

function getKeyBuffer(): Buffer {
  return createHash(KEY_DERIVATION_ALGORITHM).update(SECRET_SEED).digest();
}

export class BinaryShield {
  public async encrypt(plainText: string): Promise<EncryptionPacket> {
    const key = getKeyBuffer();
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    const enc = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const combined = Buffer.concat([enc, tag]);
    
    return {
      data: combined.toString("base64"),
      iv: iv.toString("base64"),
      timestamp: Date.now(),
      algorithm: ALGORITHM_NAME,
    };
  }

  public async decrypt(packet: DecryptionPacket): Promise<string> {
    const key = getKeyBuffer();
    const iv = Buffer.from(packet.iv, "base64");
    const combined = Buffer.from(packet.data, "base64");
    
    if (combined.length < AUTH_TAG_LENGTH) {
      throw new Error("Ciphertext too short");
    }
    
    const tag = combined.subarray(combined.length - AUTH_TAG_LENGTH);
    const enc = combined.subarray(0, combined.length - AUTH_TAG_LENGTH);
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
    
    return dec.toString("utf8");
  }

  public async computeHash(data: string): Promise<string> {
    return createHash(HASH_ALGORITHM).update(data).digest("hex");
  }
}

export const binaryShieldInstance = new BinaryShield();