import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { test } from "node:test";

const rootRequire = createRequire(resolve("package.json"));

function via(parent, dependency) {
  try {
    return createRequire(parent.resolve(`${dependency}/package.json`));
  } catch (error) {
    if (error.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
    return createRequire(parent.resolve(dependency));
  }
}

const webRequire = createRequire(resolve("apps/web/package.json"));
const samlRequire = via(webRequire, "@boxyhq/saml20");
const exchangeWorkspaceRequire = createRequire(
  resolve("packages/app-store/exchange2013calendar/package.json")
);
const exchangeRequire = via(exchangeWorkspaceRequire, "ews-javascript-api");
const docsRequire = createRequire(resolve("apps/docs/package.json"));
const nextraRequire = via(docsRequire, "nextra");
const mathjaxReactRequire = via(nextraRequire, "better-react-mathjax");
const mathjaxRequire = via(mathjaxReactRequire, "mathjax-full");
const speechRequire = via(mathjaxRequire, "speech-rule-engine");

const branches = [
  { version: "0.8.15", api: exchangeRequire("@xmldom/xmldom") },
  { version: "0.9.12", api: speechRequire("@xmldom/xmldom") },
];

function serializeStrict(api, version, node) {
  const serializer = new api.XMLSerializer();
  return version.startsWith("0.8.")
    ? serializer.serializeToString(node, false, null, { requireWellFormed: true })
    : serializer.serializeToString(node, { requireWellFormed: true });
}

function assertInvalidState(action) {
  assert.throws(action, (error) => error?.name === "InvalidStateError" || error?.code === 11);
}

function serializationFixtures(api) {
  const implementation = new api.DOMImplementation();
  const document = implementation.createDocument(null, "r", null);
  // The patched changelog identifies `?` and `>` in PI targets as the boundary-crossing bypass.
  const processingInstruction = document.createProcessingInstruction("p?><x", "d");
  const processingInstructionData = document.createProcessingInstruction("p", "a?>b");
  const comment = document.createComment("a-->b");
  const cdata = document.createCDATASection("a");
  cdata.data = "a]]>b";
  const doctype = implementation.createDocumentType("r", "", "");
  implementation.createDocument(null, "r", doctype);
  doctype.name = "r>";
  const entityReference = document.createEntityReference("ok");
  entityReference.nodeName = "bad name";
  return { processingInstruction, processingInstructionData, comment, cdata, doctype, entityReference };
}

test("xmldom selectors, installed consumer graph and lock use only approved versions", () => {
  const resolutions = rootRequire("./package.json").resolutions;
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(resolutions).filter(([selector]) => selector.startsWith("@xmldom/xmldom@"))
    ),
    {
      "@xmldom/xmldom@0.9.8": "0.9.12",
      "@xmldom/xmldom@0.9.9": "0.9.12",
      "@xmldom/xmldom@^0.8.1": "0.8.15",
      "@xmldom/xmldom@^0.8.5": "0.8.15",
      "@xmldom/xmldom@^0.8.8": "0.8.15",
      "@xmldom/xmldom@^0.8.10": "0.8.15",
    }
  );

  assert.equal(samlRequire("@xmldom/xmldom/package.json").version, "0.9.12");
  assert.equal(exchangeRequire("@xmldom/xmldom/package.json").version, "0.8.15");
  assert.equal(speechRequire("@xmldom/xmldom/package.json").version, "0.9.12");

  const lock = readFileSync(resolve("yarn.lock"), "utf8");
  const versions = [...lock.matchAll(/^\s+resolution: "@xmldom\/xmldom@npm:([^"]+)"$/gm)]
    .map((match) => match[1])
    .sort();
  assert.deepEqual(versions, ["0.8.15", "0.9.12"]);
  assert.doesNotMatch(lock, /^\s+resolution: "@xmldom\/xmldom@npm:(?:0\.8\.12|0\.9\.9)"$/m);
});

test("default serialization remains permissive without implying consumer strict mode", () => {
  for (const { api } of branches) {
    const serializer = new api.XMLSerializer();
    const fixtures = serializationFixtures(api);
    assert.equal(serializer.serializeToString(fixtures.processingInstruction), "<?p?><x d?>");
    assert.equal(serializer.serializeToString(fixtures.processingInstructionData), "<?p a?>b?>");
    assert.equal(serializer.serializeToString(fixtures.comment), "<!--a-->b-->");
    assert.equal(serializer.serializeToString(fixtures.cdata), "<![CDATA[a]]]]><![CDATA[>b]]>");
    assert.equal(serializer.serializeToString(fixtures.doctype), "<!DOCTYPE r>>");
    assert.equal(serializer.serializeToString(fixtures.entityReference), "&bad name;");
  }
});

test("strict serialization rejects processing-instruction target injection from CVE-2026-83616", () => {
  for (const { api, version } of branches) {
    const { processingInstruction } = serializationFixtures(api);
    assertInvalidState(() => serializeStrict(api, version, processingInstruction));
  }
});

test("strict serialization rejects reviewed PI, comment, CDATA, doctype and entity cases", () => {
  for (const { api, version } of branches) {
    const fixtures = serializationFixtures(api);
    for (const node of [
      fixtures.processingInstructionData,
      fixtures.comment,
      fixtures.cdata,
      fixtures.doctype,
      fixtures.entityReference,
    ]) {
      assertInvalidState(() => serializeStrict(api, version, node));
    }
    const document = new api.DOMImplementation().createDocument(null, "r", null);
    assert.throws(
      () => document.createEntityReference("bad name"),
      (error) => error?.name === "InvalidCharacterError" || error?.code === 5
    );
    assert.throws(
      () => document.createCDATASection("a]]>b"),
      (error) => error?.name === "InvalidCharacterError" || error?.code === 5
    );
  }
});

test("malformed end tags are reported while parser recovery stays deterministic", () => {
  for (const { api, version } of branches) {
    const reports = [];
    const onError = (level, _message) => reports.push(level);
    const options = version.startsWith("0.8.") ? { errorHandler: onError } : { onError };
    const document = new api.DOMParser(options).parseFromString("<r></r\nx>", "application/xml");
    assert.equal(document.documentElement.tagName, "r");
    assert.ok(reports.includes("error"));
  }
});

test("deep document serialization uses iterative traversal", { timeout: 5000 }, () => {
  for (const { api } of branches) {
    const document = new api.DOMImplementation().createDocument(null, "r", null);
    let parent = document.documentElement;
    for (let index = 0; index < 6000; index += 1) {
      const child = document.createElement("n");
      parent.appendChild(child);
      parent = child;
    }
    const serialized = new api.XMLSerializer().serializeToString(document);
    assert.equal(serialized.length, 42_004);
    assert.ok(serialized.startsWith("<r><n>"));
    assert.ok(serialized.endsWith("</n></r>"));
  }
});

test("SAML public parser smoke only—not authentication or integration coverage", () => {
  const samlModule = webRequire("@boxyhq/saml20");
  const saml = samlModule.default || samlModule;
  const xml =
    '<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"><saml:Issuer>fixture</saml:Issuer></samlp:Response>';
  assert.equal(saml.parseIssuer(xml), "fixture");
});

test("Exchange EWS public parser smoke only—not service integration coverage", () => {
  const ews = exchangeWorkspaceRequire("ews-javascript-api");
  const xml =
    '<m:Envelope xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages"><m:Value>ok</m:Value></m:Envelope>';
  const document = new ews.DOMParser().parseFromString(xml, "application/xml");
  const parsed = new ews.xml2JsObject().parseXMLNode(document.documentElement, true);
  assert.equal(document.documentElement.localName, "Envelope");
  assert.equal(parsed.Value, "ok");
});

test.skip("plist consumer path remains unproven because lingo.dev exposes no public plist API", () => {});

test("speech-rule-engine public parser smoke only—not MathJax integration coverage", () => {
  const speech = mathjaxRequire("speech-rule-engine");
  const semantic = speech.toSemantic("<math><mi>x</mi></math>");
  assert.equal(semantic.tagName, "stree");
  assert.equal(semantic.textContent, "x");
  assert.match(String(semantic), /<stree>[\s\S]*<identifier[^>]*>x<\/identifier>[\s\S]*<\/stree>/);
});
