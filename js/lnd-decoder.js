/*!
 * lnd-decoder.js — observable, fail-fast decoder for the split-template landing page.
 *
 * The real page is cut into 11 Base64 pieces hidden in <template> elements
 * (ids "<prefix>0" .. "<prefix>10"). Pieces are joined, Base64-decoded, XORed
 * byte-by-byte against a fixed repeating key, and interpreted as UTF-8 HTML.
 *
 * This version turns the self-decoding into something a collector can audit:
 * every run publishes a status object on window.LND_DECODE_STATUS (and a JSON
 * copy on document.documentElement.dataset.lndDecodeStatus). Nothing touches
 * the page until every stage succeeds, so a failure leaves the original title
 * and body intact — no half-rendered content.
 *
 * Status shape (all fields always present):
 *   {
 *     success:            boolean,
 *     failureCategory:    string | null,   // 'missing-piece' | 'invalid-base64'
 *                                          // | 'empty-key' | 'invalid-utf8'
 *                                          // | 'unexpected-error' | null
 *     pieces:             number[],        // piece indices involved in the result
 *     restoredHtmlLength: number,          // restored HTML char count (0 on failure)
 *     inlineScriptCount:  number,          // inline scripts replayed (0 on failure)
 *     externalScriptCount:number,          // external scripts replayed (0 on failure)
 *     reason:             string | null    // human-readable diagnostic
 *   }
 *
 * Pure decode logic is exposed as window.LndDecoder.decode(inputs) so it can be
 * unit-tested in Node without a DOM; applyRestored() handles the DOM write.
 */
(function (root) {
  'use strict';

  var PIECE_COUNT = 11;
  var PIECE_PREFIX = 'lndoxffylyyj';
  var DEFAULT_KEY_B64 = 'IhPbLZzdw/Us37YFCcLBBg3nECHh2c0A';
  var STATUS_KEY = 'LND_DECODE_STATUS';

  function fail(category, pieces, reason) {
    return {
      success: false,
      failureCategory: category,
      pieces: pieces.slice(),
      restoredHtmlLength: 0,
      inlineScriptCount: 0,
      externalScriptCount: 0,
      reason: reason || null
    };
  }

  function success(restoredHtml, inlineCount, externalCount) {
    return {
      success: true,
      failureCategory: null,
      pieces: [],
      restoredHtmlLength: restoredHtml.length,
      inlineScriptCount: inlineCount,
      externalScriptCount: externalCount,
      reason: null
    };
  }

  // Reject anything outside the standard alphabet and any '=' that is not a
  // trailing pad. Returns an explanatory string, or null when the piece is OK.
  function findBase64Problem(piece, index) {
    if (piece.length === 0) return null; // emptiness is handled as missing-piece
    var bad = piece.match(/[^A-Za-z0-9+/=]/);
    if (bad) {
      return 'piece ' + index + ' contains non-Base64 character ' +
        JSON.stringify(bad[0]) + ' at offset ' + bad.index;
    }
    var padPos = piece.indexOf('=');
    if (padPos !== -1 && /[^=]/.test(piece.slice(padPos))) {
      return 'piece ' + index + ' has padding "=" in a non-trailing position';
    }
    if (padPos !== -1 && piece.length - padPos > 2) {
      return 'piece ' + index + ' has more than two padding characters';
    }
    return null;
  }

  // Structural checks on the joined stream before atob runs.
  function findJoinedBase64Problem(joined, lastPieceIndex) {
    if (joined.length % 4 !== 0) {
      return 'joined Base64 length ' + joined.length +
        ' is not a multiple of 4 (problem located at piece ' + lastPieceIndex + ')';
    }
    var padPos = joined.indexOf('=');
    if (padPos !== -1) {
      var padding = joined.slice(padPos);
      if (padding.length > 2 || /[^=]/.test(padding)) {
        return 'joined Base64 has malformed padding near piece ' + lastPieceIndex;
      }
    }
    return null;
  }

  // Decode Base64 without letting atob exceptions escape to the page.
  function safeAtob(b64, lastPieceIndex) {
    try {
      return { ok: true, binary: root.atob(b64) };
    } catch (e) {
      return {
        ok: false,
        status: fail('invalid-base64', [lastPieceIndex],
          'atob rejected the joined Base64 near piece ' + lastPieceIndex +
          ': ' + (e && e.message ? e.message : String(e)))
      };
    }
  }

  // Fatal UTF-8 validation. A manual pass locates the exact offending offset
  // first (so failures are diagnosable); TextDecoder then produces the text.
  function validateUtf8(bytes) {
    var i = 0;
    while (i < bytes.length) {
      var b = bytes[i], need, min;
      if (b < 0x80) { i++; continue; }
      if (b >= 0xc2 && b <= 0xdf) { need = 1; min = 0x80; }
      else if (b >= 0xe0 && b <= 0xef) {
        need = 2; min = (b === 0xe0) ? 0xa0 : 0x80;
      } else if (b >= 0xf0 && b <= 0xf4) {
        need = 3; min = (b === 0xf0) ? 0x90 : 0x80;
      } else {
        return 'restored bytes are not valid UTF-8 (bad lead byte 0x' +
          b.toString(16) + ' at offset ' + i + ')';
      }
      if (i + need >= bytes.length) {
        return 'restored bytes are not valid UTF-8 (truncated sequence at offset ' + i + ')';
      }
      for (var j = 1; j <= need; j++) {
        var cb = bytes[i + j];
        if (cb < (j === 1 ? min : 0x80) || cb > 0xbf) {
          return 'restored bytes are not valid UTF-8 (bad continuation byte 0x' +
            cb.toString(16) + ' at offset ' + (i + j) + ')';
        }
      }
      i += need + 1;
    }
    return null;
  }

  function decodeUtf8(bytes) {
    var problem = validateUtf8(bytes);
    if (problem) return { ok: false, reason: problem };
    if (typeof root.TextDecoder === 'function') {
      try {
        return { ok: true, text: new root.TextDecoder('utf-8').decode(bytes) };
      } catch (e) {
        return { ok: false, reason: 'restored bytes are not valid UTF-8: ' +
          (e && e.message ? e.message : String(e)) };
      }
    }
    return { ok: false, reason: 'no UTF-8 decoder available in this environment' };
  }

  /**
   * Pure decode stage. No DOM access.
   * inputs: { pieces: string[11], keyBase64: string }
   * Returns { status, html? } where html is present only on full success.
   */
  function decode(inputs) {
    var pieces = inputs.pieces;
    var keyB64 = inputs.keyBase64;

    // Stage 1 — every piece 0..10 must exist and be non-empty.
    var missing = [];
    for (var i = 0; i < PIECE_COUNT; i++) {
      if (pieces[i] == null || String(pieces[i]).trim() === '') missing.push(i);
    }
    if (missing.length) {
      return { status: fail('missing-piece', missing,
        'missing piece(s): ' + missing.join(', ')) };
    }

    // Stage 2 — per-piece Base64 alphabet/padding validation.
    var lastNonEmpty = PIECE_COUNT - 1;
    for (i = 0; i < PIECE_COUNT; i++) {
      var problem = findBase64Problem(pieces[i], i);
      if (problem) return { status: fail('invalid-base64', [i], problem) };
    }

    var joined = pieces.join('');
    var joinedProblem = findJoinedBase64Problem(joined, lastNonEmpty);
    if (joinedProblem) {
      return { status: fail('invalid-base64', [lastNonEmpty], joinedProblem) };
    }

    // Stage 3 — key must be present and decode to at least one byte.
    if (keyB64 == null || String(keyB64) === '') {
      return { status: fail('empty-key', range(), 'XOR key is empty') };
    }
    var keyBinary;
    try {
      keyBinary = root.atob(String(keyB64));
    } catch (e) {
      // A malformed key is still a key-stage failure, not a payload one.
      return { status: fail('empty-key', range(),
        'XOR key is unusable: not valid Base64: ' +
        (e && e.message ? e.message : String(e))) };
    }
    if (keyBinary.length === 0) {
      return { status: fail('empty-key', range(), 'XOR key decodes to zero bytes') };
    }

    // Stage 4 — joined Base64 decode (guarded; structural checks ran above).
    var decoded = safeAtob(joined, lastNonEmpty);
    if (!decoded.ok) return { status: decoded.status };
    var encrypted = decoded.binary;

    // Stage 5 — byte-wise repeating-key XOR.
    var bytes = new Uint8Array(encrypted.length);
    for (var k = 0; k < encrypted.length; k++) {
      bytes[k] = encrypted.charCodeAt(k) ^ keyBinary.charCodeAt(k % keyBinary.length);
    }

    // Stage 6 — strict UTF-8 decode; garbled bytes become a located failure.
    var utf8 = decodeUtf8(bytes);
    if (!utf8.ok) {
      return { status: fail('invalid-utf8', range(), utf8.reason) };
    }

    return { status: null, html: utf8.text };
  }

  function range() {
    var out = [];
    for (var i = 0; i < PIECE_COUNT; i++) out.push(i);
    return out;
  }

  /**
   * DOM application stage. Mirrors the original behaviour:
   *  - document.title is taken from the restored <title>
   *  - only STYLE/META/LINK/BASE from head are copied (title excluded)
   *  - body scripts are stripped first, body is replaced, then scripts are
   *    re-created and replayed in original order (external ones keep @src)
   * Returns { inline, external } counts actually scheduled.
   */
  function applyRestored(doc, restoredHtml) {
    var titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(restoredHtml);
    if (titleMatch) doc.title = titleMatch[1];

    var headMatch = /<head[^>]*>([\s\S]*?)<\/head>/i.exec(restoredHtml);
    var bodyMatch = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(restoredHtml);
    var headHtml = headMatch ? headMatch[1] : '';
    var bodyHtml = bodyMatch ? bodyMatch[1] : restoredHtml;

    if (headHtml) {
      var holder = doc.createElement('div');
      holder.innerHTML = headHtml.replace(/<title[^>]*>[\s\S]*?<\/title>/i, '');
      while (holder.firstChild) {
        var node = holder.firstChild;
        var tag = (node.tagName || '').toUpperCase();
        if (tag === 'STYLE' || tag === 'META' || tag === 'LINK' || tag === 'BASE') {
          doc.head.appendChild(node);
        } else {
          holder.removeChild(node);
        }
      }
    }

    var scripts = [];
    bodyHtml = bodyHtml.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi,
      function (m, attrs, content) {
        var srcMatch = /src\s*=\s*["']([^"']+)["']/i.exec(attrs);
        if (srcMatch) {
          scripts.push({ external: true, src: srcMatch[1] });
        } else if (content.trim()) {
          scripts.push({ external: false, content: content });
        }
        return '';
      });

    doc.body.innerHTML = bodyHtml;

    for (var i = 0; i < scripts.length; i++) {
      var script = doc.createElement('script');
      if (scripts[i].external) {
        script.src = scripts[i].src;
      } else {
        script.textContent = scripts[i].content;
      }
      doc.body.appendChild(script);
    }
    var inline = 0, external = 0;
    for (var s = 0; s < scripts.length; s++) {
      if (scripts[s].external) external++; else inline++;
    }
    return { inline: inline, external: external };
  }

  function publish(doc, status) {
    var frozen = Object.freeze(status);
    try {
      // configurable:true keeps repeated runs (e.g. test harnesses) working;
      // the object itself is frozen and the binding is non-writable.
      Object.defineProperty(root, STATUS_KEY, {
        value: frozen, writable: false, configurable: true, enumerable: true
      });
    } catch (e) {
      root[STATUS_KEY] = frozen; // non-browser / restricted global fallback
    }
    try {
      doc.documentElement.dataset.lndDecodeStatus = JSON.stringify(status);
    } catch (e) { /* dataset unavailable in some stubs; window object is canonical */ }
  }

  function run(doc, options) {
    options = options || {};
    var prefix = options.prefix || PIECE_PREFIX;
    var keyB64 = options.keyBase64 != null ? options.keyBase64 : DEFAULT_KEY_B64;
    var status;
    try {
      // Piece collection is inside the guard too: a DOM exception here must
      // never bubble to the page, it becomes a status object like any other.
      var pieces = [];
      for (var i = 0; i < PIECE_COUNT; i++) {
        var el = doc.getElementById(prefix + i);
        pieces.push(el ? el.innerHTML : null);
      }
      var result = decode({ pieces: pieces, keyBase64: keyB64 });
      if (result.status) {
        status = result.status; // failure: DOM is never touched
      } else {
        var counts = applyRestored(doc, result.html);
        status = success(result.html, counts.inline, counts.external);
      }
    } catch (e) {
      status = fail('unexpected-error', range(),
        (e && e.message ? e.message : String(e)));
    }
    publish(doc, status);
    return status;
  }

  var api = {
    PIECE_COUNT: PIECE_COUNT,
    PIECE_PREFIX: PIECE_PREFIX,
    DEFAULT_KEY_B64: DEFAULT_KEY_B64,
    decode: decode,
    applyRestored: applyRestored,
    run: run
  };
  root.LndDecoder = api;

  // Auto-run in browsers once the parser reaches this script (all templates
  // precede it). Under Node (module.exports present) stay inert.
  if (typeof module === 'undefined' && typeof root.document === 'object') {
    run(root.document, root.LND_DECODER_CONFIG || {});
  } else if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window :
   (typeof globalThis !== 'undefined' ? globalThis : this));
