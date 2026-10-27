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
    if (plainText === null || plainText === undefined) {
      throw new Error("Input text cannot be null or undefined");
    }
    
    if (plainText.length === 0) {
      throw new Error("Input text cannot be empty");
    }
    
    const key = getKeyBuffer();
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    let encryptedData: Buffer;
    
    try {
      encryptedData = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
      cipher.destroy(); // Properly close the cipher handle
    } catch (error) {
      cipher.destroy(); // Ensure cipher is closed even if an error occurs
      throw new Error(`Encryption failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
    
    const authTag = cipher.getAuthTag();
    const combinedData = Buffer.concat([encryptedData, authTag]);
    
    return {
      data: combinedData.toString("base64"),
      iv: iv.toString("base64"),
      timestamp: Date.now(),
      algorithm: ALGORITHM_NAME,
    };
  }

  public async decrypt(packet: DecryptionPacket): Promise<string> {
    if (!packet || typeof packet !== "object") {
      throw new Error("Decryption packet must be a valid object");
    }
    
    if (typeof packet.data !== "string" || typeof packet.iv !== "string") {
      throw new Error("Decryption packet must contain string data and iv fields");
    }
    
    const key = getKeyBuffer();
    let iv: Buffer;
    
    try {
      iv = Buffer.from(packet.iv, "base64");
    } catch (error) {
      throw new Error("Invalid IV format - must be valid base64");
    }
    
    if (iv.length !== IV_LENGTH) {
      throw new Error(`Invalid IV length for ${ALGORITHM_NAME}. Expected ${IV_LENGTH} bytes, got ${iv.length}`);
    }
    
    let combinedData: Buffer;
    
    try {
      combinedData = Buffer.from(packet.data, "base64");
    } catch (error) {
      throw new Error("Invalid ciphertext format - must be valid base64");
    }
    
    if (combinedData.length < AUTH_TAG_LENGTH) {
      throw new Error(`Ciphertext too short for ${ALGORITHM_NAME} - must include ${AUTH_TAG_LENGTH}-byte authentication tag`);
    }
    
    const authTag = combinedData.subarray(combinedData.length - AUTH_TAG_LENGTH);
    const encryptedData = combinedData.subarray(0, combinedData.length - AUTH_TAG_LENGTH);
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    
    try {
      decipher.setAuthTag(authTag);
      const decryptedData = Buffer.concat([decipher.update(encryptedData), decipher.final()]);
      decipher.destroy(); // Properly close the decipher handle
      return decryptedData.toString("utf8");
    } catch (error) {
      decipher.destroy(); // Ensure decipher is closed even if an error occurs
      throw new Error(`Decryption failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }

  public async computeHash(data: string): Promise<string> {
    if (data === null || data === undefined) {
      throw new Error("Input data cannot be null or undefined");
    }
    
    if (typeof data !== "string") {
      throw new Error("Input data must be a string");
    }
    
    if (data.length === 0) {
      throw new Error("Input data cannot be empty");
    }
    
    return createHash(HASH_ALGORITHM).update(data).digest("hex");
  }
}

export const binaryShieldInstance = new BinaryShield();