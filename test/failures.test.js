import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { failureLines, main } from "../src/action.js";
import { classifyFailure, FAILURE_CATEGORIES, renderCards } from "../src/run.js";
import { fixture } from "./support/cases.js";

// A fake GitHub client that answers from the recorded octoscope fixture, the
// raw API responses rebuilt from it: the golden card must come out of it byte
// for byte. `repos` maps a full name to its repository object, `throwFor` a
// full name to the error its GraphQL call raises.
function fakeClient(data, { repos = {}, throwFor = {} } = {}) {
  const full = data.repo.nameWithOwner;
  const all = { [full]: data.repo, ...repos };
  return {
    async graphql(query, { owner, name } = {}) {
      const target = `${owner}/${name}`;
      if (throwFor[target]) throw throwFor[target];
      if (query.includes("releaseAssets")) {
        return {
          repository: {
            releases: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: data.releases.map((r) => ({ publishedAt: r.publishedAt, releaseAssets: { nodes: [{ downloadCount: r.downloads }] } })),
            },
          },
        };
      }
      if (query.includes("repositoryTopics")) return { repository: all[target] ?? null };
      return {
        repository: {
          defaultBranchRef: {
            target: {
              history: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: data.history.dates.map((authoredDate) => ({ authoredDate })),
              },
            },
          },
        },
      };
    },
    async rest(path) {
      if (path.includes("/contributors")) {
        return {
          data: data.contributors.list.map((c) => ({ login: c.login, contributions: c.contributions, type: c.type, avatar_url: c.avatarUrl })),
          link: "",
        };
      }
      if (path.includes("/git/trees/")) {
        const kept = data.tree.paths.map((p) => ({ type: "blob", path: p }));
        const pad = Array.from({ length: data.tree.files - kept.length }, (_, i) => ({ type: "blob", path: `src/pad-${i}.js` }));
        return { data: { tree: [...kept, ...pad], truncated: data.tree.truncated } };
      }
      if (path.includes("/stargazers/history")) {
        return {
          data: data.stars.map((w) => ({ week: Date.parse(`${w.week}T00:00:00Z`) / 1000, days: w.days, total: w.days.reduce((a, n) => a + n, 0) })),
          link: "",
        };
      }
      throw new Error(`GET ${path}: HTTP 404`);
    },
    async image() {
      return null;
    },
  };
}

const DATA = fixture("octoscope");
const NOW = new Date(DATA.fetchedAt);
const GOLDEN = readFileSync(new URL("./golden/octoscope-dark.svg", import.meta.url), "utf8");

const dirs = [];
const outDir = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "glancecard-failures-"));
  dirs.push(dir);
  return dir;
};

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const render = (options) =>
  renderCards({ client: fakeClient(DATA, options), repos: [`gfazioli/octoscope`], outDir: outDir(), themes: ["dark"], timeZone: "Europe/Rome", now: NOW });

test("a failure is classified from the messages the client and fetchers throw", () => {
  assert.deepEqual(FAILURE_CATEGORIES, ["not-found", "private", "rate-limit", "network"]);
  assert.equal(classifyFailure(new Error("a/b was not found, or this token cannot see it")), "not-found");
  assert.equal(classifyFailure(new Error('No GitHub user "ghost"')), "not-found");
  assert.equal(classifyFailure(new Error("a/b is private; a card would publish its data (set allow-private to render it anyway)")), "private");
  assert.equal(classifyFailure(new Error("GitHub API rate limit reached; it resets at 2027-01-15T08:00:00.000Z")), "rate-limit");
  assert.equal(classifyFailure(new Error("GitHub GraphQL rate limit reached")), "rate-limit");
  assert.equal(classifyFailure(new Error("GET /repos/a/b: HTTP 500")), "network");
  assert.equal(classifyFailure(new Error("api.github.com did not answer within 30 s")), "network");
});

test("one repository renders, one missing is reported as not-found", async () => {
  const dir = outDir();
  const { files, failures } = await renderCards({
    client: fakeClient(DATA),
    repos: ["gfazioli/octoscope", "gfazioli/missing"],
    outDir: dir,
    themes: ["dark"],
    timeZone: "Europe/Rome",
    now: NOW,
  });
  assert.deepEqual(files, [path.join(dir, "octoscope.svg")]);
  // The card that renders is the one the fixture always rendered, byte for byte.
  assert.equal(readFileSync(files[0], "utf8"), GOLDEN);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].target, "gfazioli/missing");
  assert.equal(failures[0].category, "not-found");
  assert.match(failures[0].message, /gfazioli\/missing was not found, or this token cannot see it/);
});

test("a private repository without allow-private is reported as private", async () => {
  const secret = { ...DATA.repo, name: "secret", nameWithOwner: "gfazioli/secret", isPrivate: true };
  const { files, failures } = await renderCards({
    client: fakeClient(DATA, { repos: { "gfazioli/secret": secret } }),
    repos: ["gfazioli/secret"],
    outDir: outDir(),
    themes: ["dark"],
    timeZone: "Europe/Rome",
    now: NOW,
  });
  assert.deepEqual(files, []);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].target, "gfazioli/secret");
  assert.equal(failures[0].category, "private");
});

test("a spent rate limit is reported as rate-limit", async () => {
  const limited = new Error("GitHub API rate limit reached; it resets at 2027-01-15T08:00:00.000Z");
  const { files, failures } = await render({
    throwFor: { "gfazioli/octoscope": limited },
  });
  assert.deepEqual(files, []);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].category, "rate-limit");
});

test("any other error is reported as network", async () => {
  const { failures } = await render({ throwFor: { "gfazioli/octoscope": new Error("api.github.com did not answer within 30 s") } });
  assert.equal(failures.length, 1);
  assert.equal(failures[0].category, "network");
});

// The action, end to end with the fake client: its outputs land in a
// GITHUB_OUTPUT file, as the runner reads them.
function actionEnv(workspace, repos) {
  const env = {
    GITHUB_WORKSPACE: workspace,
    GITHUB_OUTPUT: path.join(workspace, "github-output"),
    GITHUB_EVENT_NAME: "schedule",
    INPUT_REPOS: repos.join("\n"),
    INPUT_COMMIT: "false",
    INPUT_THEME: "dark",
    "INPUT_TIME-ZONE": "Europe/Rome",
  };
  writeFileSync(env.GITHUB_OUTPUT, "");
  return env;
}

function readOutputs(file) {
  const text = readFileSync(file, "utf8");
  const out = {};
  const re = /(\w+)<<(\S+)\n([\s\S]*?)\n\2\n/g;
  let m;
  while ((m = re.exec(text))) out[m[1]] = m[3];
  return out;
}

async function runAction(env, client) {
  const saved = process.exitCode;
  process.exitCode = undefined;
  try {
    const result = await main({ env, client, now: NOW });
    return { ...result, exitCode: process.exitCode ?? 0, outputs: readOutputs(env.GITHUB_OUTPUT) };
  } finally {
    process.exitCode = saved;
  }
}

test("the action writes the cards, the failures list, and fails the step on a partial run", async () => {
  const workspace = outDir();
  const env = actionEnv(workspace, ["gfazioli/octoscope", "gfazioli/missing"]);
  const { exitCode, outputs } = await runAction(env, fakeClient(DATA));
  assert.equal(outputs.files, path.join("glancecard", "octoscope.svg"));
  assert.equal(outputs.committed, "false");
  assert.equal(
    outputs.failures,
    "gfazioli/missing\tnot-found\tgfazioli/missing was not found, or this token cannot see it",
  );
  assert.equal(readFileSync(path.join(workspace, "glancecard", "octoscope.svg"), "utf8"), GOLDEN);
  assert.equal(exitCode, 1);
});

test("the action writes an empty failures output when nothing fails", async () => {
  const workspace = outDir();
  const env = actionEnv(workspace, ["gfazioli/octoscope"]);
  const { exitCode, outputs } = await runAction(env, fakeClient(DATA));
  assert.equal(outputs.failures, "");
  assert.equal(exitCode, 0);
});

test("when every target fails no card is written and the step fails", async () => {
  const workspace = outDir();
  const secret = { ...DATA.repo, name: "secret", nameWithOwner: "gfazioli/secret", isPrivate: true };
  const env = actionEnv(workspace, ["gfazioli/missing", "gfazioli/secret"]);
  const { files, exitCode, outputs } = await runAction(env, fakeClient(DATA, { repos: { "gfazioli/secret": secret } }));
  assert.deepEqual(files, []);
  assert.equal(readdirSync(path.join(workspace, "glancecard")).filter((f) => f.endsWith(".svg")).length, 0);
  assert.equal(outputs.files, "");
  assert.equal(outputs.committed, "false");
  assert.equal(
    outputs.failures,
    [
      "gfazioli/missing\tnot-found\tgfazioli/missing was not found, or this token cannot see it",
      "gfazioli/secret\tprivate\tgfazioli/secret is private; a card would publish its data (set allow-private to render it anyway)",
    ].join("\n"),
  );
  assert.notEqual(exitCode, 0);
});

test("failureLines formats target, category and message, tab-separated", () => {
  assert.equal(failureLines([]), "");
  assert.equal(
    failureLines([{ target: "a/b", category: "network", message: "boom" }]),
    "a/b\tnetwork\tboom",
  );
});
