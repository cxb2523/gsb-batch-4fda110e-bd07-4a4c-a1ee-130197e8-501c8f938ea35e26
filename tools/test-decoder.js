// Node test suite for the observable decoder. Covers the five required
// scenarios plus DOM-level guarantees (failure leaves the page untouched).
// Run: node tools/test-decoder.js
const assert = require('assert');
const path = require('path');

const Lnd = require(path.resolve(__dirname, '..', 'js', 'lnd-decoder.js'));
const KEY_B64 = Lnd.DEFAULT_KEY_B64;
const N = Lnd.PIECE_COUNT;
const KEY_BIN = Buffer.from(KEY_B64, 'base64').toString('binary');

let passed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  PASS ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n    ' + e.message); process.exitCode = 1; }
}

// Encrypt html with the repeating XOR key, base64, split into N pieces.
function makePieces(utf8Html) {
  const raw = Buffer.from(utf8Html, 'utf8');
  const enc = Buffer.alloc(raw.length);
  for (let i = 0; i < raw.length; i++) {
    enc[i] = raw[i] ^ KEY_BIN.charCodeAt(i % KEY_BIN.length);
  }
  const b64 = enc.toString('base64');
  const size = Math.ceil(b64.length / N);
  const pieces = [];
  for (let i = 0; i < N; i++) pieces.push(b64.slice(i * size, (i + 1) * size));
  assert.strictEqual(pieces.join(''), b64, 'piece split must round-trip');
  assert.ok(pieces.every((p) => p.length > 0), 'all 11 pieces non-empty');
  return pieces;
}

// Build pieces whose *decrypted* bytes are raw (possibly invalid UTF-8).
function makePiecesFromBytes(bytes) {
  const enc = Buffer.alloc(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    enc[i] = bytes[i] ^ KEY_BIN.charCodeAt(i % KEY_BIN.length);
  }
  const b64 = enc.toString('base64');
  const size = Math.ceil(b64.length / N);
  const pieces = [];
  for (let i = 0; i < N; i++) pieces.push(b64.slice(i * size, (i + 1) * size));
  assert.strictEqual(pieces.join(''), b64);
  assert.ok(pieces.every((p) => p.length > 0));
  return pieces;
}

const SAMPLE_HTML = [
  '<!DOCTYPE html><html><head>',
  '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1">',
  '<base href="/root/">',
  '<title>Restored Sales Board</title>',
  '<style>body{color:#111}</style>',
  '<script>var headScriptShouldBeIgnored=1;</script>',
  '</head><body>',
  '<main id="board">SalesPulse 360</main>',
  '<script src="external-a.js"></script>',
  '<p>between scripts</p>',
  '<script>window.__inlineRan=(window.__inlineRan||0)+1;</script>',
  '<script src="external-b.js"></script>',
  '<script>window.__inlineRan++;</script>',
  '<script></script>',
  '</body></html>'
].join('');

function assertStatusShape(status) {
  for (const field of ['success', 'failureCategory', 'pieces', 'restoredHtmlLength',
    'inlineScriptCount', 'externalScriptCount', 'reason']) {
    assert.ok(Object.prototype.hasOwnProperty.call(status, field), 'missing field ' + field);
  }
  assert.strictEqual(typeof status.success, 'boolean');
  assert.ok(Array.isArray(status.pieces));
  assert.strictEqual(typeof status.restoredHtmlLength, 'number');
  assert.strictEqual(typeof status.inlineScriptCount, 'number');
  assert.strictEqual(typeof status.externalScriptCount, 'number');
}

// ---- minimal DOM stub -------------------------------------------------------
function makeNode(tag) {
  return {
    tagName: tag.toUpperCase(),
    textContent: '',
    src: '',
    children: [],
    parentNode: null,
    get firstChild() { return this.children[0] || null; },
    removeChild(n) {
      const i = this.children.indexOf(n);
      if (i >= 0) this.children.splice(i, 1);
      n.parentNode = null;
      return n;
    },
    appendChild(n) {
      if (n.parentNode) n.parentNode.removeChild(n);
      n.parentNode = this;
      this.children.push(n);
      return n;
    }
  };
}

function makeDoc(pieces) {
  const templates = new Map();
  pieces.forEach((p, i) => {
    if (p != null) templates.set(Lnd.PIECE_PREFIX + i, { innerHTML: p });
  });
  const appendedToHead = [];
  const appendedScripts = [];
  const head = {
    appendChild(n) {
      appendedToHead.push(n);
      if (n.parentNode) n.parentNode.removeChild(n); // mirrors real DOM move
    }
  };
  const body = {
    innerHTML: 'ORIGINAL-BODY',
    appendChild: (n) => appendedScripts.push(n)
  };
  const doc = {
    title: 'Original Title',
    head,
    body,
    documentElement: { dataset: {} },
    getElementById: (id) => templates.get(id) || null,
    createElement(tag) {
      const node = makeNode(tag);
      if (tag.toLowerCase() === 'div') {
        Object.defineProperty(node, 'innerHTML', {
          get() { return this._html || ''; },
          set(html) {
            this._html = html;
            this.children = [];
            const re = /<\s*([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?\/?>/g;
            let m;
            while ((m = re.exec(html))) this.appendChild(makeNode(m[1]));
          }
        });
      }
      return node;
    }
  };
  return { doc, appendedToHead, appendedScripts };
}

console.log('Scenario 1 — missing piece');
{
  const pieces = makePieces(SAMPLE_HTML);
  check('pure decode: missing piece 7 stops before atob', () => {
    const broken = pieces.slice(); broken[7] = null;
    const r = Lnd.decode({ pieces: broken, keyBase64: KEY_B64 });
    assertStatusShape(r.status);
    assert.strictEqual(r.status.success, false);
    assert.strictEqual(r.status.failureCategory, 'missing-piece');
    assert.deepStrictEqual(r.status.pieces, [7]);
    assert.strictEqual(r.status.restoredHtmlLength, 0);
    assert.ok(/missing piece\(s\): 7/.test(r.status.reason));
    assert.strictEqual(r.html, undefined);
  });
  check('pure decode: several missing pieces all reported, ascending', () => {
    const broken = pieces.slice(); broken[0] = '   '; broken[10] = null; broken[3] = '';
    const r = Lnd.decode({ pieces: broken, keyBase64: KEY_B64 });
    assert.strictEqual(r.status.failureCategory, 'missing-piece');
    assert.deepStrictEqual(r.status.pieces, [0, 3, 10]);
  });
  check('pure decode: every counter field is zero on missing-piece failure', () => {
    const broken = pieces.slice(); broken[9] = null;
    const r = Lnd.decode({ pieces: broken, keyBase64: KEY_B64 });
    assert.strictEqual(r.status.restoredHtmlLength, 0);
    assert.strictEqual(r.status.inlineScriptCount, 0);
    assert.strictEqual(r.status.externalScriptCount, 0);
    assert.strictEqual(r.status.reason, 'missing piece(s): 9');
  });
  check('DOM run: page untouched, title preserved, status published', () => {
    const broken = pieces.slice(); broken.splice(5, 1); broken.splice(5, 0, null);
    const { doc } = makeDoc(broken);
    const status = Lnd.run(doc);
    assert.strictEqual(status.failureCategory, 'missing-piece');
    assert.deepStrictEqual(status.pieces, [5]);
    assert.strictEqual(doc.title, 'Original Title');
    assert.strictEqual(doc.body.innerHTML, 'ORIGINAL-BODY');
    assert.deepStrictEqual(global.LND_DECODE_STATUS, status);
    assert.ok(doc.documentElement.dataset.lndDecodeStatus.includes('"missing-piece"'));
  });
}

console.log('Scenario 2 — invalid Base64');
{
  const pieces = makePieces(SAMPLE_HTML);
  check('pure decode: illegal char reports piece and offset, no throw', () => {
    const broken = pieces.slice(); broken[4] = broken[4].slice(0, 3) + '!' + broken[4].slice(4);
    const r = Lnd.decode({ pieces: broken, keyBase64: KEY_B64 });
    assertStatusShape(r.status);
    assert.strictEqual(r.status.success, false);
    assert.strictEqual(r.status.failureCategory, 'invalid-base64');
    assert.deepStrictEqual(r.status.pieces, [4]);
    assert.ok(/piece 4/.test(r.status.reason) && /!/.test(r.status.reason));
  });
  check('pure decode: padding in the middle is rejected', () => {
    const broken = pieces.slice();
    broken[6] = broken[6].slice(0, 2) + '=' + broken[6].slice(3);
    const r = Lnd.decode({ pieces: broken, keyBase64: KEY_B64 });
    assert.strictEqual(r.status.failureCategory, 'invalid-base64');
    assert.deepStrictEqual(r.status.pieces, [6]);
  });
  check('pure decode: joined length not multiple of 4 names last piece', () => {
    const broken = pieces.slice(); broken[10] = broken[10].slice(0, -1);
    const r = Lnd.decode({ pieces: broken, keyBase64: KEY_B64 });
    assert.strictEqual(r.status.failureCategory, 'invalid-base64');
    assert.deepStrictEqual(r.status.pieces, [10]);
    assert.ok(/multiple of 4/.test(r.status.reason));
  });
  check('DOM run: invalid base64 never mutates title or body', () => {
    const broken = pieces.slice(); broken[2] = '@@@' + broken[2].slice(3);
    const { doc } = makeDoc(broken);
    const status = Lnd.run(doc);
    assert.strictEqual(status.failureCategory, 'invalid-base64');
    assert.deepStrictEqual(status.pieces, [2]);
    assert.strictEqual(doc.title, 'Original Title');
    assert.strictEqual(doc.body.innerHTML, 'ORIGINAL-BODY');
  });
}

console.log('Scenario 3 — empty key');
{
  const pieces = makePieces(SAMPLE_HTML);
  check('pure decode: empty key string -> empty-key over all pieces', () => {
    const r = Lnd.decode({ pieces, keyBase64: '' });
    assertStatusShape(r.status);
    assert.strictEqual(r.status.success, false);
    assert.strictEqual(r.status.failureCategory, 'empty-key');
    assert.deepStrictEqual(r.status.pieces, [0,1,2,3,4,5,6,7,8,9,10]);
    assert.ok(/key/i.test(r.status.reason));
  });
  check('pure decode: key base64 decoding to zero bytes -> empty-key', () => {
    const r = Lnd.decode({ pieces, keyBase64: '' });
    assert.strictEqual(r.status.failureCategory, 'empty-key');
  });
  check('pure decode: malformed key Base64 -> empty-key with reason', () => {
    const r = Lnd.decode({ pieces, keyBase64: 'not!base64!' });
    assertStatusShape(r.status);
    assert.strictEqual(r.status.failureCategory, 'empty-key');
    assert.ok(/key/i.test(r.status.reason));
  });
  check('DOM run: empty key leaves page intact', () => {
    const { doc } = makeDoc(pieces);
    const status = Lnd.run(doc, { keyBase64: '' });
    assert.strictEqual(status.failureCategory, 'empty-key');
    assert.strictEqual(status.restoredHtmlLength, 0);
    assert.strictEqual(doc.title, 'Original Title');
    assert.strictEqual(doc.body.innerHTML, 'ORIGINAL-BODY');
  });
}

console.log('Scenario 4 — invalid UTF-8');
{
  // 0xFF 0xFE followed by an unterminated 0xE0 lead byte: never legal UTF-8.
  const badBytes = Buffer.concat([
    Buffer.from([0x48, 0x69]),
    Buffer.from([0xff, 0xfe, 0xe0, 0x80]),
    Buffer.alloc(40, 0x61)
  ]);
  const pieces = makePiecesFromBytes(badBytes);
  check('pure decode: valid base64 but garbage UTF-8 -> invalid-utf8', () => {
    const r = Lnd.decode({ pieces, keyBase64: KEY_B64 });
    assertStatusShape(r.status);
    assert.strictEqual(r.status.success, false);
    assert.strictEqual(r.status.failureCategory, 'invalid-utf8');
    assert.deepStrictEqual(r.status.pieces, [0,1,2,3,4,5,6,7,8,9,10]);
    assert.ok(/UTF-8/i.test(r.status.reason));
    assert.strictEqual(r.html, undefined);
  });
  check('DOM run: invalid UTF-8 leaves page intact', () => {
    const { doc } = makeDoc(pieces);
    const status = Lnd.run(doc);
    assert.strictEqual(status.failureCategory, 'invalid-utf8');
    assert.strictEqual(doc.title, 'Original Title');
    assert.strictEqual(doc.body.innerHTML, 'ORIGINAL-BODY');
  });
}

console.log('Scenario 5 — full success');
{
  const pieces = makePieces(SAMPLE_HTML);
  check('pure decode: round-trips the HTML byte-for-byte', () => {
    const r = Lnd.decode({ pieces, keyBase64: KEY_B64 });
    assert.strictEqual(r.status, null);
    assert.strictEqual(r.html, SAMPLE_HTML);
  });
  check('DOM run: title/head/body restored, scripts replayed in order', () => {
    const { doc, appendedToHead, appendedScripts } = makeDoc(pieces);
    const status = Lnd.run(doc);
    assertStatusShape(status);
    assert.strictEqual(status.success, true);
    assert.strictEqual(status.failureCategory, null);
    assert.strictEqual(status.restoredHtmlLength, SAMPLE_HTML.length);
    assert.strictEqual(status.inlineScriptCount, 2);       // empty inline skipped
    assert.strictEqual(status.externalScriptCount, 2);
    assert.strictEqual(doc.title, 'Restored Sales Board');
    assert.ok(!/headScriptShouldBeIgnored/.test(doc.body.innerHTML));
    assert.ok(doc.body.innerHTML.includes('SalesPulse 360'));
    assert.deepStrictEqual(appendedToHead.map((n) => n.tagName),
      ['META', 'META', 'BASE', 'STYLE']); // title and head script excluded
    assert.strictEqual(appendedScripts.length, 4);
    assert.strictEqual(appendedScripts[0].src, 'external-a.js');
    assert.strictEqual(appendedScripts[1].textContent.includes('__inlineRan'), true);
    assert.strictEqual(appendedScripts[2].src, 'external-b.js');
    assert.strictEqual(global.LND_DECODE_STATUS.success, true);
    assert.ok(Object.isFrozen(global.LND_DECODE_STATUS));
  });
}

console.log('Regression — real index.html payload (1 inline, 0 external)');
{
  const fs = require('fs');
  const html = fs.readFileSync(path.resolve(__dirname, '..', 'index.html'), 'utf8');
  const pieces = [];
  for (let i = 0; i < N; i++) {
    const m = new RegExp('<template id="' + Lnd.PIECE_PREFIX + i + '">([\\s\\S]*?)</template>').exec(html);
    pieces.push(m ? m[1] : null);
  }
  check('decodes the production page and counts its single inline script', () => {
    const r = Lnd.decode({ pieces, keyBase64: KEY_B64 });
    assert.strictEqual(r.status, null);
    assert.strictEqual(r.html.length, 24024);
    assert.ok(/<title>MahbubNibir\/power-bi-retail-analytics-viz - Install<\/title>/.test(r.html));
    const body = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(r.html)[1];
    const scripts = [...body.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    const inline = scripts.filter((m) => !/src\s*=/.test(m[1]) && m[2].trim()).length;
    const external = scripts.filter((m) => /src\s*=/.test(m[1])).length;
    const { doc } = makeDoc(pieces);
    const status = Lnd.run(doc);
    assert.strictEqual(status.success, true);
    assert.strictEqual(status.inlineScriptCount, inline);
    assert.strictEqual(status.externalScriptCount, external);
    assert.strictEqual(status.inlineScriptCount, 1);
    assert.strictEqual(status.externalScriptCount, 0);
  });
}

console.log('Edge cases — exception containment');
{
  const pieces = makePieces(SAMPLE_HTML);
  check('atob throwing is caught and reported, never bubbles to the page', () => {
    const realAtob = globalThis.atob;
    let calls = 0;
    globalThis.atob = function (b64) {
      // First call decodes the key (must succeed); the payload call throws.
      if (++calls === 2) throw new Error('SyntaxError: bogus atob');
      return realAtob(b64);
    };
    try {
      const r = Lnd.decode({ pieces, keyBase64: KEY_B64 });
      assertStatusShape(r.status);
      assert.strictEqual(r.status.success, false);
      assert.strictEqual(r.status.failureCategory, 'invalid-base64');
      assert.deepStrictEqual(r.status.pieces, [10]);
      assert.ok(/bogus atob/.test(r.status.reason));
    } finally {
      globalThis.atob = realAtob;
    }
  });
  check('unexpected DOM exception -> unexpected-error, status still well-formed', () => {
    const { doc } = makeDoc(pieces);
    const realGet = doc.getElementById.bind(doc);
    let calls = 0;
    doc.getElementById = function (id) {
      if (++calls > 3) throw new Error('DOM exploded');
      return realGet(id);
    };
    const status = Lnd.run(doc);
    assertStatusShape(status);
    assert.strictEqual(status.success, false);
    assert.strictEqual(status.failureCategory, 'unexpected-error');
    assert.ok(/DOM exploded/.test(status.reason));
    assert.strictEqual(doc.title, 'Original Title');
  });
  check('UTF-8 failure reason names the offending offset', () => {
    const bad = makePiecesFromBytes(Buffer.concat([
      Buffer.alloc(80, 0x61), Buffer.from([0xff, 0xfe])
    ]));
    const r = Lnd.decode({ pieces: bad, keyBase64: KEY_B64 });
    assert.strictEqual(r.status.failureCategory, 'invalid-utf8');
    assert.ok(/offset 80/.test(r.status.reason), r.status.reason);
  });
  check('valid multibyte UTF-8 decodes cleanly', () => {
    const unicode = '<title>看板 — SalesPulse 360 ✓</title><body><p>日本語テスト</p></body>';
    const r = Lnd.decode({ pieces: makePieces(unicode), keyBase64: KEY_B64 });
    assert.strictEqual(r.status, null);
    assert.strictEqual(r.html, unicode);
  });
}

delete global.LND_DECODE_STATUS;
console.log('\n' + (process.exitCode ? 'SOME TESTS FAILED' : passed + ' checks passed'));
