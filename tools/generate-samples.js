// Generates five locally-openable sample pages under samples/, one per
// required scenario. Each page embeds 11 <template> pieces, references the
// shared js/lnd-decoder.js, runs a self-check against its expected status,
// and paints a PASS/FAIL banner. Run: node tools/generate-samples.js
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const samplesDir = path.join(root, 'samples');
const Lnd = require(path.join(root, 'js', 'lnd-decoder.js'));
const N = Lnd.PIECE_COUNT;
const PREFIX = Lnd.PIECE_PREFIX;
const KEY_B64 = Lnd.DEFAULT_KEY_B64;
const KEY_BIN = Buffer.from(KEY_B64, 'base64').toString('binary');

function encryptToPieces(utf8Html) {
  const raw = Buffer.from(utf8Html, 'utf8');
  const enc = Buffer.alloc(raw.length);
  for (let i = 0; i < raw.length; i++) {
    enc[i] = raw[i] ^ KEY_BIN.charCodeAt(i % KEY_BIN.length);
  }
  const b64 = enc.toString('base64');
  const size = Math.ceil(b64.length / N);
  const pieces = [];
  for (let i = 0; i < N; i++) pieces.push(b64.slice(i * size, (i + 1) * size));
  if (pieces.join('') !== b64) throw new Error('piece split mismatch');
  if (!pieces.every((p) => p.length > 0)) throw new Error('empty piece generated');
  return pieces;
}

function encryptBytesToPieces(bytes) {
  const enc = Buffer.alloc(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    enc[i] = bytes[i] ^ KEY_BIN.charCodeAt(i % KEY_BIN.length);
  }
  const b64 = enc.toString('base64');
  const size = Math.ceil(b64.length / N);
  const pieces = [];
  for (let i = 0; i < N; i++) pieces.push(b64.slice(i * size, (i + 1) * size));
  if (pieces.join('') !== b64) throw new Error('piece split mismatch');
  if (!pieces.every((p) => p.length > 0)) throw new Error('empty piece generated');
  return pieces;
}

// Small but complete landing page: allowed head tags, title, body markup,
// two inline and two external scripts, plus an empty inline script (ignored).
const SAMPLE_HTML = [
  '<!DOCTYPE html>',
  '<html><head>',
  '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1">',
  '<base href="./">',
  '<title>Sample Board — Decoded</title>',
  '<style>body{font-family:sans-serif;background:#0d1117;color:#c9d1d9;margin:0;padding:32px}',
  '.card{max-width:720px;margin:0 auto;border:1px solid #30363d;border-radius:12px;padding:24px;background:#161b22}',
  'h1{color:#58a6ff}button{padding:8px 14px;border-radius:6px;border:1px solid #30363d;background:#21262d;color:#c9d1d9;cursor:pointer}',
  '#toast{display:none;margin-top:12px;color:#3fb950}#toast.show{display:block}</style>',
  '<script>var headScriptMustNotReplay=true;</script>',
  '</head><body>',
  '<main class="card">',
  '<h1>SalesPulse 360 sample board</h1>',
  '<p>This markup only exists after a successful observable decode.</p>',
  '<button class="copy-btn" onclick="copyCommand(this)"><span class="command-text">@echo hello@</span></button>',
  '<div id="toast">Copied</div>',
  '<p id="marker-inline-a">pending</p>',
  '<p id="marker-inline-b">pending</p>',
  '<p id="marker-external-a">pending</p>',
  '<p id="marker-external-b">pending</p>',
  '</main>',
  '<script src="sample-external-a.js"></script>',
  '<script>document.getElementById("marker-inline-a").textContent="inline-a ran";</script>',
  '<script src="sample-external-b.js"></script>',
  '<script>document.getElementById("marker-inline-b").textContent="inline-b ran";</script>',
  '<script></script>',
  '</body></html>'
].join('');

const goodPieces = encryptToPieces(SAMPLE_HTML);

// Scenario payloads: { file, title fragment, pieces, config, expected, note }
const scenarios = [
  {
    file: '01-missing-piece.html',
    label: 'Missing piece',
    config: null,
    expected: {
      success: false, failureCategory: 'missing-piece', pieces: [7],
      restoredHtmlLength: 0, inlineScriptCount: 0, externalScriptCount: 0
    },
    note: 'Template lndoxffylyyj7 is absent; joining must stop and name piece 7.',
    mutate(pieces) { pieces[7] = null; }
  },
  {
    file: '02-bad-base64.html',
    label: 'Invalid Base64',
    config: null,
    expected: {
      success: false, failureCategory: 'invalid-base64', pieces: [4],
      restoredHtmlLength: 0, inlineScriptCount: 0, externalScriptCount: 0
    },
    note: 'Piece 4 carries an illegal "!" character; atob must never be reached.',
    mutate(pieces) { pieces[4] = pieces[4].slice(0, 5) + '!' + pieces[4].slice(6); }
  },
  {
    file: '03-empty-key.html',
    label: 'Empty key',
    config: { keyBase64: '' },
    expected: {
      success: false, failureCategory: 'empty-key',
      pieces: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      restoredHtmlLength: 0, inlineScriptCount: 0, externalScriptCount: 0
    },
    note: 'Configured XOR key is the empty string; XOR must not run.',
    mutate() { /* pieces untouched */ }
  },
  {
    file: '04-invalid-utf8.html',
    label: 'Invalid UTF-8',
    config: null,
    expected: {
      success: false, failureCategory: 'invalid-utf8',
      pieces: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      restoredHtmlLength: 0, inlineScriptCount: 0, externalScriptCount: 0
    },
    note: 'Payload decodes to bytes 0xFF 0xFE 0xE0 0x80, which no UTF-8 decoder accepts.',
    useBadBytes: true
  },
  {
    file: '05-full-success.html',
    label: 'Full success',
    config: null,
    expected: {
      success: true, failureCategory: null, pieces: [],
      restoredHtmlLength: SAMPLE_HTML.length, inlineScriptCount: 2, externalScriptCount: 2
    },
    note: 'Title/head/body restored; 2 inline + 2 external scripts replayed in order.'
  }
];

function renderTemplates(pieces) {
  return pieces.map((p, i) =>
    p == null ? '' : '<template id="' + PREFIX + i + '">' + p + '</template>'
  ).join('');
}

function pageHtml(scenario) {
  const pieces = scenario.useBadBytes
    ? encryptBytesToPieces(Buffer.concat([
        Buffer.from([0x48, 0x69]),
        Buffer.from([0xff, 0xfe, 0xe0, 0x80]),
        Buffer.alloc(64, 0x61)
      ]))
    : goodPieces.slice();
  if (scenario.mutate) scenario.mutate(pieces);
  const configScript = scenario.config
    ? '<script>window.LND_DECODER_CONFIG=' + JSON.stringify(scenario.config) + ';</script>\n'
    : '';
  const expected = JSON.stringify(scenario.expected);
  return '<!DOCTYPE HTML>\n' +
    '<html><head><meta http-equiv="Content-Type" content="text/html; charset=UTF-8">' +
    '<title>LND sample — ' + scenario.label + '</title></head><body>\n' +
    '<!-- build -->\n' +
    renderTemplates(pieces) +
    '\n<div id="lnd-fallback" style="font-family:sans-serif;padding:24px;max-width:760px">' +
    '<h2>LND decoder sample: ' + scenario.label + '</h2>' +
    '<p><strong>Scenario:</strong> ' + scenario.note + '</p>' +
    '<p>This fallback text and the title stay exactly as they are on failure.</p></div>\n' +
    configScript +
    '<script src="../js/lnd-decoder.js"></script>\n' +
    '<script>\n' +
    '(function () {\n' +
    '  var expected = ' + expected + ';\n' +
    '  function deepEqual(a, b) {\n' +
    '    if (a === b) return true;\n' +
    '    if (typeof a !== typeof b) return false;\n' +
    '    if (Array.isArray(a) || Array.isArray(b)) {\n' +
    '      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;\n' +
    '      return a.every(function (v, i) { return deepEqual(v, b[i]); });\n' +
    '    }\n' +
    '    if (a && b && typeof a === "object") {\n' +
    '      var ka = Object.keys(a), kb = Object.keys(b);\n' +
    '      return ka.length === kb.length && ka.every(function (k) { return deepEqual(a[k], b[k]); });\n' +
    '    }\n' +
    '    return false;\n' +
    '  }\n' +
    '  function runCheck() {\n' +
    '    var status = window.LND_DECODE_STATUS;\n' +
    '    var box = document.createElement("div");\n' +
    '    box.style.cssText = "font-family:monospace;position:fixed;right:12px;bottom:12px;max-width:46%;' +
    'padding:12px;border-radius:8px;border:1px solid #30363d;background:#161b22;color:#c9d1d9;' +
    'white-space:pre-wrap;font-size:12px;z-index:99999";\n' +
    '    var fields = ["success","failureCategory","pieces","restoredHtmlLength",\n' +
    '      "inlineScriptCount","externalScriptCount","reason"];\n' +
    '    var actual = {};\n' +
    '    fields.forEach(function (f) { actual[f] = status ? status[f] : "(status missing)"; });\n' +
    '    var pass = !!status && fields.every(function (f) { return deepEqual(status[f], expected[f]); });\n' +
    '    if (!expected.success) {\n' +
    '      pass = pass && document.title === "LND sample — ' + scenario.label + '" &&\n' +
    '        !!document.getElementById("lnd-fallback");\n' +
    '    } else {\n' +
    '      pass = pass && document.title === "Sample Board — Decoded" &&\n' +
    '        !document.getElementById("lnd-fallback");\n' +
    '    }\n' +
    '    box.textContent = (pass ? "SELF-CHECK: PASS\\n" : "SELF-CHECK: FAIL\\n") +\n' +
    '      "expected: " + JSON.stringify(expected, null, 2) + "\\n\\nactual:   " +\n' +
    '      JSON.stringify(actual, null, 2);\n' +
    '    box.style.borderColor = pass ? "#3fb950" : "#f85149";\n' +
    '    document.body.appendChild(box);\n' +
    '    window.__lndSelfCheckPassed = pass;\n' +
    '    console.log("LND self-check", pass ? "PASS" : "FAIL", status);\n' +
    '  }\n' +
    '  // Wait for every dynamically replayed external script to finish so the\n' +
    '  // success case can assert their effects; failure cases inject none.\n' +
    '  var externals = Array.prototype.slice.call(\n' +
    '    document.body.querySelectorAll("script[src]"))\n' +
    '    .filter(function (s) { return s.getAttribute("src") !== "../js/lnd-decoder.js"; });\n' +
    '  if (!externals.length) { runCheck(); return; }\n' +
    '  var remaining = externals.length;\n' +
    '  externals.forEach(function (s) {\n' +
    '    s.addEventListener("load", function () { if (--remaining === 0) runCheck(); });\n' +
    '    s.addEventListener("error", function () { if (--remaining === 0) runCheck(); });\n' +
    '  });\n' +
    '})();\n' +
    '</script></body></html>\n';
}

fs.mkdirSync(samplesDir, { recursive: true });
for (const scenario of scenarios) {
  fs.writeFileSync(path.join(samplesDir, scenario.file), pageHtml(scenario), 'utf8');
  console.log('wrote samples/' + scenario.file);
}

// External scripts replayed by the success sample (and harmless if a failure
// page never reaches replay: they are simply not injected there).
fs.writeFileSync(path.join(samplesDir, 'sample-external-a.js'),
  '(function () {\n' +
  '  var el = document.getElementById("marker-external-a");\n' +
  '  if (el) el.textContent = "external-a ran";\n' +
  '})();\n', 'utf8');
fs.writeFileSync(path.join(samplesDir, 'sample-external-b.js'),
  '(function () {\n' +
  '  var el = document.getElementById("marker-external-b");\n' +
  '  if (el) el.textContent = "external-b ran";\n' +
  '})();\n', 'utf8');
console.log('wrote samples/sample-external-a.js and sample-external-b.js');
