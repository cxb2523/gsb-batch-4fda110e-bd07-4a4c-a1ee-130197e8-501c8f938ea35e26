#!/usr/bin/env node
/*
 * Local, zero-dependency tests for the self-decoding boot loader in
 * index.html / public/index.html.
 *
 * What it does:
 *   1. Extracts the real boot <script> and the XOR key from index.html.
 *   2. Builds minimal synthetic shard fixtures (success, missing shard,
 *      illegal Base64, empty key, non-HTML payload, empty payload).
 *   3. Loads each fixture in the locally installed headless Chromium
 *      (Chrome or Edge) over file:// and reads back window.__DECODE_RESULT__
 *      via a DOMContentLoaded reporter. No network access, no credentials.
 *
 * Run:  node tests/run_tests.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const EXPECTED_SHARDS = 6;
const SHARD_PREFIX = 'I8lRE4RIeb';
const RESULT_FIELD = '__DECODE_RESULT__';

const failures = [];
let passed = 0;

function fail(name, detail) {
  failures.push({ name, detail });
  console.log(`  FAIL  ${name}: ${detail}`);
}
function ok(name, detail) {
  passed += 1;
  console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`);
}
function check(caseName, cond, detail) {
  if (cond) ok(caseName, detail);
  else fail(caseName, detail);
}

/* ------------------------------------------------------------------ */
/* Extract the production boot script and key                         */
/* ------------------------------------------------------------------ */

function extractBoot(htmlPath) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error(`boot <script> not found in ${htmlPath}`);
  return m[1];
}

const bootRoot = extractBoot(path.join(ROOT, 'index.html'));
const bootPublic = extractBoot(path.join(ROOT, 'public', 'index.html'));
const keyMatch = bootRoot.match(/atob\('([^']*)'\)/);
if (!keyMatch) throw new Error('XOR key atob constant not found in boot script');
const KEY_B64 = keyMatch[1];
const KEY_BYTES = Buffer.from(KEY_B64, 'base64');
console.log(`Using XOR key: ${KEY_B64} (${KEY_BYTES.length} bytes)`);

/* ------------------------------------------------------------------ */
/* Fixture payload encoding (mirrors the page's XOR + Base64 scheme)  */
/* ------------------------------------------------------------------ */

function encodePayload(htmlText) {
  const plain = Buffer.from(htmlText, 'utf8');
  const xored = Buffer.alloc(plain.length);
  for (let i = 0; i < plain.length; i++) {
    xored[i] = plain[i] ^ KEY_BYTES[i % KEY_BYTES.length];
  }
  return xored.toString('base64');
}

/* Split a Base64 blob into EXPECTED_SHARDS ordered shard divs. */
function shardDivs(b64, options = {}) {
  const drop = options.drop === undefined ? null : options.drop;
  const mangle = options.mangle === undefined ? null : options.mangle;
  const emptyAll = !!options.emptyAll;
  const parts = [];
  const chunk = Math.ceil(b64.length / EXPECTED_SHARDS);
  for (let i = 0; i < EXPECTED_SHARDS; i++) {
    parts.push(b64.slice(i * chunk, (i + 1) * chunk));
  }
  const divs = [];
  for (let i = 0; i < EXPECTED_SHARDS; i++) {
    if (i === drop) continue; // missing shard: element is absent entirely
    let content = emptyAll ? '' : parts[i];
    if (i === mangle) content = '!!!@#$' + content.slice(6); // illegal Base64
    divs.push(
      `<div id="${SHARD_PREFIX}${i}" style="display:none">${content}</div>`
    );
  }
  return divs.join('\n');
}

/*
 * Reporter placed in <head>: it registers before the boot script runs and
 * dumps the observable state after DOMContentLoaded, so it survives both
 * the success path (boot replaces body) and every failure path (body kept).
 */
const REPORTER = `
<script>
window.addEventListener('DOMContentLoaded', function () {
  var pre = document.createElement('pre');
  pre.id = 'rep';
  pre.textContent = JSON.stringify({
    result: window.${RESULT_FIELD} || null,
    frozen: !!(window.${RESULT_FIELD} && Object.isFrozen(window.${RESULT_FIELD})),
    sentinelSurvives: !!document.getElementById('sentinel'),
    payloadMarks: window.__PAYLOAD_RAN || 0,
    title: document.title,
    hasH1: !!document.getElementById('fixture-h1'),
    bodyLen: document.body ? document.body.innerHTML.length : 0
  });
  document.body.appendChild(pre);
});
</script>`;

function page({ boot, shards }) {
  return (
    '<!DOCTYPE html>\n<html>\n<head>\n<meta charset="utf-8">\n' +
    '<title>Fixture Harness</title>\n' +
    REPORTER +
    '\n</head>\n<body>\n' +
    '<div id="sentinel">original-body-marker</div>\n' +
    shards +
    '\n<script>' +
    boot +
    '</script>\n</body>\n</html>\n'
  );
}

/* ------------------------------------------------------------------ */
/* Browser discovery / headless run                                    */
/* ------------------------------------------------------------------ */

function findBrowser() {
  const candidates = [
    process.env.CHROME_BIN,
    process.env.EDGE_BIN,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch (_e) {}
  }
  throw new Error(
    'No local Chromium browser found. Set CHROME_BIN or EDGE_BIN to an .exe path.'
  );
}

const BROWSER = findBrowser();
console.log(`Using browser: ${BROWSER}\n`);

function runFixture(fileName, html) {
  const file = path.join(FIXTURE_DIR, fileName);
  fs.writeFileSync(file, html, 'utf8');
  const profile = path.join(FIXTURE_DIR, '_profile_' + fileName.replace(/\W/g, '_'));
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--user-data-dir=' + profile,
    '--virtual-time-budget=3000',
    '--dump-dom',
    pathToFileURL(file).href,
  ];
  let dom;
  try {
    dom = execFileSync(BROWSER, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60000,
    });
  } catch (e) {
    throw new Error(`${fileName}: browser failed to run: ${e.message}`);
  }
  const m = dom.match(/<pre id="rep">([\s\S]*?)<\/pre>/);
  if (!m) {
    throw new Error(
      `${fileName}: reporter <pre id="rep"> missing from dumped DOM`
    );
  }
  return JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
}

/* ------------------------------------------------------------------ */
/* Fixture definitions                                                 */
/* ------------------------------------------------------------------ */

const SUCCESS_HTML = [
  '<!DOCTYPE html>',
  '<html><head>',
  '<meta name="x-meta" content="ok">',
  '<title>Fixture Success Title</title>',
  '<style>h1{color:red}</style>',
  '</head><body>',
  '<h1 id="fixture-h1">restored-body</h1>',
  '<script>window.__PAYLOAD_RAN=(window.__PAYLOAD_RAN||0)+1;</script>',
  '<p>between scripts</p>',
  '<script>window.__PAYLOAD_RAN=(window.__PAYLOAD_RAN||0)+1;</script>',
  '</body></html>',
].join('\n');

const NON_HTML_TEXT = 'this is plain text with no html body tag at all';

fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
fs.mkdirSync(FIXTURE_DIR, { recursive: true });

const bootEmptyKey = bootRoot.replace(/atob\('[^']*'\)/, "atob('')");

const CASES = [
  {
    name: '01-success',
    file: '01-success.html',
    html: page({
      boot: bootRoot,
      shards: shardDivs(encodePayload(SUCCESS_HTML)),
    }),
    expect(rep) {
      const r = rep.result;
      check('01-success/result-object-exists', !!r, JSON.stringify(r));
      check('01-success/status', r && r.status === 'success', r && r.status);
      check('01-success/reason-null', r && r.reason === null, r && String(r.reason));
      check(
        '01-success/shard-counts',
        r && r.shardsPresent === 6 && r.expectedShards === 6,
        r && `${r.shardsPresent}/${r.expectedShards}`
      );
      check(
        '01-success/decoded-bytes',
        r && r.decodedBytes === Buffer.byteLength(SUCCESS_HTML, 'utf8'),
        r && String(r.decodedBytes)
      );
      check(
        '01-success/scripts-executed-2',
        r && r.scriptsExecuted === 2 && rep.payloadMarks === 2,
        r && `result=${r.scriptsExecuted} marks=${rep.payloadMarks}`
      );
      check(
        '01-success/body-was-replaced',
        rep.sentinelSurvives === false && rep.hasH1 === true,
        `sentinel=${rep.sentinelSurvives} h1=${rep.hasH1}`
      );
      check(
        '01-success/title-restored',
        rep.title === 'Fixture Success Title',
        rep.title
      );
      check('01-success/result-frozen', rep.frozen === true, String(rep.frozen));
    },
  },
  {
    name: '02-missing-shard',
    file: '02-missing-shard.html',
    html: page({
      boot: bootRoot,
      shards: shardDivs(encodePayload(SUCCESS_HTML), { drop: 3 }),
    }),
    expect(rep) {
      const r = rep.result;
      check('02-missing-shard/status-failure', r && r.status === 'failure', r && r.status);
      check(
        '02-missing-shard/reason',
        r && r.reason === 'missing_shards',
        r && r.reason
      );
      check(
        '02-missing-shard/counts',
        r && r.shardsPresent === 5 && r.expectedShards === 6,
        r && `${r.shardsPresent}/${r.expectedShards}`
      );
      check(
        '02-missing-shard/id-recorded',
        r && Array.isArray(r.missingShardIds) &&
          r.missingShardIds.join(',') === SHARD_PREFIX + '3',
        r && (r.missingShardIds || []).join(',')
      );
      check('02-missing-shard/zero-bytes', r && r.decodedBytes === 0, r && String(r.decodedBytes));
      check('02-missing-shard/zero-scripts', r && r.scriptsExecuted === 0, r && String(r.scriptsExecuted));
      check(
        '02-missing-shard/body-untouched',
        rep.sentinelSurvives === true && rep.hasH1 === false,
        `sentinel=${rep.sentinelSurvives}`
      );
      check(
        '02-missing-shard/no-payload-script-ran',
        rep.payloadMarks === 0,
        `marks=${rep.payloadMarks}`
      );
      check('02-missing-shard/result-frozen', rep.frozen === true, String(rep.frozen));
    },
  },
  {
    name: '03-bad-base64',
    file: '03-bad-base64.html',
    html: page({
      boot: bootRoot,
      shards: shardDivs(encodePayload(SUCCESS_HTML), { mangle: 2 }),
    }),
    expect(rep) {
      const r = rep.result;
      check('03-bad-base64/status-failure', r && r.status === 'failure', r && r.status);
      check('03-bad-base64/reason', r && r.reason === 'invalid_payload', r && r.reason);
      check(
        '03-bad-base64/all-shards-present',
        r && r.shardsPresent === 6 && r.expectedShards === 6,
        r && `${r.shardsPresent}/${r.expectedShards}`
      );
      check('03-bad-base64/zero-scripts', r && r.scriptsExecuted === 0, r && String(r.scriptsExecuted));
      check(
        '03-bad-base64/body-untouched',
        rep.sentinelSurvives === true && rep.hasH1 === false,
        `sentinel=${rep.sentinelSurvives}`
      );
      check(
        '03-bad-base64/no-payload-script-ran',
        rep.payloadMarks === 0,
        `marks=${rep.payloadMarks}`
      );
    },
  },
  {
    name: '04-empty-key',
    file: '04-empty-key.html',
    html: page({
      boot: bootEmptyKey,
      shards: shardDivs(encodePayload(SUCCESS_HTML)),
    }),
    expect(rep) {
      const r = rep.result;
      check('04-empty-key/status-failure', r && r.status === 'failure', r && r.status);
      check('04-empty-key/reason', r && r.reason === 'invalid_key', r && r.reason);
      check(
        '04-empty-key/shards-still-counted',
        r && r.shardsPresent === 6 && r.expectedShards === 6,
        r && `${r.shardsPresent}/${r.expectedShards}`
      );
      check('04-empty-key/zero-bytes', r && r.decodedBytes === 0, r && String(r.decodedBytes));
      check('04-empty-key/zero-scripts', r && r.scriptsExecuted === 0, r && String(r.scriptsExecuted));
      check(
        '04-empty-key/body-untouched',
        rep.sentinelSurvives === true && rep.hasH1 === false,
        `sentinel=${rep.sentinelSurvives}`
      );
      check(
        '04-empty-key/no-payload-script-ran',
        rep.payloadMarks === 0,
        `marks=${rep.payloadMarks}`
      );
      check(
        '04-empty-key/title-unchanged',
        rep.title === 'Fixture Harness',
        rep.title
      );
    },
  },
  {
    name: '05-invalid-html',
    file: '05-invalid-html.html',
    html: page({
      boot: bootRoot,
      shards: shardDivs(encodePayload(NON_HTML_TEXT)),
    }),
    expect(rep) {
      const r = rep.result;
      check('05-invalid-html/status-failure', r && r.status === 'failure', r && r.status);
      check('05-invalid-html/reason', r && r.reason === 'invalid_html', r && r.reason);
      check(
        '05-invalid-html/decoded-bytes-recorded',
        r && r.decodedBytes === Buffer.byteLength(NON_HTML_TEXT, 'utf8'),
        r && String(r.decodedBytes)
      );
      check('05-invalid-html/zero-scripts', r && r.scriptsExecuted === 0, r && String(r.scriptsExecuted));
      check(
        '05-invalid-html/body-untouched',
        rep.sentinelSurvives === true,
        `sentinel=${rep.sentinelSurvives}`
      );
    },
  },
  {
    name: '06-empty-payload',
    file: '06-empty-payload.html',
    html: page({
      boot: bootRoot,
      shards: shardDivs(encodePayload(SUCCESS_HTML), { emptyAll: true }),
    }),
    expect(rep) {
      const r = rep.result;
      check('06-empty-payload/status-failure', r && r.status === 'failure', r && r.status);
      check(
        '06-empty-payload/reason',
        r && r.reason === 'invalid_payload',
        r && r.reason
      );
      check(
        '06-empty-payload/body-untouched',
        rep.sentinelSurvives === true,
        `sentinel=${rep.sentinelSurvives}`
      );
    },
  },
];

/* Real production page smoke test: the actual index.html with its real shards,
   only a reporter (head) and a sentinel (body) injected. */
function buildRealSmoke() {
  let real = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  real = real.replace('</head>', REPORTER + '\n</head>');
  real = real.replace(/<body>/, '<body>\n<div id="sentinel">original-body-marker</div>');
  return real;
}
const REAL_SMOKE = {
  name: '07-real-page-smoke',
  file: '07-real-page-smoke.html',
  html: buildRealSmoke(),
  expect(rep) {
    const r = rep.result;
    check('07-real/result-object-exists', !!r, JSON.stringify(r));
    check('07-real/status-success', r && r.status === 'success', r && r.status);
    check('07-real/reason-null', r && r.reason === null, r && String(r.reason));
    check(
      '07-real/shard-counts',
      r && r.shardsPresent === 6 && r.expectedShards === 6,
      r && `${r.shardsPresent}/${r.expectedShards}`
    );
    check('07-real/decoded-bytes', r && r.decodedBytes > 10000, r && String(r.decodedBytes));
    check('07-real/one-script-executed', r && r.scriptsExecuted === 1, r && String(r.scriptsExecuted));
    check(
      '07-real/body-replaced',
      rep.sentinelSurvives === false,
      `sentinel=${rep.sentinelSurvives}`
    );
    check(
      '07-real/title-restored',
      /Install/.test(rep.title),
      rep.title
    );
    check(
      '07-real/result-frozen',
      rep.frozen === true,
      String(rep.frozen)
    );
  },
};

/* ------------------------------------------------------------------ */
/* Static checks + run all cases                                       */
/* ------------------------------------------------------------------ */

console.log('Static checks:');
check(
  'static/boot-scripts-identical',
  bootRoot === bootPublic,
  'index.html and public/index.html boot scripts match byte-for-byte'
);
check(
  'static/result-field-published',
  /window\[RESULT_FIELD\]\s*=\s*result/.test(bootRoot) &&
    bootRoot.indexOf("'__DECODE_RESULT__'") !== -1,
  'window.__DECODE_RESULT__ is published'
);
check(
  'static/no-body-write-before-validation',
  bootRoot.indexOf('document.body.innerHTML') >
    bootRoot.indexOf("finish('invalid_html')"),
  'body replacement happens only after invalid_html validation'
);

console.log('\nHeadless browser cases:');
for (const c of CASES.concat([REAL_SMOKE])) {
  console.log(`\n[${c.name}]`);
  let rep;
  try {
    rep = runFixture(c.file, c.html);
  } catch (e) {
    fail(c.name, e.message);
    continue;
  }
  c.expect(rep);
}

console.log('\n----------------------------------------');
console.log(`Passed: ${passed}  Failed: ${failures.length}`);
if (failures.length) {
  console.log('Failures:');
  for (const f of failures) console.log(`  - ${f.name}: ${f.detail}`);
  process.exit(1);
}
console.log('ALL TESTS PASSED');
