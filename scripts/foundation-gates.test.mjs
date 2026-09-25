import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse, stringify } from "yaml";
import { checkPins, checkReport } from "./foundation-gates.mjs";

const checkedWorkflow = readFileSync(".github/workflows/foundation-ci.yml", "utf8");

const image = (findings = []) => ({
  SchemaVersion: 2,
  ArtifactType: "container_image",
  Results: [
    { Class: "os-pkgs", Packages: [{ Name: "os-fixture" }], Vulnerabilities: findings },
    { Class: "lang-pkgs", Type: "node-pkg", Packages: [{ Name: "node-fixture" }] },
  ],
});
const sarif = (results = [], score = "9.8") => ({
  runs: [
    {
      tool: {
        driver: { name: "CodeQL", rules: [{ id: "risk", properties: { "security-severity": score } }] },
      },
      results,
    },
  ],
});

test("missing and malformed reports fail closed", () => {
  for (const kind of ["image", "config", "dependencies", "gitleaks", "codeql", "unknown"]) {
    assert.throws(() => checkReport(kind, {}));
  }
  assert.throws(() => checkReport("image", image([{}])));
  assert.throws(() => checkReport("image", { Results: [] }));
  assert.throws(() => checkReport("codeql", { runs: [] }));
});

test("unapproved image findings cannot be hidden by fixability or a fabricated approval", () => {
  for (const Severity of ["HIGH", "CRITICAL", "UNKNOWN"]) {
    for (const FixedVersion of ["", "2.0"]) {
      assert.throws(() => checkReport("image", image([{ Severity, FixedVersion, approved: true }])));
    }
  }
  checkReport("image", image());
  assert.throws(() => checkReport("dependencies", image()));
  const dependencies = { ...image(), ArtifactType: "filesystem" };
  dependencies.Results = [{ ...image().Results[1], Type: "yarn" }];
  checkReport("dependencies", dependencies);
  dependencies.Results[0].Vulnerabilities = [{ Severity: "CRITICAL" }];
  assert.throws(() => checkReport("dependencies", dependencies));
  const nodeReport = image();
  nodeReport.Results[1].Vulnerabilities = [{ Severity: "CRITICAL" }];
  assert.throws(() => checkReport("image", nodeReport));
});

test("configuration failures and secret findings block eligibility", () => {
  const report = {
    SchemaVersion: 2,
    ArtifactType: "filesystem",
    Results: [
      { Class: "config", Type: "dockerfile", Misconfigurations: [{ Severity: "HIGH", ID: "unsafe" }] },
    ],
  };
  assert.throws(() => checkReport("config", report));
  assert.throws(() => checkReport("gitleaks", [{ RuleID: "fixture" }]));
  checkReport("gitleaks", []);
});

test("image coverage requires OS and Node packages from the expected scanner schema", () => {
  const valid = image();
  for (const report of [
    { ...valid, Results: valid.Results.slice(0, 1) },
    { ...valid, Results: valid.Results.slice(1) },
    { ...valid, Results: [valid.Results[0], { ...valid.Results[1], Packages: [] }] },
    { ...valid, Results: [{ ...valid.Results[0], Packages: undefined }, valid.Results[1]] },
    { ...valid, ArtifactType: "filesystem" },
    { ...valid, SchemaVersion: undefined },
  ]) {
    assert.throws(() => checkReport("image", report));
  }
});

test("CodeQL high findings, missing metadata and failed analysis block eligibility", () => {
  checkReport("codeql", sarif());
  assert.throws(() => checkReport("codeql", sarif([{ ruleId: "risk" }])));
  assert.throws(() => checkReport("codeql", sarif([{ ruleId: "missing" }])));
  assert.throws(() => checkReport("codeql", sarif([{ ruleId: "risk" }], "invalid")));
  const failed = sarif();
  failed.runs[0].invocations = [{ executionSuccessful: false }];
  assert.throws(() => checkReport("codeql", failed));
});

test("mutable actions/images and privileged workflow shortcuts are rejected", () => {
  const pinnedBase = `FROM node:24@sha256:${"a".repeat(64)}`;
  assert.throws(() => checkPins("", ""));
  assert.throws(() => checkPins("   FROM node:24", ""));
  assert.throws(() => checkPins("FROM node", ""));
  assert.throws(() => checkPins("FROM --platform=linux/amd64 node:24 AS builder", ""));
  assert.throws(() => checkPins("FROM node:24", ""));
  assert.throws(() => checkPins(pinnedBase, "uses: actions/checkout@v5"));
  assert.throws(() => checkPins(pinnedBase, "uses : actions/checkout@v5"));
  for (const unsafe of [
    "pull_request_target:",
    "runs-on: self-hosted",
    "continue-on-error: true",
    "continue-on-error : true",
    "secrets.TOKEN",
    `\${{ secrets['TOKEN'] }}`,
    `\${{ toJSON(secrets) }}`,
  ]) {
    assert.throws(() => checkPins(pinnedBase, unsafe));
  }
  checkPins(pinnedBase, checkedWorkflow);
});

test("CodeQL extension rule references retain the same severity gate", () => {
  const report = sarif([{ ruleId: "risk", rule: { id: "risk", index: 0, toolComponent: { index: 0 } } }]);
  const run = report.runs[0];
  run.tool.extensions = [{ name: "codeql/javascript-queries", rules: run.tool.driver.rules }];
  run.tool.driver.rules = [];
  assert.throws(() => checkReport("codeql", report));
  run.tool.extensions[0].rules[0].properties["security-severity"] = "4.0";
  checkReport("codeql", report);
  run.results[0].rule.index = 1;
  assert.throws(() => checkReport("codeql", report));
  run.results[0].rule.index = 0;
  run.results[0].rule.toolComponent.index = 1;
  assert.throws(() => checkReport("codeql", report));
});

const pinnedBase = `FROM node:24@sha256:${"a".repeat(64)}`;
const pinnedAction = `actions/checkout@${"b".repeat(40)}`;
const workflowCases = [
  ["quoted uses", 'steps: [{"uses": "actions/checkout@v5"}]'],
  ["escaped uses", 'steps: [{"u\\u0073es": "actions/checkout@v5"}]'],
  ["explicit key", "? uses\n: actions/checkout@v5"],
  ["quoted continue-on-error", 'steps: [{"continue-on-error": false}]'],
  ["escaped continue-on-error", 'jobs: {test: {"continue-on-\\u0065rror": true}}'],
  ["quoted privileged event", '"on": {"pull_request_target": {}}'],
  ["event in sequence", 'on: [push, "pull_request_target"]'],
  ["escaped privileged event", 'on: "pull_request_\\u0074arget"'],
  ["escaped runner", 'runs-on: "self-\\u0068osted"'],
  ["dynamic runner", `runs-on: \${{ inputs.runner }}`],
  ["runner group", "runs-on: {group: internal}"],
  ["escaped secrets", `env: {TOKEN: "\${{ se\\u0063rets.TOKEN }}"}`],
  ["inherited secrets", "secrets: inherit"],
  ["secret mapping", "jobs: {test: {secrets: {TOKEN: value}}}"],
  ["duplicate quoted key", `uses: ${pinnedAction}\n"uses": actions/checkout@v5`],
  ["alias", "name: &n safe\nrun-name: *n"],
  ["cyclic alias", "jobs: &cycle {test: *cycle}"],
  ["merge key", `jobs: {test: {'<<': {uses: ${pinnedAction}}}}`],
  ["unknown tag", `uses: !unknown ${pinnedAction}`],
  ["unknown directive", "%UNKNOWN ignored\n---\nname: example"],
  ["YAML 1.1 directive", "%YAML 1.1\n---\nname: example"],
  ["multiple documents", `uses: ${pinnedAction}\n---\nuses: actions/checkout@v5`],
  ["complex key", "? [uses]\n: actions/checkout@v5"],
  ["malformed document", "jobs: ["],
  ["empty document", "# no workflow"],
  ["scalar document", "name only"],
  ["sequence document", "- uses: actions/checkout@v5"],
  ["local action", `uses: ./local@${"b".repeat(40)}`],
  ["Docker action", `uses: docker://image@${"b".repeat(40)}`],
  ["null action", "uses:"],
  ["numeric action", "uses: 123"],
  ["prototype-like mapping", '__proto__: {"uses": actions/checkout@v5}'],
];
for (const [name, workflow] of workflowCases) {
  test(`structural workflow policy rejects ${name}`, () => {
    assert.throws(() => checkPins(pinnedBase, workflow));
  });
}

test("structural workflow policy accepts decoded pinned actions and hosted jobs", () => {
  const checkout = "uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5";
  for (const replacement of [
    `"uses": "${pinnedAction}"`,
    `"u\\u0073es": "${pinnedAction}"`,
    `uses: >-\n          ${pinnedAction}`,
    `uses: owner/repo/path/to/action@${"c".repeat(40)}`,
  ]) {
    assert.ok(checkedWorkflow.includes(checkout));
    checkPins(pinnedBase, checkedWorkflow.replace(checkout, replacement));
  }
});

test("checked-in workflow and Dockerfile satisfy the structural policy", () => {
  checkPins(readFileSync("Dockerfile", "utf8"), readFileSync(".github/workflows/foundation-ci.yml", "utf8"));
});

const scopeCases = [
  [
    "missing root permissions",
    (w) => {
      delete w.permissions;
    },
  ],
  [
    "root write grant",
    (w) => {
      w.permissions.contents = "write";
    },
  ],
  [
    "root write-all",
    (w) => {
      w.permissions = "write-all";
    },
  ],
  [
    "root read-all",
    (w) => {
      w.permissions = "read-all";
    },
  ],
  [
    "root empty mapping",
    (w) => {
      w.permissions = {};
    },
  ],
  [
    "root null",
    (w) => {
      w.permissions = null;
    },
  ],
  [
    "root expression",
    (w) => {
      w.permissions = `\${{ inputs.permissions }}`;
    },
  ],
  [
    "extra root grant",
    (w) => {
      w.permissions["id-token"] = "write";
    },
  ],
  [
    "unknown root permission",
    (w) => {
      w.permissions.future = "read";
    },
  ],
  [
    "missing CodeQL grant",
    (w) => {
      delete w.jobs.codeql.permissions;
    },
  ],
  [
    "CodeQL events read",
    (w) => {
      w.jobs.codeql.permissions["security-events"] = "read";
    },
  ],
  [
    "CodeQL contents write",
    (w) => {
      w.jobs.codeql.permissions.contents = "write";
    },
  ],
  [
    "CodeQL extra grant",
    (w) => {
      w.jobs.codeql.permissions.checks = "write";
    },
  ],
  [
    "step permissions",
    (w) => {
      w.jobs.quality.steps[0].permissions = { contents: "read" };
    },
  ],
  [
    "workflow condition",
    (w) => {
      w.if = "success()";
    },
  ],
  [
    "false step condition",
    (w) => {
      w.jobs.quality.steps[2].if = false;
    },
  ],
  [
    "null step condition",
    (w) => {
      w.jobs.quality.steps[2].if = null;
    },
  ],
  [
    "expression step condition",
    (w) => {
      w.jobs.quality.steps[2].if = `\${{ false }}`;
    },
  ],
  [
    "always executable step",
    (w) => {
      w.jobs.quality.steps[2].if = "always()";
    },
  ],
  [
    "eligibility skipped",
    (w) => {
      w.jobs.eligibility.if = false;
    },
  ],
  [
    "eligibility condition removed",
    (w) => {
      delete w.jobs.eligibility.if;
    },
  ],
  [
    "upload skipped",
    (w) => {
      w.jobs.artifact.steps.at(-1).if = "failure()";
    },
  ],
  [
    "upload condition removed",
    (w) => {
      delete w.jobs.artifact.steps.at(-1).if;
    },
  ],
  [
    "conditional upload with executable run",
    (w) => {
      w.jobs.artifact.steps.at(-1).run = "true";
    },
  ],
  [
    "missing required job",
    (w) => {
      delete w.jobs.quality;
    },
  ],
  [
    "extra job",
    (w) => {
      w.jobs.extra = structuredClone(w.jobs.quality);
    },
  ],
  [
    "empty required steps",
    (w) => {
      w.jobs.quality.steps = [];
    },
  ],
];
for (const id of ["quality", "secrets", "artifact", "eligibility"]) {
  scopeCases.push([
    `${id} unauthorized grant`,
    (w) => {
      w.jobs[id].permissions = { contents: "write" };
    },
  ]);
}
for (const id of ["quality", "secrets", "codeql", "artifact"]) {
  scopeCases.push([
    `${id} conditional job`,
    (w) => {
      w.jobs[id].if = "always()";
    },
  ]);
}
for (const [name, mutate] of scopeCases) {
  test(`workflow scope policy rejects ${name}`, () => {
    const workflow = parse(checkedWorkflow);
    mutate(workflow);
    assert.throws(() => checkPins(pinnedBase, stringify(workflow)));
  });
}

test("workflow scope policy accepts only explicit read inheritance outside CodeQL", () => {
  const workflow = parse(checkedWorkflow);
  for (const [id, job] of Object.entries(workflow.jobs)) {
    if (id !== "codeql") job.permissions = { contents: "read" };
  }
  checkPins(pinnedBase, stringify(workflow));
});

test("workflow scope policy decodes quoted and escaped permission and condition keys", () => {
  const valid = checkedWorkflow.replace("permissions:", '"permi\\u0073sions":');
  checkPins(pinnedBase, valid);
  assert.throws(() => checkPins(pinnedBase, valid.replace("contents: read", '"contents": write')));
  assert.throws(() => checkPins(pinnedBase, `${valid}\n"i\\u0066": false\n`));
});

test("unfiltered pull requests cover main and future stack bases on default opened/synchronize/reopened events", () => {
  const workflow = parse(checkedWorkflow);
  assert.deepEqual(Object.keys(workflow.on).sort(), ["pull_request", "push", "workflow_dispatch"].sort());
  assert.equal(workflow.on.pull_request, null);
  assert.deepEqual(workflow.on.push.branches, ["main"]);
  checkPins(pinnedBase, checkedWorkflow);

  workflow.on.pull_request = {};
  checkPins(pinnedBase, stringify(workflow));
  checkPins(pinnedBase, checkedWorkflow.replace("on:", '"o\\u006e":'));
});

const setEvent = (name, value) => (workflow) => {
  workflow.on[name] = value;
};
const removeEvent = (name) => (workflow) => {
  delete workflow.on[name];
};
const eventCases = [
  [
    "missing on",
    (w) => {
      delete w.on;
    },
  ],
  [
    "scalar on",
    (w) => {
      w.on = "pull_request";
    },
  ],
  [
    "sequence on",
    (w) => {
      w.on = ["pull_request", "push", "workflow_dispatch"];
    },
  ],
  ["missing pull_request", removeEvent("pull_request")],
  ["false pull_request", setEvent("pull_request", false)],
  ["sequence pull_request", setEvent("pull_request", ["opened"])],
  ["pull_request branch filter", setEvent("pull_request", { branches: ["main"] })],
  ["pull_request branch exclusion", setEvent("pull_request", { "branches-ignore": ["feature/**"] })],
  ["pull_request path filter", setEvent("pull_request", { paths: ["scripts/**"] })],
  ["pull_request path exclusion", setEvent("pull_request", { "paths-ignore": ["docs/**"] })],
  ["pull_request missing default activity", setEvent("pull_request", { types: ["opened"] })],
  [
    "pull_request extra activity",
    setEvent("pull_request", { types: ["opened", "synchronize", "reopened", "closed"] }),
  ],
  ["missing push", removeEvent("push")],
  ["unfiltered push", setEvent("push", null)],
  ["push other branch", setEvent("push", { branches: ["main", "development"] })],
  ["push path filter", setEvent("push", { branches: ["main"], paths: ["scripts/**"] })],
  ["missing workflow_dispatch", removeEvent("workflow_dispatch")],
  ["malformed workflow_dispatch", setEvent("workflow_dispatch", false)],
  ["unsupported schedule", setEvent("schedule", [{ cron: "0 0 * * *" }])],
  ["unsupported workflow_run", setEvent("workflow_run", { workflows: ["other"], types: ["completed"] })],
  ["privileged pull_request_target", setEvent("pull_request_target", null)],
];
for (const [name, mutate] of eventCases) {
  test(`event contract rejects ${name}`, () => {
    const workflow = parse(checkedWorkflow);
    workflow.on.pull_request = null;
    mutate(workflow);
    assert.throws(() => checkPins(pinnedBase, stringify(workflow)));
  });
}

test("local validation alone cannot authenticate its own invocation or implementation", () => {
  // This passing tamper case must remain documented as an external-enforcement blocker.
  const removed = checkedWorkflow.replace(
    "node scripts/foundation-gates.mjs pins .github/workflows/foundation-ci.yml",
    "true"
  );
  assert.notEqual(removed, checkedWorkflow);
  checkPins(pinnedBase, removed);
});
