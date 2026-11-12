/*
 * test/fixtures.js
 *
 * Self-made fragments and key used to exercise the decoder. The same
 * fixtures drive both the Node test script (run-tests.js) and the browser
 * test page (test.html), so the two can never drift apart.
 *
 * Everything here is fabricated for testing: the interface text, the key
 * and the encoded fragments are all generated in memory.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof root !== 'undefined') root.FragmentDecoderFixtures = api;
})(typeof self !== 'undefined' ? self
   : typeof globalThis !== 'undefined' ? globalThis
   : typeof global !== 'undefined' ? global
   : this, function () {
  'use strict';

  // A self-made 16-byte key (raw byte string). The decoder requires exactly
  // this length. Includes a non-ASCII byte to prove byte handling.
  var SAMPLE_KEY = 'SalesDashKey#016'; // 16 chars/bytes
  // A different key that is ALSO 16 bytes: it passes the length check but the
  // resulting plaintext is garbled, so it must be reported as a corrupt
  // payload rather than a key error.
  var WRONG_KEY = 'WrongBoardKey#09';

  // A self-made interface document. It carries the expected <html> root
  // marker and some multi-byte UTF-8 (emoji + Chinese) so UTF-8 handling is
  // genuinely exercised.
  var SAMPLE_INTERFACE =
    '<!DOCTYPE html>\n' +
    '<html lang="en">\n' +
    '<head><meta charset="utf-8"><title>Sales Dashboard</title></head>\n' +
    '<body>\n' +
    '  <h1>Sales Dashboard — 销售看板</h1>\n' +
    '  <section id="kpi"><p>Revenue · 营收 · 📈</p></section>\n' +
    '</body>\n' +
    '</html>\n';

  function arrEq(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  /*
   * Encode plaintext into `count` base64 fragments using the same scheme as
   * the real page: UTF-8 bytes -> XOR with repeating key -> base64 -> split
   * into contiguous chunks (chunks are rejoined before decoding).
   */
  function encodeFragments(text, key, count) {
    var utf8 = new TextEncoder().encode(text);
    var bin = '';
    for (var i = 0; i < utf8.length; i++) {
      bin += String.fromCharCode(utf8[i] ^ key.charCodeAt(i % key.length));
    }
    var b64 = btoa(bin);
    var chunkSize = Math.ceil(b64.length / count);
    var fragments = [];
    for (var c = 0; c < count; c++) {
      fragments.push(b64.slice(c * chunkSize, (c + 1) * chunkSize));
    }
    return fragments;
  }

  function record(name, pass, detail) {
    return { name: name, pass: !!pass, detail: detail };
  }

  /*
   * Build and evaluate every required scenario against the supplied decoder
   * module (the same object the page exposes globally).
   */
  function executeCases(D) {
    var count = D.FRAGMENT_COUNT;
    var valid = encodeFragments(SAMPLE_INTERFACE, SAMPLE_KEY, count);
    var results = [];

    // 1) Success: all fragments present, correct key.
    var r1 = D.decodeInterfaceFragments(valid.slice(), SAMPLE_KEY);
    results.push(record('success',
      r1.success === true &&
      r1.text === SAMPLE_INTERFACE &&
      r1.reasonCode === D.REASON.OK &&
      arrEq(r1.processedFragments, [0, 1, 2, 3, 4]) &&
      r1.missingFragments.length === 0, r1));

    // 2) Missing fragment: drop fragment #2 (simulate a failed shard fetch).
    var missing = valid.slice();
    missing[2] = '';
    var r2 = D.decodeInterfaceFragments(missing, SAMPLE_KEY);
    results.push(record('missing-fragment',
      r2.success === false &&
      r2.reasonCode === D.REASON.MISSING_FRAGMENTS &&
      arrEq(r2.missingFragments, [2]) &&
      arrEq(r2.processedFragments, [0, 1, 3, 4]), r2));

    // 3a) Corrupt payload: fragment #3 was truncated in transit (the joined
    //     base64 stream is no longer well-formed / no longer decodes to the
    //     original document).
    var truncated = valid.slice();
    truncated[3] = truncated[3].slice(0, Math.max(8, Math.floor(truncated[3].length / 2)));
    var r3a = D.decodeInterfaceFragments(truncated, SAMPLE_KEY);
    // 3b) Corrupt payload: a same-length but wrong key yields garbled text
    //     (invalid UTF-8 and/or no root marker) -> payload corruption.
    var r3b = D.decodeInterfaceFragments(valid.slice(), WRONG_KEY);
    // 3c) Corrupt payload with VALID base64: overwrite the plaintext byte at
    //     the <html root marker and re-encode fragment #0. The base64 stream
    //     still decodes cleanly, so this exercises the root-marker / UTF-8
    //     validation rather than the base64 catch block.
    var markerIndex = SAMPLE_INTERFACE.indexOf('<html');
    var corruptedText =
      SAMPLE_INTERFACE.slice(0, markerIndex) + '?' +
      SAMPLE_INTERFACE.slice(markerIndex + 1);
    var reencoded = encodeFragments(corruptedText, SAMPLE_KEY, count);
    var r3c = D.decodeInterfaceFragments(reencoded, SAMPLE_KEY);
    results.push(record('corrupt-payload',
      r3a.success === false && r3a.reasonCode === D.REASON.PAYLOAD_CORRUPT &&
      r3b.success === false && r3b.reasonCode === D.REASON.PAYLOAD_CORRUPT &&
      r3c.success === false && r3c.reasonCode === D.REASON.PAYLOAD_CORRUPT,
      { truncatedFragment: r3a, wrongSameLengthKey: r3b, destroyedRootMarker: r3c }));

    // 4a) Empty key.
    var r4a = D.decodeInterfaceFragments(valid.slice(), '');
    // 4b) Wrong-length key (bonus, covers the "length mismatch" branch).
    var r4b = D.decodeInterfaceFragments(valid.slice(), 'too-short-key');
    results.push(record('empty-or-bad-key',
      r4a.success === false && r4a.reasonCode === D.REASON.INVALID_KEY &&
      r4b.success === false && r4b.reasonCode === D.REASON.INVALID_KEY,
      { emptyKey: r4a, wrongLengthKey: r4b }));

    return results;
  }

  return {
    SAMPLE_KEY: SAMPLE_KEY,
    WRONG_KEY: WRONG_KEY,
    SAMPLE_INTERFACE: SAMPLE_INTERFACE,
    encodeFragments: encodeFragments,
    executeCases: executeCases,
    arrEq: arrEq
  };
});
