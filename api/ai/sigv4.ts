const enc = new TextEncoder();

export interface Creds { accessKey: string; secretKey: string; sessionToken?: string; }

export function credsFromEnv(): Creds | null {
  const a = Deno.env.get("AWS_ACCESS_KEY_ID");
  const s = Deno.env.get("AWS_SECRET_ACCESS_KEY");
  if (!a || !s) return null;
  return { accessKey: a, secretKey: s, sessionToken: Deno.env.get("AWS_SESSION_TOKEN") };
}

function toBuffer(b: Uint8Array): ArrayBuffer {
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", toBuffer(data)));
}

async function hmac(key: Uint8Array, data: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", toBuffer(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
}

function hex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function uriEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (ch) => "%" + ch.charCodeAt(0).toString(16).toUpperCase());
}

export function iso8601(d: Date): string {
  return d.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

export async function sign(
  creds: Creds,
  opts: { method: string; host: string; region: string; service: string; path: string; query?: string; body: Uint8Array },
): Promise<Record<string, string>> {
  const { method, host, region, service, path, body } = opts;
  const amzDate = iso8601(new Date());
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = hex(await sha256(body));

  const canonicalHeaders = `host:${host}\n` + (opts.query ? `x-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n` : `x-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`);
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = [
    method,
    uriEncode(path),
    opts.query ?? "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, hex(await sha256(enc.encode(canonicalRequest)))].join("\n");

  let kDate = await hmac(enc.encode("AWS4" + creds.secretKey), dateStamp);
  kDate = await hmac(kDate, region);
  kDate = await hmac(kDate, service);
  const signingKey = await hmac(kDate, "aws4_request");
  const signature = hex(await hmac(signingKey, stringToSign));

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    "x-amz-security-token": creds.sessionToken ?? "",
    authorization: `AWS4-HMAC-SHA256 Credential=${creds.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
  if (!creds.sessionToken) delete headers["x-amz-security-token"];
  return headers;
}
