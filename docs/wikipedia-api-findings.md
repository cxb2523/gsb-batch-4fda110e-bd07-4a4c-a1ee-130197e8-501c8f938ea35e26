# Wikipedia API Findings

Probe date: 2026-09-19T18:34:37.446Z

User-Agent: `WikiCrawl/1.0 (set WIKI_CONTACT to a URL or email)`

## Link Ordering, Pagination, and Junk Hubs

The ordering and pagination findings below are **verified** against the live API when this document was generated. Link counts can change as Wikipedia changes.

### Alan Turing

- **Alphabetical/title order: not verified**: the API response is title-sorted only if this boolean is `true`; observed `false`.
- First 15 links: `15.ai`, `1926 United Kingdom general strike`, `A. P. Mahon`, `ACE (computer)`, `ACT-R`, `AI Futures Project`, `AI agent`, `AI alignment`, `AI anthropomorphism`, `AI boom`, `AI bubble`, `AI capability control`, `AI data center`, `AI effect`, `AI infrastructure`
- Total links: **891**
- Requests needed: **2** (**verified** by following every continuation token)
- Junk-hub matches: **25**
- Categories: `{"identifier":12,"bare 4-digit year":0,"Wayback Machine":1,"Wikidata":1,"hub-like title":11}`
- Top 10 offenders: `Bibcode (identifier)`, `Doi (identifier)`, `Hdl (identifier)`, `ISBN (identifier)`, `ISSN (identifier)`, `JSTOR (identifier)`, `List of Fellows of the Royal Society elected in 1951`, `List of artificial intelligence algorithms`, `List of artificial intelligence companies`, `List of artificial intelligence institutions`

### United States

- **Alphabetical/title order: not verified**: the API response is title-sorted only if this boolean is `true`; observed `false`.
- First 15 links: `$`, `.us`, `100th meridian west`, `1788–89 United States presidential election`, `1876 United States presidential election`, `1904 Summer Olympics`, `1916 Danish West Indies status referendum`, `1950s American automobile culture`, `1990s United States boom`, `1994 FIFA World Cup`, `1999 FIFA Women's World Cup`, `1999 FIFA Women's World Cup final`, `2000s United States housing bubble`, `2026 FIFA World Cup`, `2028 Summer Olympics`
- Total links: **2142**
- Requests needed: **5** (**verified** by following every continuation token)
- Junk-hub matches: **128**
- Categories: `{"identifier":13,"bare 4-digit year":0,"Wayback Machine":1,"Wikidata":0,"hub-like title":114}`
- Top 10 offenders: `Bibcode (identifier)`, `Doi (identifier)`, `Hdl (identifier)`, `ISBN (identifier)`, `ISSN (identifier)`, `JSTOR (identifier)`, `LCCN (identifier)`, `List of Alaska Native tribal entities`, `List of American Nobel laureates`, `List of Christian denominations`

### Neural network

- **Alphabetical/title order: not verified**: the API response is title-sorted only if this boolean is `true`; observed `false`.
- First 15 links: `Action potential`, `Activation function`, `Adaptive control`, `Alexander Bain (philosopher)`, `Artificial intelligence`, `Artificial neuron`, `Backpropagation`, `Biological cybernetics`, `Biological neural network`, `Biologically-inspired computing`, `Brain`, `Cell (biology)`, `CiteSeerX (identifier)`, `Confocal microscopy`, `Connectionism`
- Total links: **64**
- Requests needed: **1** (**verified** by following every continuation token)
- Junk-hub matches: **7**
- Categories: `{"identifier":7,"bare 4-digit year":0,"Wayback Machine":0,"Wikidata":0,"hub-like title":0}`
- Top 10 offenders: `CiteSeerX (identifier)`, `Doi (identifier)`, `ISBN (identifier)`, `ISSN (identifier)`, `PMC (identifier)`, `PMID (identifier)`, `S2CID (identifier)`


## Missing-Page Response Shape

**Verified** against the live API. Neither response includes a `pageid`; both include a missing marker. Raw snippets and parsed page entries:

```json
{
  "defaultShape": {
    "page": {
      "ns": 0,
      "title": "Zzzqxjv nonexistent page",
      "missing": ""
    },
    "raw": "{\"batchcomplete\":\"\",\"query\":{\"pages\":{\"-1\":{\"ns\":0,\"title\":\"Zzzqxjv nonexistent page\",\"missing\":\"\"}}}}"
  },
  "formatVersion2Shape": {
    "page": {
      "ns": 0,
      "title": "Zzzqxjv nonexistent page",
      "missing": true
    },
    "raw": "{\"batchcomplete\":true,\"query\":{\"pages\":[{\"ns\":0,\"title\":\"Zzzqxjv nonexistent page\",\"missing\":true}]}}"
  }
}
```

## Redirects

**Verified** against the live API:

```json
{
  "redirects": [
    {
      "from": "USA",
      "to": "United States"
    }
  ],
  "normalized": null
}
```

## Browser CORS Preflight

**Not verified** as an actual browser preflight because this script does not launch a browser. The server-side OPTIONS response is **verified** to return the requested header allowance.

```json
{
  "status": 200,
  "allowHeaders": "api-user-agent",
  "raw": ""
}
```
