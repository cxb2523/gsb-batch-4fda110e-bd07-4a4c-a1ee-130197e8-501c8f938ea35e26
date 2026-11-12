# Normalization helpers for job titles and links.
#
# The same opening can show up across pages with trivial differences:
# leading/trailing whitespace, different casing, a trailing slash on the
# URL, or tracking query parameters appended by the hosting platform.
# Normalizing both fields before building a dedup key makes those variants
# collapse into a single job so it is only stored and pushed once.

from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

# Common campaign/tracking parameters that do not identify a posting.
TRACKING_PARAMS = frozenset(
    {
        "utm_source",
        "utm_medium",
        "utm_campaign",
        "utm_term",
        "utm_content",
        "utm_id",
        "utm_name",
        "gclid",
        "fbclid",
        "mc_cid",
        "mc_eid",
        "ref",
        "referrer",
        "source",
        "src",
        "campaign",
        "spm",
        "igshid",
        "si",
    }
)


def normalize_title(title: str) -> str:
    """Trim surrounding whitespace and fold to lowercase."""
    return title.strip().lower()


def normalize_link(link: str) -> str:
    """Normalize a job link.

    - lowercases scheme and host
    - strips a trailing slash from the path (root path becomes ``/``)
    - removes common tracking query parameters, keeping the rest
    - drops a trailing fragment
    """
    parts = urlsplit(link.strip())
    scheme = parts.scheme.lower()
    netloc = parts.netloc.lower()

    path = parts.path
    if len(path) > 1:
        path = path.rstrip("/")

    query_tuples = [
        (key, value)
        for key, value in parse_qsl(parts.query, keep_blank_values=True)
        if key.lower() not in TRACKING_PARAMS
    ]
    query = urlencode(query_tuples)

    return urlunsplit((scheme, netloc, path, query, ""))


def dedup_key(job: dict) -> tuple:
    """Build the normalized (company, title, link) dedup key for a job."""
    return (
        job["company"],
        normalize_title(job["title"]),
        normalize_link(job["link"]),
    )
