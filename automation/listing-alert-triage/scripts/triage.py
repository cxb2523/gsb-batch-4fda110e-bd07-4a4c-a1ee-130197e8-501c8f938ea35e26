#!/usr/bin/env python3
"""listing-alert-triage: extract price / surface / city from property alert
e-mails (plain text, HTML or .eml), compute price per m2, compare to a
reference and rank listings. Standard library only.

Every record read from the input is accounted for: complete listings go to
the ranked output, while entries missing a price or a surface are reported
as *unparsed* entries (with the fields that were found, the source label and
the reason) instead of being silently dropped."""
import argparse, csv, email, html, io, json, re, sys
from email import policy
from pathlib import Path

PRICE_RE = re.compile(r'(?<![\d.,])(\d{1,3}(?:[   .]\d{3})+|\d{4,8})\s*(?:€|eur\b|euros?\b)', re.I)
AREA_RE = re.compile(r'(?<![\d.,])(\d{1,4}(?:[.,]\d{1,2})?)\s*(?:m²|m2|m²|metres? carres?|mètres? carrés?)', re.I)
CITY_POSTAL_RE = re.compile(r'\b(\d{5})\s+([A-ZÀ-ÖØ-Þ][\wÀ-ÿ\'\- ]{1,40}?)(?=\s*[\n,;.()|]|\s{2,}|$)')
CITY_BEFORE_POSTAL_RE = re.compile(r'(?m)^[ \t]*([A-ZÀ-ÖØ-Þ][\wÀ-ÿ\'\-]+(?:[ \-][A-ZÀ-ÖØ-Þ][\wÀ-ÿ\'\-]+){0,3})[ \t]*[,(\-]?[ \t]*\(?(\d{5})\)?[ \t]*$')
CITY_PREP_RE = re.compile(r'\b(?:à|a|in)\s+([A-ZÀ-ÖØ-Þ][\wÀ-ÿ\'\-]+(?:[ \-][A-ZÀ-ÖØ-Þ][\wÀ-ÿ\'\-]+){0,3})')
URL_RE = re.compile(r'https?://[^\s<>"\')]+')

def to_int(s):
    return int(re.sub(r'[   .]', '', s))

def read_text(path):
    p = Path(path)
    raw = p.read_bytes()
    if p.suffix.lower() == '.eml':
        msg = email.message_from_bytes(raw, policy=policy.default)
        body = msg.get_body(preferencelist=('plain', 'html'))
        text = body.get_content() if body else ''
        if body is not None and body.get_content_type() == 'text/html':
            text = html_to_text(text)
        return text
    text = raw.decode('utf-8', errors='replace')
    if '<html' in text.lower() or '<table' in text.lower():
        text = html_to_text(text)
    return text

def html_to_text(s):
    s = re.sub(r'(?is)<(script|style).*?</\1>', ' ', s)
    s = re.sub(r'(?is)<a\s[^>]*href=["\']([^"\']+)["\'][^>]*>(.*?)</a>', r' \2 \1 ', s)
    s = re.sub(r'(?i)<br\s*/?>|</(p|div|tr|li|h\d|table)>', '\n', s)
    s = re.sub(r'(?s)<[^>]+>', ' ', s)
    s = html.unescape(s)
    return re.sub(r'[ \t]+', ' ', s)

def _first_meaningful_line(chunk):
    for line in chunk.splitlines():
        line = line.strip()
        if line and not re.fullmatch(r'[-=_*\s]+', line):
            return line
    return ''

def _is_url_only(chunk):
    lines = [l.strip() for l in chunk.splitlines() if l.strip()]
    return bool(lines) and all(URL_RE.fullmatch(l) for l in lines)

def iter_blocks(text):
    """Split an e-mail into listing blocks.

    Blocks are separated by blank lines or ``---`` style separator lines.
    A title chunk (no price and no area) and a bare price/area fragment are
    merged with their neighbours across blank lines, so a title/price line
    separated from its surface line by a blank line is reassembled into one
    listing. Two chunks that each carry both a price and an area are by
    definition two distinct listings and are never merged; a fragment whose
    first line is prose (its own title line) likewise starts a new entry
    instead of being glued onto the previous fragment. Leftover fragments at
    end of input are yielded as well, so nothing read is silently discarded.
    """
    chunks = [c.strip() for c in
              re.split(r'\n\s*\n|\n[-=_*]{3,}\n', text) if c.strip()]
    blocks = []
    titles = []        # title/description chunks waiting for their entry
    partials = []      # chunks of the in-progress price-or-area fragment
    def flush_partials():
        if partials:
            blocks.append('\n'.join(titles + partials))
            titles.clear()
            partials.clear()
    for c in chunks:
        if re.fullmatch(r'[-=_*\s]+', c):
            continue
        has_price = bool(PRICE_RE.search(c))
        has_area = bool(AREA_RE.search(c))
        if not has_price and not has_area:
            if _is_url_only(c):
                # A link line belongs to the entry it follows.
                if partials:
                    partials.append(c)
                elif blocks:
                    blocks[-1] = blocks[-1] + '\n' + c
                else:
                    titles.append(c)
                continue
            # A title/prose line is the start of a new entry: any fragment
            # still waiting is flushed on its own first.
            flush_partials()
            if len(c) <= 200:
                titles.append(c)
            continue
        if has_price and has_area:
            # A complete listing never absorbs a preceding price/area
            # fragment: that fragment belongs to another (incomplete) entry.
            flush_partials()
            blocks.append('\n'.join(titles + [c]) if titles else c)
            titles = []
            continue
        # Partial chunk: price or area, not both. A chunk whose first line
        # is prose carries its own title and therefore starts a new entry;
        # bare "Price: ..." / "Surface: ..." lines may continue the current
        # fragment (the split-across-blank-lines case).
        first = _first_meaningful_line(c)
        starts_entry = bool(first) and not PRICE_RE.search(first) \
            and not AREA_RE.search(first)
        if partials and starts_entry:
            flush_partials()
        partials.append(c)
        if any(PRICE_RE.search(p) for p in partials) and \
           any(AREA_RE.search(p) for p in partials):
            flush_partials()
    flush_partials()
    # leftover title-only chunks describe nothing extractable: ignored
    return blocks

def extract_city(b):
    m2 = CITY_BEFORE_POSTAL_RE.search(b)
    m = CITY_POSTAL_RE.search(b)
    if m2:
        return m2.group(1).strip(), m2.group(2)
    if m:
        return m.group(2).strip(), m.group(1)
    m = CITY_PREP_RE.search(b)
    return (m.group(1).strip(), None) if m else (None, None)

def first_title_line(b):
    return next((l.strip() for l in b.splitlines()
                 if l.strip() and not re.fullmatch(r'[-=_*\s]+', l)), '')[:90]

def parse_block(b):
    """Parse one block. Always returns a record dict.

    A record with both price and area gets ``status == 'parsed'`` and a
    price per m2. Otherwise ``status == 'unparsed'`` with the fields that
    were found plus a ``missing`` list and a human-readable ``reason``."""
    pm = PRICE_RE.search(b)
    am = AREA_RE.search(b)
    price = to_int(pm.group(1)) if pm else None
    area = float(am.group(1).replace(',', '.')) if am else None
    city, postal = extract_city(b)
    um = URL_RE.search(b)
    rec = {
        'status': 'unparsed',
        'title': first_title_line(b),
        'price': price,
        'area_m2': area,
        'price_per_m2': None,
        'city': city,
        'postal': postal,
        'url': um.group(0) if um else None,
        'missing': [],
        'reason': '',
    }
    missing = []
    if price is None:
        missing.append('price')
    if area is None:
        missing.append('area')
    if missing:
        rec['missing'] = missing
        rec['reason'] = 'missing ' + ' and '.join(missing)
        return rec
    if price <= 0 or area <= 0:
        rec['reason'] = 'non-positive price or surface'
        return rec
    rec['status'] = 'parsed'
    rec['price_per_m2'] = round(price / area)
    return rec

def norm(s):
    s = (s or '').lower()
    for a, b in zip('àâäéèêëîïôöùûüç', 'aaaeeeeiioouuuc'):
        s = s.replace(a, b)
    return re.sub(r'[^a-z0-9]+', ' ', s).strip()

def field_key(rec):
    """Original dedup key: price + surface + normalized city."""
    return (rec['price'], rec['area_m2'], norm(rec['city']))

def load_refs(args):
    refs = {}
    if args.ref_file:
        data = json.loads(Path(args.ref_file).read_text())
        refs.update({norm(k): float(v) for k, v in data.items()})
    for item in args.ref or []:
        k, _, v = item.rpartition('=')
        refs[norm(k)] = float(v)
    return refs

def classify(l, refs, a):
    ref = refs.get(norm(l['city'])) if l['city'] else None
    if ref is None:
        ref = refs.get('default')
    l['ref_per_m2'] = ref
    reasons = []
    if ref:
        l['ratio'] = round(l['price_per_m2'] / ref, 2)
    else:
        l['ratio'] = None
    if a.max_price and l['price'] > a.max_price:
        reasons.append('over max price')
    if a.min_area and l['area_m2'] < a.min_area:
        reasons.append('below min surface')
    if a.max_area and l['area_m2'] > a.max_area:
        reasons.append('above max surface')
    if reasons:
        l['verdict'] = 'excluded'
    elif l['ratio'] is None:
        l['verdict'] = 'no-reference'
    elif l['ratio'] <= a.gem_ratio:
        l['verdict'] = 'GEM'
        reasons.append(f"{round((1 - l['ratio']) * 100)}% below reference")
    elif l['ratio'] <= a.watch_ratio:
        l['verdict'] = 'watch'
        reasons.append('slightly below/near reference')
    else:
        l['verdict'] = 'pass'
        reasons.append('at or above reference')
    if l['ratio'] is not None and l['ratio'] < a.suspect_ratio:
        l['verdict'] += '?'
        reasons.append('suspiciously cheap: check for error/scam/major defect')
    l['reasons'] = '; '.join(reasons)
    return l

ORDER = {'GEM': 0, 'GEM?': 0, 'watch': 1, 'watch?': 1, 'no-reference': 2, 'pass': 3, 'excluded': 4}

def run(sources, args):
    """Triage every input.

    ``sources`` is an iterable of ``(source_label, text)`` tuples; the label
    is a file path or ``<stdin>`` and is attached to every output record.
    Returns a dict with ``listings`` (ranked), ``unparsed`` (entries missing
    a price or a surface) and ``counts``."""
    refs = load_refs(args)
    seen_urls, seen_fields = set(), set()
    listings, unparsed = [], []
    for source, text in sources:
        for b in iter_blocks(text):
            rec = parse_block(b)
            rec['source'] = source
            fk = field_key(rec)
            # Link-aware dedup: a URL distinguishes same price/surface/city
            # listings; without a URL the original field key is used. A
            # linkless repeat of a listing already seen (with or without a
            # link) is still recognised as a duplicate.
            if rec['url']:
                if rec['url'] in seen_urls:
                    continue
            elif fk in seen_fields:
                continue
            seen_urls.add(rec['url']) if rec['url'] else None
            seen_fields.add(fk)
            if rec['status'] == 'parsed':
                listings.append(classify(rec, refs, args))
            else:
                unparsed.append(rec)
    listings.sort(key=lambda x: (ORDER.get(x['verdict'], 5),
                                 x['ratio'] if x['ratio'] is not None else 9))
    by_verdict = {}
    for l in listings:
        by_verdict[l['verdict']] = by_verdict.get(l['verdict'], 0) + 1
    counts = {
        'total': len(listings) + len(unparsed),
        'parsed': len(listings),
        'unparsed': len(unparsed),
        'by_verdict': by_verdict,
    }
    return {'listings': listings, 'unparsed': unparsed, 'counts': counts}

CSV_FIELDS = ['status', 'verdict', 'city', 'postal', 'price', 'area_m2',
              'price_per_m2', 'ref_per_m2', 'ratio', 'reasons', 'url',
              'title', 'source', 'missing']

def render(result, fmt):
    listings, unparsed, counts = result['listings'], result['unparsed'], result['counts']
    if fmt == 'json':
        return json.dumps({'counts': counts, 'listings': listings,
                           'unparsed': unparsed}, ensure_ascii=False, indent=2)
    if fmt == 'csv':
        f = io.StringIO()
        w = csv.DictWriter(f, fieldnames=CSV_FIELDS, extrasaction='ignore')
        w.writeheader()
        for r in listings + unparsed:
            row = dict(r)
            if isinstance(row.get('missing'), list):
                row['missing'] = '|'.join(row['missing'])
            w.writerow(row)
        return f.getvalue()
    lines = []
    for r in listings:
        ratio = f"{r['ratio']:.2f}x" if r['ratio'] else 'n/a'
        lines.append(f"[{r['verdict']:<12}] {r['city'] or '?':<14} {r['price']:>9,} EUR  {r['area_m2']:>6g} m2  {r['price_per_m2']:>6,} EUR/m2  ref {r['ref_per_m2'] or 'n/a'}  ratio {ratio}".replace(',', ' '))
        if r['reasons']:
            lines.append(f"    -> {r['reasons']}")
        if r['url']:
            lines.append(f"    {r['url']}")
    if unparsed:
        if lines:
            lines.append('')
        lines.append(f"Unparsed entries ({len(unparsed)}):")
        for r in unparsed:
            price = f"{r['price']:,} EUR".replace(',', ' ') if r['price'] is not None else 'n/a'
            area = f"{r['area_m2']:g} m2" if r['area_m2'] is not None else 'n/a'
            lines.append(f"[UNPARSED    ] {r['reason']:<24} source: {r['source']}")
            if r['title']:
                lines.append(f"    title: {r['title']}")
            lines.append(f"    price: {price}  area: {area}  city: {r['city'] or '?'}")
            if r['url']:
                lines.append(f"    {r['url']}")
    if not lines:
        return 'No listing with both a price and a surface was found.'
    lines.append('')
    lines.append(f"Summary: {counts['parsed']} parsed, {counts['unparsed']} unparsed "
                 f"({counts['total']} entries total)")
    return '\n'.join(lines)

SAMPLE = """New listings for you

Bright 3-room flat
Lyon 69003
Price: 289 000 €
Surface: 72 m²
https://example.com/ad/1001

----------
Studio near the park
42 000 € - 18 m2 à Nowhereville
https://example.com/ad/1002

----------
House with garden, 95m2
Asking 215.000 EUR
33000 Bordeaux
https://example.com/ad/1003

----------
Renovated 2-room, 41,5 m2
Price 119 000 €
75011 Paris
https://example.com/ad/1004

Same flat again:
Lyon 69003
Price: 289 000 €
Surface: 72 m²

----------
Loft whose lines are split by blank lines

Lille 59000

Price: 150 000 €

Surface: 50 m²
https://example.com/ad/1005

----------
Twin flat A
Nantes 44000
100 000 € - 25 m2
https://example.com/ad/1006

----------
Twin flat B
Nantes 44000
100 000 € - 25 m2
https://example.com/ad/1007

----------
Parking spot, no surface given
Lyon 69003
Price: 25 000 €
https://example.com/ad/1008

----------
Storage room, surface only
30 m2 à Marseille
"""

def selftest():
    ns = argparse.Namespace(ref=['Lyon=5000', 'Bordeaux=4000', 'Paris=10500',
                                 'Lille=4000', 'Nantes=5000', 'default=3000'],
                            ref_file=None,
                            max_price=None, min_area=20, max_area=None,
                            gem_ratio=0.85, watch_ratio=0.97, suspect_ratio=0.5)
    res = run([('selftest', SAMPLE)], ns)
    listings, unparsed, counts = res['listings'], res['unparsed'], res['counts']
    by = {r['url']: r for r in listings if r['url']}
    # original guarantees: duplicate removed, arithmetic / verdicts unchanged
    assert counts['parsed'] == 7, counts
    assert by['https://example.com/ad/1001']['price_per_m2'] == 4014
    assert by['https://example.com/ad/1001']['verdict'] == 'GEM'      # 0.80x
    assert by['https://example.com/ad/1003']['price_per_m2'] == 2263
    assert by['https://example.com/ad/1003']['verdict'] == 'GEM'      # 0.57x, not below suspect ratio
    assert by['https://example.com/ad/1004']['verdict'] == 'GEM?'     # 0.27x: flagged suspicious
    assert by['https://example.com/ad/1002']['verdict'] == 'excluded' # 18 m2 < min 20
    assert by['https://example.com/ad/1001']['city'] == 'Lyon'
    # title / price / area split by blank lines is reassembled into one GEM
    loft = by['https://example.com/ad/1005']
    assert loft['verdict'] == 'GEM' and loft['city'] == 'Lille'
    assert loft['price'] == 150000 and loft['area_m2'] == 50.0
    assert loft['title'].startswith('Loft whose lines are split')
    # same price/surface/city but different links: both kept
    assert 'https://example.com/ad/1006' in by
    assert 'https://example.com/ad/1007' in by
    # two complete listings separated by a blank line are never merged
    glued = "Flat one\n100 000 € - 40 m2\nhttps://example.com/x1\n\n" \
            "Flat two\n100 000 € - 40 m2\nhttps://example.com/x2"
    assert run([('t', glued)], ns)['counts']['parsed'] == 2
    # missing surface / missing price show up as unparsed, with reasons
    assert counts['unparsed'] == 2, counts
    no_area = next(u for u in unparsed if u['url'] == 'https://example.com/ad/1008')
    assert no_area['missing'] == ['area'] and no_area['reason'] == 'missing area'
    assert no_area['price'] == 25000 and no_area['city'] == 'Lyon'
    assert no_area['source'] == 'selftest'
    no_price = next(u for u in unparsed if u['url'] is None)
    assert no_price['missing'] == ['price'] and 'price' in no_price['reason']
    assert no_price['area_m2'] == 30.0 and no_price['city'] == 'Marseille'
    assert all(u['status'] == 'unparsed' and u['source'] for u in unparsed)
    # counts are present and consistent
    assert counts['total'] == counts['parsed'] + counts['unparsed'] == 9
    assert sum(counts['by_verdict'].values()) == counts['parsed']
    # all three formats carry the unparsed entries and the counts
    payload = json.loads(render(res, 'json'))
    assert payload['counts']['unparsed'] == 2 and len(payload['unparsed']) == 2
    csv_text = render(res, 'csv')
    assert csv_text.startswith('status,') and 'unparsed' in csv_text
    text = render(res, 'text')
    assert 'Unparsed entries (2)' in text and 'missing area' in text
    # feeding the same input twice must not create duplicates
    again = run([('selftest', SAMPLE), ('selftest', SAMPLE)], ns)
    assert again['counts'] == counts
    return res

def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('files', nargs='*', help='.txt/.html/.eml files (use - for stdin)')
    ap.add_argument('--ref', action='append', metavar='CITY=EUR_PER_M2', help='reference price/m2; repeatable; CITY=default as fallback')
    ap.add_argument('--ref-file', help='JSON file {"City": price_per_m2}')
    ap.add_argument('--gem-ratio', type=float, default=0.85, help='price/m2 <= ratio*ref => GEM (default 0.85)')
    ap.add_argument('--watch-ratio', type=float, default=0.97, help='<= this => watch (default 0.97)')
    ap.add_argument('--suspect-ratio', type=float, default=0.5, help='below this, flag as suspicious (default 0.5)')
    ap.add_argument('--max-price', type=int)
    ap.add_argument('--min-area', type=float)
    ap.add_argument('--max-area', type=float)
    ap.add_argument('--format', choices=['text', 'json', 'csv'], default='text')
    ap.add_argument('--selftest', action='store_true')
    a = ap.parse_args(argv)
    if a.selftest:
        res = selftest()
        print(render(res, 'text'))
        print('\nSELFTEST OK')
        return 0
    sources = []
    for f in a.files or ['-']:
        if f == '-':
            sources.append(('<stdin>', sys.stdin.read()))
        else:
            sources.append((f, read_text(f)))
    # Unparsed entries are reported, not fatal: the exit code stays 0.
    print(render(run(sources, a), a.format))
    return 0

if __name__ == '__main__':
    sys.exit(main())
