import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const authPath = new URL("../agents/skills/calcom-api/references/authentication.md", import.meta.url);
const readmePath = new URL("../packages/platform/examples/base/README.md", import.meta.url);
const tokens = {
  CAL_API_KEY: "synthetic api marker with spaces",
  CAL_MANAGED_USER_TOKEN: "synthetic managed marker with spaces",
  CAL_CLIENT_ID: "synthetic client id with spaces",
  CAL_CLIENT_SECRET: "synthetic client secret with spaces",
};

function required(name) {
  return `\${${name}:?Set ${name} before this request}`;
}

const requests = [
  {
    method: "GET",
    url: "https://api.cal.com/v2/bookings",
    required: ["CAL_API_KEY"],
    headers: [`Authorization: Bearer ${tokens.CAL_API_KEY}`, "Content-Type: application/json"],
    shellHeaders: [`Authorization: Bearer ${required("CAL_API_KEY")}`, "Content-Type: application/json"],
  },
  {
    method: "GET",
    url: "https://api.cal.com/v2/bookings",
    required: ["CAL_CLIENT_ID", "CAL_CLIENT_SECRET", "CAL_MANAGED_USER_TOKEN"],
    headers: [
      `x-cal-client-id: ${tokens.CAL_CLIENT_ID}`,
      `x-cal-secret-key: ${tokens.CAL_CLIENT_SECRET}`,
      `Authorization: Bearer ${tokens.CAL_MANAGED_USER_TOKEN}`,
      "Content-Type: application/json",
    ],
    shellHeaders: [
      `x-cal-client-id: ${required("CAL_CLIENT_ID")}`,
      `x-cal-secret-key: ${required("CAL_CLIENT_SECRET")}`,
      `Authorization: Bearer ${required("CAL_MANAGED_USER_TOKEN")}`,
      "Content-Type: application/json",
    ],
  },
  {
    method: "POST",
    url: "https://api.cal.com/v2/bookings",
    required: ["CAL_API_KEY"],
    headers: [
      `Authorization: Bearer ${tokens.CAL_API_KEY}`,
      "cal-api-version: 2024-08-13",
      "Content-Type: application/json",
    ],
    shellHeaders: [
      `Authorization: Bearer ${required("CAL_API_KEY")}`,
      "cal-api-version: 2024-08-13",
      "Content-Type: application/json",
    ],
    body: '{"start": "2024-01-15T10:00:00Z", "eventTypeId": 123, ...}',
  },
  {
    method: "GET",
    url: "https://api.cal.com/v2/me",
    required: ["CAL_API_KEY"],
    headers: [`Authorization: Bearer ${tokens.CAL_API_KEY}`, "Content-Type: application/json"],
    shellHeaders: [`Authorization: Bearer ${required("CAL_API_KEY")}`, "Content-Type: application/json"],
  },
];

function curlBlocks(document) {
  return [...document.matchAll(/```bash\n([\s\S]*?)\n```/g)]
    .map((match) => match[1])
    .filter((block) => /^curl -X /m.test(block));
}

function approvedBlock({ method, url, shellHeaders, body }) {
  const lines = [
    `curl -X ${method} "${url}"`,
    ...shellHeaders.map((header) => `  -H "${header}"`),
    ...(body ? [`  -d '${body}'`] : []),
  ];
  return lines.map((line, index) => (index < lines.length - 1 ? `${line} \\` : line)).join("\n");
}

function onlyApprovedBlocks(blocks) {
  return (
    blocks.length === requests.length &&
    blocks.every((block, index) => block.trim() === approvedBlock(requests[index]))
  );
}

const mockPrelude = `PATH="$CAL_DOC_MOCK_BIN"; export PATH
curl() { printf '%s\\0' "$@" > "$CAL_DOC_CURL_ARGS"; }
[[ "$PATH" == "$CAL_DOC_MOCK_BIN" && "$(type -t curl)" == function ]] || exit 70`;

async function withMockCurl(run) {
  const directory = await mkdtemp(
    join(process.env.CALCOM_SECURITY_TEST_TMP_ROOT || tmpdir(), "cal-doc-curl-")
  );
  const argsPath = join(directory, "arguments");
  try {
    const probe = spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", `${mockPrelude}\ntype -t curl`], {
      encoding: "utf8",
      env: { PATH: directory, CAL_DOC_MOCK_BIN: directory, CAL_DOC_CURL_ARGS: argsPath },
    });
    assert.equal(probe.status, 0);
    assert.equal(probe.stdout.trim(), "function");
    await assert.rejects(access(argsPath));
    await run({ directory, argsPath });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function runExample(block, directory, argsPath, values) {
  // This host's Bash resets PATH during startup; set it inside Bash and make curl a shell function.
  return spawnSync("/bin/bash", ["--noprofile", "--norc", "-i", "-c", `${mockPrelude}\n${block}`], {
    encoding: "utf8",
    env: { PATH: directory, CAL_DOC_MOCK_BIN: directory, CAL_DOC_CURL_ARGS: argsPath, ...values },
  });
}

test("mock-only preflight resolves curl to a function without any request", async () => {
  await withMockCurl(async () => {});
});

test("documented curl requests require supplied values and preserve method, URL, headers and quoting", async () => {
  const document = await readFile(authPath, "utf8");
  const blocks = curlBlocks(document);
  assert.ok(onlyApprovedBlocks(blocks), "only exact approved curl blocks may execute in the mock harness");

  await withMockCurl(async ({ directory, argsPath }) => {
    for (const [index, block] of blocks.entries()) {
      const expected = requests[index];

      for (const name of expected.required) {
        for (const missing of [undefined, ""]) {
          await rm(argsPath, { force: true });
          const values = { ...tokens };
          if (missing === undefined) delete values[name];
          else values[name] = missing;
          const result = runExample(block, directory, argsPath, values);
          assert.ok(!result.error, "interactive shell must start");
          assert.ok(result.stderr.includes(name), `${name} must fail inside the interactive request`);
          await assert.rejects(access(argsPath));
        }
      }

      const result = runExample(block, directory, argsPath, tokens);
      assert.equal(result.status, 0);
      const argsBuffer = await readFile(argsPath, "utf8");
      const args = argsBuffer.split("\0").slice(0, -1);
      assert.deepEqual(args.slice(0, 3), ["-X", expected.method, expected.url]);
      const headers = args.flatMap((arg, position) => (arg === "-H" ? [args[position + 1]] : []));
      assert.ok(
        headers.length === expected.headers.length &&
          headers.every((header, position) => header === expected.headers[position]),
        "header arguments must preserve supplied values and boundaries"
      );
      if (expected.body) assert.deepEqual(args.slice(-2), ["-d", expected.body]);
      else assert.equal(args.length, 3 + 2 * expected.headers.length);
    }
  });
});

test("the harness rejects removed guards, restored literals and broken quoting before execution", async () => {
  const blocks = curlBlocks(await readFile(authPath, "utf8"));
  assert.ok(onlyApprovedBlocks(blocks));
  const original = blocks[0];
  const guard = required("CAL_API_KEY");
  for (const mutation of [
    original.replace(guard, `\${CAL_API_KEY}`),
    original.replace(guard, "synthetic-literal-marker"),
    original.replace(`"Authorization: Bearer ${guard}"`, `Authorization: Bearer ${guard}`),
  ]) {
    assert.ok(!onlyApprovedBlocks([mutation, ...blocks.slice(1)]));
  }
});

test("HTTP examples use placeholders rather than literal authorization material", async () => {
  const document = await readFile(authPath, "utf8");
  const httpBlocks = [...document.matchAll(/```http\n([\s\S]*?)\n```/g)].map((match) => match[1]);
  const headers = httpBlocks.flatMap((block) =>
    block.split("\n").filter((line) => line.startsWith("Authorization:"))
  );
  assert.equal(headers.length, 4);
  assert.ok(
    headers.every((line) =>
      ["Authorization: Bearer <CAL_API_KEY>", "Authorization: Bearer <MANAGED_USER_ACCESS_TOKEN>"].includes(
        line
      )
    )
  );
  assert.ok(!/export CAL_API_KEY=["']?cal_(?:live|test)_/.test(document));
});

test("the base example requests a new local JWT secret without embedding or generating one in CI", async () => {
  const document = await readFile(readmePath, "utf8");
  assert.ok(/^JWT_SECRET="<GENERATE_A_UNIQUE_LOCAL_SECRET>"$/m.test(document));
  assert.ok(/JWT_SECRET.*locally/i.test(document));
  assert.ok(!/^JWT_SECRET="[A-Za-z0-9]{20,}"$/m.test(document));

  const command = document.match(/node -e '([^']+)'/)?.[1];
  assert.ok(command === 'console.log(require("node:crypto").randomBytes(32).toString("hex"))');
  let output;
  runInNewContext(command, {
    require(moduleName) {
      assert.equal(moduleName, "node:crypto");
      return {
        randomBytes(length) {
          assert.equal(length, 32);
          return {
            toString(encoding) {
              assert.equal(encoding, "hex");
              return "synthetic-jwt-marker";
            },
          };
        },
      };
    },
    console: {
      log(value) {
        output = value;
      },
    },
  });
  assert.equal(output, "synthetic-jwt-marker");
});
