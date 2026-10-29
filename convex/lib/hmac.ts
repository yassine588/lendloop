/**
 * Bidirectional HMAC-SHA256 signing & verification utilities for Convex <-> n8n.
 *
 * Uses the standard Web Crypto API (`crypto.subtle`) so it executes natively inside
 * Convex V8 isolates (`httpAction` / `internalAction`), Node.js 20+, and Edge runtimes.
 */

export const SIGNATURE_HEADER = "x-lendloop-signature";
export const TIMESTAMP_HEADER = "x-lendloop-timestamp";
export const IDEMPOTENCY_HEADER = "x-idempotency-key";

/** Default replay protection window: 5 minutes (300 seconds) */
export const DEFAULT_MAX_SKEW_SECONDS = 300;

const encoder = new TextEncoder();

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Constant-time comparison of two strings to prevent timing side-channel attacks.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  if (aBytes.length !== bBytes.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) {
    diff |= aBytes[i] ^ bBytes[i];
  }
  return diff === 0;
}

/**
 * Builds the canonical signing string `${timestamp}.${rawBody}`.
 */
export function buildCanonicalSigningString(
  timestampSeconds: number | string,
  rawBody: string
): string {
  return `${timestampSeconds}.${rawBody}`;
}

/**
 * Computes HMAC-SHA256 hex digest for `${timestamp}.${rawBody}` using `secret`.
 */
export async function computeHmacSha256Hex(
  secret: string,
  timestampSeconds: number | string,
  rawBody: string
): Promise<string> {
  if (!secret || secret.trim().length < 16) {
    throw new Error(
      "LENDLOOP_WEBHOOK_SECRET must be configured and at least 16 characters long."
    );
  }
  const keyData = encoder.encode(secret);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const canonical = buildCanonicalSigningString(timestampSeconds, rawBody);
  const signatureBuffer = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    encoder.encode(canonical)
  );
  return bytesToHex(new Uint8Array(signatureBuffer));
}

/**
 * Generates headers for an outbound HMAC-signed webhook request.
 */
export async function signWebhookPayload(params: {
  secret: string;
  rawBody: string;
  idempotencyKey: string;
  timestampSeconds?: number;
}): Promise<{
  [SIGNATURE_HEADER]: string;
  [TIMESTAMP_HEADER]: string;
  [IDEMPOTENCY_HEADER]: string;
  "content-type": string;
}> {
  const ts =
    params.timestampSeconds ?? Math.floor(Date.now() / 1000);
  const digest = await computeHmacSha256Hex(params.secret, ts, params.rawBody);
  return {
    [SIGNATURE_HEADER]: `sha256=${digest}`,
    [TIMESTAMP_HEADER]: String(ts),
    [IDEMPOTENCY_HEADER]: params.idempotencyKey,
    "content-type": "application/json",
  };
}

export interface VerifyHmacResult {
  valid: boolean;
  reason?: string;
}

/**
 * Verifies an inbound webhook request's timestamp freshness and HMAC-SHA256 signature.
 * Accepts signatures formatted either as `sha256=<hex>` or `<hex>`.
 */
export async function verifyWebhookSignature(params: {
  secret: string | undefined;
  signatureHeader: string | null;
  timestampHeader: string | null;
  rawBody: string;
  nowSeconds?: number;
  maxSkewSeconds?: number;
}): Promise<VerifyHmacResult> {
  const {
    secret,
    signatureHeader,
    timestampHeader,
    rawBody,
    nowSeconds = Math.floor(Date.now() / 1000),
    maxSkewSeconds = DEFAULT_MAX_SKEW_SECONDS,
  } = params;

  if (!secret || secret.trim().length < 16) {
    return {
      valid: false,
      reason: "Server webhook secret is not configured.",
    };
  }

  if (!signatureHeader || !timestampHeader) {
    return {
      valid: false,
      reason: "Missing X-LendLoop-Signature or X-LendLoop-Timestamp header.",
    };
  }

  const parsedTimestamp = Number(timestampHeader.trim());
  if (!Number.isFinite(parsedTimestamp) || parsedTimestamp <= 0) {
    return {
      valid: false,
      reason: "Invalid X-LendLoop-Timestamp header format.",
    };
  }

  // Normalize millisecond timestamps if an external caller sent ms instead of s
  const timestampSeconds =
    parsedTimestamp > 1e11 ? Math.floor(parsedTimestamp / 1000) : parsedTimestamp;

  const skew = Math.abs(nowSeconds - timestampSeconds);
  if (skew > maxSkewSeconds) {
    return {
      valid: false,
      reason: `Timestamp outside allowed replay window (${skew}s > ${maxSkewSeconds}s).`,
    };
  }

  const normalizedProvided = signatureHeader
    .trim()
    .toLowerCase()
    .replace(/^sha256=/, "");

  if (!/^[0-9a-f]{64}$/.test(normalizedProvided)) {
    return {
      valid: false,
      reason: "Malformed HMAC-SHA256 hex digest.",
    };
  }

  // Compute expected digest using the exact header string provided by the caller
  const expectedDigest = await computeHmacSha256Hex(
    secret,
    timestampHeader.trim(),
    rawBody
  );

  if (!constantTimeEqual(normalizedProvided, expectedDigest)) {
    return {
      valid: false,
      reason: "HMAC signature mismatch.",
    };
  }

  return { valid: true };
}
