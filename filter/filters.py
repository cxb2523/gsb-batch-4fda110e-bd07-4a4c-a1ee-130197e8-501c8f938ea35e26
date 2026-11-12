# Job title filters

# The `allow` list contains terms that you want to include in any job titles found.
# The `deny` list contains terms that you want to exclude from any job titles found.
# Try all combinations of terms to be safe, e.g. "jr" and "jr." for "junior", "sr" and "sr." for "senior", etc.

import re
import yaml

with open("config/config.yaml", "r") as f:
    config = yaml.safe_load(f)


def filter_title(title: str) -> bool:
    title = title.lower()
    allow = config["filters"]["allow"]
    deny = config["filters"]["deny"]

    allowed = any(re.search(rf"\b{re.escape(term)}\b", title) for term in allow)
    denied = any(re.search(rf"\b{re.escape(term)}\b", title) for term in deny)

    return allowed and not denied
