import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";

const require = createRequire(resolve("apps/web/package.json"));
const authRoot = dirname(require.resolve("next-auth"));
// Absolute paths exercise the pinned vendor implementation, not a copy of its fixes.
const internal = (path) => require(join(authRoot, path));
const { encode, decode, getToken } = require("next-auth/jwt");
const checks = internal("core/lib/oauth/checks.js");
const { defaultCookies, SessionStore } = internal("core/lib/cookie.js");
const { defaultCallbacks } = internal("core/lib/default-callbacks.js");
const { createCSRFToken } = internal("core/lib/csrf-token.js");
const signin = internal("core/routes/signin.js").default;
const callback = internal("core/routes/callback.js").default;

function options() {
  const secret = randomBytes(32).toString("hex");
  return {
    secret,
    url: new URL("https://auth.example.test/api/auth"),
    callbackUrl: "https://auth.example.test/account",
    logger: { debug() {}, warn() {}, error() {} },
    jwt: { secret, encode, decode },
    session: { strategy: "jwt", maxAge: 3600 },
    cookies: defaultCookies(true),
    callbacks: { ...defaultCallbacks },
    events: {},
    pages: {},
    provider: { id: "google", checks: ["state", "nonce", "pkce"] },
  };
}

test("both auth consumers resolve the approved exact patch", () => {
  for (const workspace of ["apps/web", "packages/features/auth"]) {
    const consumer = createRequire(resolve(workspace, "package.json"));
    assert.equal(consumer("./package.json").dependencies["next-auth"], "4.24.15");
    assert.equal(consumer(join(dirname(consumer.resolve("next-auth")), "package.json")).version, "4.24.15");
  }
});

test("malformed Bearer values fail closed without throwing", async () => {
  const { secret } = options();
  for (const authorization of ["Bearer %", "Bearer %GG", "Bearer %E0%A4%A", "Bearer", "Basic invalid", ""]) {
    for (const headers of [{ authorization }, new Headers({ authorization })]) {
      assert.equal(await getToken({ req: { headers, cookies: {} }, secret }), null);
    }
  }
  assert.equal(await getToken({ req: { headers: {}, cookies: {} }, secret }), null);
});

test("JWT sessions round trip and reject invalid, expired or wrong-key tokens", async () => {
  const { secret } = options();
  const token = await encode({ secret, token: { sub: "synthetic-user" }, maxAge: 3600 });
  const read = (value, key = secret) =>
    getToken({ req: { headers: { authorization: `Bearer ${value}` }, cookies: {} }, secret: key });
  assert.equal((await read(token)).sub, "synthetic-user");
  assert.equal(await read(`${token}tampered`), null);
  assert.equal(await read(token, randomBytes(32).toString("hex")), null);
  assert.equal(await read(await encode({ secret, token: { sub: "synthetic-user" }, maxAge: -60 })), null);
  const decoded = await getToken({
    req: { headers: { authorization: "Bearer %" }, cookies: { "__Secure-next-auth.session-token": token } },
    secret,
    secureCookie: true,
  });
  assert.equal(decoded.sub, "synthetic-user");
});

for (const kind of ["state", "nonce", "pkce"]) {
  test(`${kind}: valid provider-bound round trip clears the transient cookie`, async () => {
    const config = options();
    const cookies = [];
    const params = {};
    await checks[kind].create(config, cookies, params);
    assert.equal(cookies.length, 1);
    const [cookie] = cookies;
    const result = {};
    const cleared = [];
    await checks[kind].use({ [cookie.name]: cookie.value }, cleared, config, result);
    if (kind === "pkce") {
      assert.equal(params.code_challenge_method, "S256");
      assert.equal(
        createHash("sha256").update(result.code_verifier).digest("base64url"),
        params.code_challenge
      );
    } else {
      assert.equal(result[kind], params[kind]);
    }
    assert.equal(cleared[0].name, cookie.name);
    assert.equal(cleared[0].value, "");
    assert.equal(cleared[0].options.maxAge, 0);
  });

  test(`${kind}: cross-provider, missing, tampered, expired and legacy cookies are rejected`, async () => {
    const config = options();
    const cookies = [];
    await checks[kind].create(config, cookies, {});
    const [cookie] = cookies;
    const use = (value, candidate = config) => checks[kind].use({ [cookie.name]: value }, [], candidate, {});
    await assert.rejects(
      use(cookie.value, { ...config, provider: { ...config.provider, id: "azure-ad" } }),
      /different provider/
    );
    await assert.rejects(use(undefined), /missing/);
    await assert.rejects(use(`${cookie.value}tampered`));
    await assert.rejects(
      use(
        await encode({
          ...config.jwt,
          salt: cookie.name,
          maxAge: -60,
          token: { value: "fixture", provider: "google" },
        })
      )
    );
    await assert.rejects(
      use(await encode({ ...config.jwt, salt: cookie.name, token: { value: "legacy" } })),
      /different provider/
    );
  });
}

function emailFixture() {
  const config = options();
  const sent = [];
  const tokens = new Map();
  const key = ({ identifier, token }) => JSON.stringify([identifier, token]);
  const user = { id: "synthetic-user", email: "user@example.test", emailVerified: null };
  config.provider = {
    id: "email",
    type: "email",
    maxAge: 36_000,
    sendVerificationRequest: async (message) => {
      sent.push(message);
    },
  };
  config.adapter = {
    getUserByEmail: async (email) => ({ ...user, email }),
    updateUser: async (data) => ({ ...user, ...data }),
    createVerificationToken: async (record) => {
      tokens.set(key(record), record);
      return record;
    },
    // Model the existing Prisma adapter's atomic delete without touching a database.
    useVerificationToken: async (record) => {
      const stored = tokens.get(key(record)) ?? null;
      tokens.delete(key(record));
      return stored;
    },
  };
  const request = (email) => signin({ options: config, query: {}, body: { email } });
  const redeem = (email, token) =>
    callback({
      options: config,
      query: { email, token },
      sessionStore: new SessionStore(
        config.cookies.sessionToken,
        { cookies: {}, headers: {} },
        config.logger
      ),
    });
  return { config, sent, tokens, request, redeem };
}

test("email normalization accepts legitimate Unicode addresses", async () => {
  for (const email of [" User@Example.Test ", "ｕｓｅｒ＠ｅｘａｍｐｌｅ．ｔｅｓｔ", "user@example.test"]) {
    const fixture = emailFixture();
    assert.match((await fixture.request(email)).redirect, /verify-request/);
    assert.equal(fixture.sent.length, 1);
    assert.equal(fixture.sent[0].identifier, "user@example.test");
  }
});

test("email normalization rejects extra separators before delivery", async () => {
  for (const email of [
    "user＠other.test@example.test",
    "user@other.test＠example.test",
    "user@@example.test",
    "@example.test",
    "user@",
    '"user"@example.test',
  ]) {
    const fixture = emailFixture();
    assert.match((await fixture.request(email)).redirect, /error=EmailSignin/);
    assert.equal(fixture.sent.length, 0);
    assert.equal(fixture.tokens.size, 0);
  }
});

test("magic links keep the existing ten-hour lifetime, store a hash and redeem once", async () => {
  const fixture = emailFixture();
  const started = Date.now();
  await fixture.request("user@example.test");
  const [message] = fixture.sent;
  const [stored] = fixture.tokens.values();
  assert.notEqual(stored.token, message.token);
  assert.ok(stored.expires.valueOf() >= started + 36_000_000);
  assert.ok(stored.expires.valueOf() <= Date.now() + 36_000_000);
  const result = await fixture.redeem(message.identifier, message.token);
  assert.equal(result.redirect, fixture.config.callbackUrl);
  const session = result.cookies.find((cookie) => cookie.name === fixture.config.cookies.sessionToken.name);
  assert.ok(session);
  assert.equal((await decode({ ...fixture.config.jwt, token: session.value })).sub, "synthetic-user");
  assert.match((await fixture.redeem(message.identifier, message.token)).redirect, /error=Verification/);
});

test("expired, wrong-token and wrong-identifier magic links create no session", async () => {
  for (const failure of ["expired", "token", "identifier"]) {
    const fixture = emailFixture();
    await fixture.request("user@example.test");
    const [message] = fixture.sent;
    if (failure === "expired") [...fixture.tokens.values()][0].expires = new Date(0);
    const result = await fixture.redeem(
      failure === "identifier" ? "other@example.test" : message.identifier,
      failure === "token" ? "invalid" : message.token
    );
    assert.match(result.redirect, /error=Verification/);
    assert.deepEqual(result.cookies, []);
  }
});

test("denied sign-in sends no magic link", async () => {
  const fixture = emailFixture();
  fixture.config.callbacks.signIn = async () => false;
  assert.match((await fixture.request("user@example.test")).redirect, /error=AccessDenied/);
  assert.equal(fixture.sent.length, 0);
  assert.equal(fixture.tokens.size, 0);
});

test("CSRF requires a signed cookie and matching POST body", () => {
  const config = options();
  const issued = createCSRFToken({ options: config });
  const verify = (cookieValue, bodyValue, isPost = true) =>
    createCSRFToken({ options: config, cookieValue, bodyValue, isPost }).csrfTokenVerified === true;
  assert.equal(verify(issued.cookie, issued.csrfToken), true);
  assert.equal(verify(issued.cookie, issued.csrfToken, false), false);
  assert.equal(verify(issued.cookie, "wrong"), false);
  assert.equal(verify(issued.cookie, undefined), false);
  assert.equal(verify(undefined, issued.csrfToken), false);
  assert.equal(verify(`${issued.csrfToken}|invalid`, issued.csrfToken), false);
});
