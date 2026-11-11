/**
 * TOKEN VAULT — AES-256-GCM at-rest sealing for the GitHub PAT.
 *
 * BEFORE: the PAT sat in PLAINTEXT in three places (the GitPushTarget DB
 * row, .loop-push-state.json, .git/info/loop-push-state.json). Anyone who
 * could read those 203-byte files — a leaked DB dump, a backup, an
 * over-broad postmortem evidence copy — had the credential verbatim.
 *
 * AFTER: every tier stores only an `enc:v1:` envelope. The 32-byte key
 * lives at .git/info/loop-vault-key — the one directory the sandbox
 * guarantees to preserve across restarts (same guarantee the tier-3 push
 * state already rides), never tracked by git, mode 0600. Decrypting
 * requires BOTH the tier file AND the key file; a leaked tier file alone
 * is now useless.
 *
 * Envelope format (all base64url, no padding):
 *   enc:v1:<12-byte random IV>.<16-byte GCM tag>.<ciphertext>
 *
 * Threat model (honest): this protects the token at REST — in DB dumps,
 * backups, file snapshots, crash artifacts. It does NOT protect against an
 * attacker with code execution on this machine (they can call openToken
 * like anyone else); nothing short of an HSM does. The server must be able
 * decrypt unattended — "auto-connect with no input anywhere" is the
 * requirement — so the key is local, not password-derived.
 *
 * Migration is automatic: readers transparently open legacy plaintext
 * (passthrough), and push-target.ts rewrites any plaintext tier to a
 * sealed envelope on first read (migratePlaintextTokenToVault).
 *
 * Server-side only. Never import from a client component.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "crypto";
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { PROJECT_ROOT } from "../core/paths";

/** Envelope prefix — the marker that a stored string is sealed, not plain. */
const ENVELOPE_PREFIX = "enc:v1:";
/** 32 bytes = AES-256. Hex on disk (64 chars + newline). */
const KEY_BYTES = 32;
/**
 * Where the key lives. .git/info/ survives sandbox restarts (it holds the
 * commit history — losing it loses the repo, so the restore layer must
 * preserve it) and is never tracked by git. Same reasoning as the tier-3
 * push state file; see push-target.ts.
 */
const KEY_FILE = join(PROJECT_ROOT, ".git", "info", "loop-vault-key");

/** One-time decrypt-failure laments — never log the token or key. */
let warnedKeyMissing = false;

/** Read (or first-create) the vault key. Returns null if unreadable. */
function ensureKey(): Buffer | null {
  try {
    if (existsSync(KEY_FILE)) {
      const hex = readFileSync(KEY_FILE, "utf-8")?.trim();
      if (!hex || !/^[0-9a-f]{64}$/i.test(hex)) {
        if (!warnedKeyMissing) {
          warnedKeyMissing = true;
          console.error(
            "[TOKEN-VAULT] key file is malformed — it should contain exactly 64 hexadecimal characters. Please fix or remove the file at " + KEY_FILE
          );
        }
        return null;
      }
      return Buffer.from(hex, "hex");
    }
    // First use: generate. Atomic write (tmp + rename), 0600, and mkdir
    // .git/info (it normally exists; don't assume).
    const key = randomBytes(KEY_BYTES);
    let tmp = `${KEY_FILE}.tmp`;
    let tmpCreated = false;
    try {
      mkdirSync(dirname(KEY_FILE), { recursive: true });
      writeFileSync(tmp, key.toString("hex") + "\n", { encoding: "utf-8", mode: 0o600 });
      tmpCreated = true;
      renameSync(tmp, KEY_FILE);
      return key;
    } catch (error) {
      // Clean up temp file if it was created but rename failed
      if (tmpCreated) {
        try {
          if (existsSync(tmp)) {
            try {
              unlinkSync(tmp);
            } catch {
              // Ignore cleanup failures
            }
          }
        } catch {
          // Ignore errors when trying to clean up
        }
      }
      // Read-only .git? Sealing is impossible — callers fall back to
      // storing plaintext (better a working push than a bricked loop).
      if (!warnedKeyMissing) {
        warnedKeyMissing = true;
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`[TOKEN-VAULT] cannot create the key file (.git/info/ not writable) — tokens will stay PLAINTEXT. Error: ${errorMessage}`);
      }
      return null;
    }
  } catch (error) {
    if (!warnedKeyMissing) {
      warnedKeyMissing = true;
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[TOKEN-VAULT] error accessing key file: ${errorMessage}`);
    }
    return null;
  }
}

/** Is this string a sealed envelope (vs legacy plaintext / anything else)? */
export function isSealedEnvelope(value: string): boolean {
  return typeof value === "string" && value.startsWith(ENVELOPE_PREFIX);
}

/**
 * Seal a token. Idempotent and fail-open:
 *   - already an envelope → returned unchanged (never double-seal)
 *   - implausible as a token (short, empty, whitespace) → returned unchanged
 *     (garbage in, garbage out; push-target validates the real format)
 *   - key unavailable → returned unchanged (PLAINTEXT beats a bricked push)
 */
export function sealToken(plain: string): string {
  if (typeof plain !== "string" || !plain) return plain;
  if (isSealedEnvelope(plain)) return plain;
  if (plain.length < 20 || /\s/.test(plain)) return plain;
  const key = ensureKey();
  if (!key) return plain;
  try {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([cipher.update(plain, "utf-8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${ENVELOPE_PREFIX}${iv.toString("base64url")}.${tag.toString("base64url")}.${ct.toString("base64url")}`;
  } catch (error) {
    if (!warnedKeyMissing) {
      warnedKeyMissing = true;
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[TOKEN-VAULT] error sealing token: ${errorMessage}`);
    }
    return plain; // fail-open — see sealToken doc
  }
}

/**
 * Open a stored value. Inverse of sealToken, same fail-open spirit:
 *   - envelope → decrypt; on ANY failure (missing/corrupt key, tampered
 *     tag) return "" so callers treat it as "no usable token" — never
 *     return a half-truth
 *   - not an envelope → legacy plaintext, passed through unchanged (the
 *     automatic migration rewrites it on the next write)
 */
export function openToken(stored: string): string {
  if (typeof stored !== "string" || !stored) return "";
  if (!isSealedEnvelope(stored)) return stored;
  const key = ensureKey();
  if (!key) return "";
  try {
    const body = stored.slice(ENVELOPE_PREFIX.length);
    const parts = body.split(".");
    if (parts.length !== 3) return "";
    let iv: Buffer, tag: Buffer, ct: Buffer;
    
    try {
      iv = Buffer.from(parts[0], "base64url");
      tag = Buffer.from(parts[1], "base64url");
      ct = Buffer.from(parts[2], "base64url");
    } catch (error) {
      // Invalid base64url encoding
      return "";
    }
    
    // Validate IV and tag lengths
    if (!iv || iv.length !== 12 || !tag || tag.length !== 16) return "";
    
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    const opened = pt.toString("utf-8");
    if (!opened || opened.length < 20 || /\s/.test(opened)) return "";
    return opened;
  } catch (error) {
    if (!warnedKeyMissing) {
      warnedKeyMissing = true;
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(
        `[TOKEN-VAULT] failed to open a sealed token (key missing/tampered?) — treating as no-token; re-enter the PAT in [CONFIG] if this persists. Error: ${errorMessage}`
      );
    }
    return "";
  }
}

/** Public, secret-free status for the boot splash's TOKEN VAULT line. */
export function vaultStatus(): {
  sealed: boolean;
  cipher: "AES-256-GCM" | "PLAINTEXT";
  keyPresent: boolean;
  keyFile: string;
} {
  try {
    const keyPresent = existsSync(KEY_FILE);
    return {
      keyPresent,
      cipher: keyPresent ? "AES-256-GCM" : "PLAINTEXT",
      sealed: keyPresent,
      keyFile: ".git/info/loop-vault-key",
    };
  } catch (error) {
    if (!warnedKeyMissing) {
      warnedKeyMissing = true;
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(
        `[TOKEN-VAULT] error checking vault status: ${errorMessage}`
      );
    }
    return {
      keyPresent: false,
      cipher: "PLAINTEXT",
      sealed: false,
      keyFile: ".git/info/loop-vault-key",
    };
  }
}