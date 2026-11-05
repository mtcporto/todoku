import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import type { CustomFetch } from "openid-client";
import type { GoogleConfig } from "../../src/lib/mail/google-oidc.ts";
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const otherKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
export const config: GoogleConfig = {
  origin: "https://todoku.test",
  clientId: "fixture.apps.googleusercontent.com",
  clientSecret: "private-oauth-fixture",
  ownerUserId: "alice",
  allowedEmail: "owner@example.invalid",
};
export const issuer = "https://accounts.google.com";
export function provider() {
  let authorization: URL;
  const override: Record<string, unknown> = {};
  let invalidSignature = false,
    tokenCalls = 0,
    jwksCalls = 0;
  const fetcher: CustomFetch = async (url, init) => {
    assert.equal(init.redirect, "manual");
    if (url === "https://www.googleapis.com/oauth2/v3/certs") {
      jwksCalls++;
      return Response.json({
        keys: [
          {
            ...keys.publicKey.export({ format: "jwk" }),
            kid: "fixture-key",
            alg: "RS256",
            use: "sig",
          },
        ],
      });
    }
    assert.equal(url, "https://oauth2.googleapis.com/token");
    tokenCalls++;
    const body = new URLSearchParams(init.body as URLSearchParams);
    assert.equal(body.get("client_id"), config.clientId);
    assert.equal(body.get("client_secret"), config.clientSecret);
    assert.equal(
      body.get("redirect_uri"),
      config.origin + "/api/mail/oidc/google/callback",
    );
    assert.equal(body.get("grant_type"), "authorization_code");
    assert.equal(body.get("code"), "valid-code");
    assert.equal(
      createHash("sha256")
        .update(body.get("code_verifier")!)
        .digest("base64url"),
      authorization.searchParams.get("code_challenge"),
    );
    const now = Math.floor(Date.now() / 1000);
    const encoded = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    const jwt = [
      encoded({ alg: "RS256", kid: "fixture-key" }),
      encoded({
        iss: issuer,
        aud: config.clientId,
        sub: "google-owner-sub",
        iat: now,
        exp: now + 600,
        nonce: authorization.searchParams.get("nonce"),
        email: config.allowedEmail,
        email_verified: true,
        ...override,
      }),
    ].join(".");
    const signature = sign(
      "RSA-SHA256",
      Buffer.from(jwt),
      invalidSignature ? otherKeys.privateKey : keys.privateKey,
    ).toString("base64url");
    return Response.json({
      access_token: "unused-provider-access-token",
      token_type: "Bearer",
      expires_in: 600,
      id_token: jwt + "." + signature,
    });
  };
  return {
    fetcher,
    override,
    get tokenCalls() {
      return tokenCalls;
    },
    get jwksCalls() {
      return jwksCalls;
    },
    invalidSignature: () => {
      invalidSignature = true;
    },
    setAuthorization: (url: URL) => {
      authorization = url;
    },
  };
}
