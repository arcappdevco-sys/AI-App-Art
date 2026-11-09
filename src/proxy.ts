import { createRemoteJWKSet, errors, jwtVerify } from "jose";
import { NextResponse, type NextRequest } from "next/server";

type CloudflareAccessConfig =
  | { kind: "disabled" }
  | { kind: "invalid" }
  | { kind: "configured"; issuer: string; audience: string; allowedEmails: Set<string> };

let cachedJwks: {
  issuer: string;
  keys: ReturnType<typeof createRemoteJWKSet>;
} | undefined;

function getCloudflareAccessConfig(): CloudflareAccessConfig {
  const teamDomain = process.env.CLOUDFLARE_ACCESS_TEAM_DOMAIN?.trim();
  const audience = process.env.CLOUDFLARE_ACCESS_AUD?.trim();
  const allowedEmailsValue = process.env.CLOUDFLARE_ACCESS_ALLOWED_EMAILS;

  if (!teamDomain && !audience && !allowedEmailsValue) {
    return process.env.NODE_ENV === "production" ? { kind: "invalid" } : { kind: "disabled" };
  }
  if (!teamDomain || !audience || !allowedEmailsValue) return { kind: "invalid" };

  let teamUrl: URL;
  try {
    teamUrl = new URL(teamDomain.startsWith("https://") ? teamDomain : `https://${teamDomain}`);
  } catch {
    return { kind: "invalid" };
  }

  if (
    teamUrl.protocol !== "https:"
    || teamUrl.username
    || teamUrl.password
    || teamUrl.pathname !== "/"
    || teamUrl.search
    || teamUrl.hash
    || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.cloudflareaccess\.com$/i.test(teamUrl.hostname)
  ) {
    return { kind: "invalid" };
  }

  const allowedEmails = new Set(
    allowedEmailsValue.split(",").map((email) => email.trim().toLowerCase()).filter(Boolean),
  );
  if (allowedEmails.size === 0) return { kind: "invalid" };

  return {
    kind: "configured",
    issuer: teamUrl.origin,
    audience,
    allowedEmails,
  };
}

function getJwks(issuer: string) {
  if (!cachedJwks || cachedJwks.issuer !== issuer) {
    cachedJwks = {
      issuer,
      keys: createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)),
    };
  }
  return cachedJwks.keys;
}

function accessResponse(status: number, message: string) {
  return NextResponse.json(
    { error: message },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export async function proxy(request: NextRequest) {
  const config = getCloudflareAccessConfig();
  if (config.kind === "disabled") return NextResponse.next();
  if (config.kind === "invalid") {
    return accessResponse(503, "Private access is not configured correctly for this deployment.");
  }

  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return accessResponse(401, "A valid Cloudflare Access session is required.");

  try {
    const { payload } = await jwtVerify(token, getJwks(config.issuer), {
      issuer: config.issuer,
      audience: config.audience,
    });

    if (typeof payload.exp !== "number") {
      return accessResponse(401, "A valid Cloudflare Access session is required.");
    }

    const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
    if (!config.allowedEmails.has(email)) {
      return accessResponse(403, "This account is not invited to use the app.");
    }
  } catch (error) {
    if (error instanceof errors.JOSEError && error.code !== "ERR_JWKS_TIMEOUT" && error.code !== "ERR_JWKS_INVALID") {
      return accessResponse(401, "A valid Cloudflare Access session is required.");
    }
    console.error("Could not verify the Cloudflare Access session.", error);
    return accessResponse(503, "Cloudflare Access verification is temporarily unavailable.");
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
