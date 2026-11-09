import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { NextResponse } from "next/server";

const MAX_MEDIA_BYTES = 512 * 1024 * 1024;
const MAX_REDIRECTS = 5;

function isPublicAddress(address: string) {
  const version = isIP(address);
  if (version === 4) {
    const [first, second, third] = address.split(".").map(Number);
    return !(
      first === 0 || first === 10 || first === 127 || first >= 224
      || (first === 100 && second >= 64 && second <= 127)
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168)
      || (first === 192 && second === 0)
      || (first === 192 && second === 88 && third === 99)
      || (first === 198 && (second === 18 || second === 19 || second === 51 && third === 100))
      || (first === 203 && second === 0 && third === 113)
    );
  }
  if (version !== 6) return false;
  const normalized = address.toLowerCase();
  return /^[23]/.test(normalized)
    && !normalized.startsWith("2001:db8:")
    && !normalized.startsWith("2001:0000:")
    && !normalized.startsWith("2002:");
}

async function validatePublicUrl(url: URL) {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only HTTP and HTTPS media URLs are allowed.");
  }
  if (url.username || url.password) throw new Error("Media URLs cannot include credentials.");
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost")
    || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    throw new Error("Local and private media addresses are not allowed.");
  }

  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error("Media URLs must resolve only to public addresses.");
  }
  return addresses[0];
}

function requestMedia(url: URL, address: { address: string; family: number }, signal: AbortSignal) {
  return new Promise<IncomingMessage>((resolve, reject) => {
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      method: "GET",
      headers: { Accept: "*/*" },
      signal,
      lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, [address]);
        else callback(null, address.address, address.family);
      },
      ...(url.protocol === "https:" && !isIP(hostname) ? { servername: hostname } : {}),
    }, resolve);
    request.once("error", reject);
    request.end();
  });
}

async function fetchPublicMedia(url: URL, signal: AbortSignal, redirects = 0): Promise<IncomingMessage> {
  const address = await validatePublicUrl(url);
  const response = await requestMedia(url, address, signal);
  if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
    const location = response.headers.location;
    response.destroy();
    if (!location || redirects >= MAX_REDIRECTS) throw new Error("Media URL has too many redirects.");
    return fetchPublicMedia(new URL(location, url), signal, redirects + 1);
  }
  if (response.statusCode !== 200) {
    response.destroy();
    throw new Error(`The media source returned HTTP ${response.statusCode ?? "error"}.`);
  }
  const contentLength = Number(response.headers["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > MAX_MEDIA_BYTES) {
    response.destroy();
    throw new Error("Media files must be 512 MB or smaller.");
  }
  return response;
}

function streamResponse(upstream: IncomingMessage) {
  const iterator = upstream[Symbol.asyncIterator]();
  let bytesRead = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) {
          controller.close();
          return;
        }
        bytesRead += next.value.byteLength;
        if (bytesRead > MAX_MEDIA_BYTES) {
          upstream.destroy();
          controller.error(new Error("Media files must be 512 MB or smaller."));
          return;
        }
        controller.enqueue(new Uint8Array(next.value));
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return?.();
      upstream.destroy();
    },
  });
}

export async function POST(request: Request) {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    return NextResponse.json({ error: "Provide a media URL to download." }, { status: 400 });
  }
  if (typeof value !== "object" || value === null || !("url" in value) || typeof value.url !== "string") {
    return NextResponse.json({ error: "Provide a valid media URL." }, { status: 400 });
  }

  try {
    const url = new URL(value.url);
    const upstream = await fetchPublicMedia(url, request.signal);
    const headers = new Headers({ "Cache-Control": "no-store" });
    const contentType = upstream.headers["content-type"];
    const contentLength = upstream.headers["content-length"];
    if (contentType) headers.set("Content-Type", contentType);
    if (contentLength) headers.set("Content-Length", contentLength);
    return new Response(streamResponse(upstream), { headers });
  } catch (error) {
    if (request.signal.aborted) {
      return NextResponse.json({ error: "Media download was cancelled." }, { status: 499 });
    }
    const message = error instanceof Error ? error.message : "Could not download media.";
    const status = message.includes("not allowed") || message.includes("must resolve") ? 400 : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
