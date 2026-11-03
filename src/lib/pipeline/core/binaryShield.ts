import { createHash } from "crypto";

const HASH_ALGORITHM = "sha256";

export class BinaryShield {
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
