"""Parse Nimble CLI invocations out of agent shell commands via bashlex.

Agents reach Nimble through several shell shapes, all of which must be
collected: direct calls, ``env`` prefixes, nested ``bash``/``zsh`` ``-c`` /
``-lc`` scripts, pipelines, ``&&``/``||``/``;`` chains, and command
substitution (``$(...)`` and backticks) used as a variable value or as an
argument. Every ``nimble …`` argv found is normalized to one of the scorer
families (search / extract / map / crawl / agent / task) and deduplicated.

Negative boundaries are strict: literal mentions in ``echo`` arguments, quotes,
heredoc bodies or comments never count; a subcommand-less call
(``nimble --version``, ``nimble --help``) yields nothing; and a script that
cannot be parsed yields an empty list instead of raising.

bashlex needs narrow help on three shapes that appear in real traces — a
logical list inside ``$(...)``, a quoted heredoc delimiter, and a ``${`` with
no ``}`` in its word (on which it loops forever). Those rewrites are
whitespace-only or literal-preserving and run only where the original parse
fails.
"""

from __future__ import annotations

import re
from pathlib import PurePosixPath

import bashlex
from bashlex import ast

# Top-level Nimble resource / verb families we score in evals.
_FAMILY_PREFIXES = (
    "search",
    "extract",
    "map",
    "crawl",
    "agent",
    "agents",
    "task",
    "tasks",
)

# Global options that may appear before the subcommand (from `nimble --help`).
_GLOBAL_FLAGS_WITH_VALUE = frozenset(
    {
        "--base-url",
        "--format",
        "--format-error",
        "--transform",
        "--transform-error",
        "--api-key",
        "--client-source",
    }
)
_GLOBAL_FLAGS_BOOL = frozenset(
    {
        "--debug",
        "--raw-output",
        "-r",
        "--help",
        "-h",
        "--version",
        "-v",
    }
)
_SHELL_BASENAMES = frozenset({"sh", "bash", "zsh", "dash"})

# ``env FOO=1 nimble …`` / ``env -i PATH=… nimble …``
_ENV_ASSIGNMENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
_ENV_FLAGS_WITH_VALUE = frozenset({"-u", "--unset"})

# ``<<'EOF'`` / ``<<"EOF"`` / ``<<-'EOF'``. bashlex rejects quoted heredoc
# delimiters outright, so a failed parse is retried with the quotes stripped.
_QUOTED_HEREDOC_DELIM = re.compile(r"(<<-?)(['\"])([^'\"\n]*)(['\"])")


def _basename(token: str) -> str:
    return PurePosixPath(token).name


def _is_nimble_bin(token: str) -> bool:
    return _basename(token) == "nimble"


def _normalize_family(subcommand: str, argv: list[str]) -> str | None:
    """Map a Nimble subcommand token to a scorer family name."""
    raw = subcommand.lower()
    head = raw.split(":", 1)[0]
    # Legacy / typo forms seen in agent traces.
    if head.startswith("extract"):
        family = "extract"
    elif head in {"agent", "agents"}:
        family = "agent"
    elif head in {"task", "tasks"}:
        family = "task"
    elif head in {"search", "map", "crawl"}:
        family = head
    else:
        return None

    name = f"nimble {family}"
    # Forbidden-tool scorer looks for create variants.
    if family == "agent" and any(tok == "create" for tok in argv):
        return "nimble agent create"
    return name


def _subcommand_after_globals(argv: list[str]) -> tuple[str | None, list[str]]:
    """Return (subcommand, full argv) after skipping nimble global flags."""
    if not argv or not _is_nimble_bin(argv[0]):
        return None, argv
    i = 1
    while i < len(argv):
        tok = argv[i]
        if tok in _GLOBAL_FLAGS_BOOL:
            i += 1
            continue
        if tok in _GLOBAL_FLAGS_WITH_VALUE:
            i += 2
            continue
        if tok.startswith("--") and "=" in tok:
            flag = tok.split("=", 1)[0]
            if flag in _GLOBAL_FLAGS_WITH_VALUE or flag in _GLOBAL_FLAGS_BOOL:
                i += 1
                continue
        # First non-global token is the resource/verb.
        return tok, argv
    return None, argv


def family_from_nimble_argv(argv: list[str]) -> str | None:
    """Classify a tokenized ``nimble …`` argv into a scorer tool name."""
    sub, full = _subcommand_after_globals(argv)
    if not sub:
        return None
    return _normalize_family(sub, full)


class _CommandCollector(ast.nodevisitor):
    def __init__(self) -> None:
        self.argvs: list[list[str]] = []

    def visitcommand(self, n, parts):  # noqa: ANN001
        words: list[str] = []
        for part in parts:
            if getattr(part, "kind", None) == "word":
                words.append(part.word)
        if words:
            self.argvs.append(words)
        return True


def _break_logical_substitutions(script: str) -> str:
    """Insert a line break before ``)`` where a ``$(…)`` holds a logical list.

    bashlex's command-substitution grammar only ends a top-level ``&&`` /
    ``||`` list at a newline, so ``x=$(a && b)`` is rejected while
    ``x=$(a && b\\n)`` parses. The rewrite is whitespace-only: it never
    changes which commands exist, and quoted or escaped text is untouched.
    """
    # [is_substitution, has_logical_operator, enclosing_quote]
    frames: list[list] = []
    inserts: list[int] = []
    quote: str | None = None
    i = 0
    n = len(script)
    while i < n:
        ch = script[i]
        if quote == "'":
            # Single quotes are fully literal: no escapes, no substitutions.
            if ch == "'":
                quote = None
            i += 1
            continue
        if ch == "\\":
            i += 2
            continue
        if quote is not None:
            # Inside double quotes / backticks a bare ``)`` and an opposite
            # quote character are plain text, but ``$(…)`` still opens a
            # fresh shell context.
            if ch == quote:
                quote = None
                i += 1
                continue
            if ch == "$" and script[i + 1 : i + 2] == "(":
                frames.append([True, False, quote])
                quote = None
                i += 2
                continue
            i += 1
            continue
        if ch in {"'", '"', "`"}:
            quote = ch
            i += 1
            continue
        if ch == "$" and script[i + 1 : i + 2] == "(":
            frames.append([True, False, quote])
            i += 2
            continue
        if ch == "(":
            frames.append([False, False, quote])
            quote = None
            i += 1
            continue
        if ch == ")":
            if not frames:
                i += 1
                continue
            is_sub, has_logical, outer_quote = frames.pop()
            quote = outer_quote
            if is_sub and has_logical and script[i - 1 : i] != "\n":
                inserts.append(i)
            i += 1
            continue
        if ch in {"&", "|"} and script[i + 1 : i + 2] == ch:
            # Only the operator's own nesting level is affected; inner parens
            # form their own list and already parse.
            if frames:
                frames[-1][1] = True
            i += 2
            continue
        i += 1
    if not inserts:
        return script
    pieces = script
    for pos in sorted(inserts, reverse=True):
        pieces = f"{pieces[:pos]}\n{pieces[pos:]}"
    return pieces


def _unquote_heredoc_delim(match: re.Match[str]) -> str:
    dash, open_quote, name, close_quote = match.groups()
    if open_quote != close_quote:
        return match.group(0)
    return f"{dash}{name}"


_WORD_BREAK_CHARS = frozenset(" \t\n;&|<>()")


def _word_spans(script: str) -> list[tuple[int, int]]:
    """Split a script into shell word spans, honoring quotes and ``${…}``.

    A word ends at unquoted whitespace or an unquoted operator character.
    Quoted runs and a ``${`` … ``}`` region are part of the word, spanning
    blanks the way bash reads them.
    """
    spans: list[tuple[int, int]] = []
    i = 0
    n = len(script)
    while i < n:
        while i < n and script[i] in _WORD_BREAK_CHARS:
            i += 1
        if i >= n:
            break
        start = i
        quote: str | None = None
        while i < n:
            ch = script[i]
            if quote is not None:
                if ch == quote:
                    quote = None
                elif ch == "\\" and quote == '"':
                    i += 1
                i += 1
                continue
            if ch == "\\":
                i += 2
                continue
            if ch in {"'", '"', "`"}:
                quote = ch
                i += 1
                continue
            if script[i : i + 2] == "${":
                close = script.find("}", i + 2)
                i = close + 1 if close != -1 else i + 2
                continue
            if ch in _WORD_BREAK_CHARS:
                break
            i += 1
        spans.append((start, min(i, n)))
    return spans


def _neutralize_unclosed_brace_dollar(script: str) -> str:
    """Split a ``${`` whose word carries no ``}``, which loops bashlex.

    bashlex reads a ``${`` by jumping to the next ``}`` *inside the word*. With
    no ``}`` there it returns position 0, which its expansion loop re-reads at
    the same spot forever — it hangs instead of raising, as on
    ``grep '${'file``. ``$ {`` is the same literal text to the shell, so the
    rewrite only removes the shape bashlex hangs on; it never touches a
    command name.
    """
    offsets: list[int] = []
    for start, end in _word_spans(script):
        index = script.find("${", start, end)
        while index != -1:
            close = script.find("}", index + 2, end)
            # No ``}`` in this word, and something follows the ``{`` to re-read.
            if close == -1 and index + 2 < end:
                offsets.append(index)
            index = script.find("${", index + 2, end)
    if not offsets:
        return script
    pieces = script
    for index in sorted(offsets, reverse=True):
        pieces = f"{pieces[:index]}$ {{{pieces[index + 2:]}"
    return pieces


def _candidate_scripts(script: str) -> list[str]:
    # Neutralize before anything is handed to bashlex: an unterminated ``${``
    # makes its parser loop forever rather than raise, so it must never be
    # tried. The rewrite only affects text bashlex would hang on.
    script = _neutralize_unclosed_brace_dollar(script)
    candidates = [script]
    broken = _break_logical_substitutions(script)
    if broken != script:
        candidates.append(broken)
    unquoted = _QUOTED_HEREDOC_DELIM.sub(_unquote_heredoc_delim, script)
    if unquoted != script:
        candidates.append(unquoted)
        unquoted_broken = _break_logical_substitutions(unquoted)
        if unquoted_broken != unquoted:
            candidates.append(unquoted_broken)
    return candidates


def _try_parse(candidate: str) -> list | None:
    try:
        return bashlex.parse(candidate)
    except Exception:  # noqa: BLE001 — parse / unsupported-syntax errors
        return None


def _parse_script(script: str) -> list | None:
    """Parse a script, applying narrow repairs only when the first try fails.

    Repairs never invent commands: they only help bashlex tokenize text that
    is already there (a line break the substitution grammar requires, and the
    quoted heredoc delimiters bashlex cannot lex). Heredoc bodies remain
    opaque heredoc nodes, so text inside them is still never collected.
    """
    for candidate in _candidate_scripts(script):
        trees = _try_parse(candidate)
        if trees is not None:
            return trees
    return None


def _parse_argvs(script: str) -> list[list[str]]:
    script = (script or "").strip()
    if not script:
        return []
    trees = _parse_script(script)
    if trees is None:
        return []
    collector = _CommandCollector()
    for tree in trees:
        collector.visit(tree)
    return collector.argvs


def _drop_env_prefix(argv: list[str]) -> list[str]:
    """Strip leading ``env`` wrappers, their options and ``KEY=value`` pairs."""
    while argv and _basename(argv[0]) == "env":
        i = 1
        while i < len(argv):
            tok = argv[i]
            if tok in _ENV_FLAGS_WITH_VALUE:
                i += 2  # ``env -u NAME`` / ``env --unset NAME``
                continue
            if tok == "--":
                i += 1
                break
            if tok.startswith("-") or _ENV_ASSIGNMENT.match(tok):
                i += 1
                continue
            break
        argv = argv[i:]
    return argv


def _inline_script_from_shell_argv(argv: list[str]) -> str | None:
    """Return the script passed to ``sh|bash|zsh|dash -c`` / ``-lc``, if any."""
    i = 1
    while i < len(argv):
        tok = argv[i]
        if tok == "--" or tok.startswith("--"):
            i += 1
            continue
        if tok in {"-o", "-O"}:
            # Shell options that consume the following token.
            i += 2
            continue
        if tok.startswith("-") and len(tok) > 1:
            if "c" in tok[1:]:
                return argv[i + 1] if i + 1 < len(argv) else None
            i += 1
            continue
        break
    return None


def iter_nimble_argvs(command: str) -> list[list[str]]:
    """Extract every ``nimble …`` argv list from a shell command string."""
    found: list[list[str]] = []
    seen: set[tuple[str, ...]] = set()

    def _consider(argv: list[str]) -> None:
        argv = _drop_env_prefix(argv)
        if not argv:
            return
        if _is_nimble_bin(argv[0]):
            key = tuple(argv)
            if key not in seen:
                seen.add(key)
                found.append(argv)
            return
        # Nested shell: ``bash -lc '…'`` / ``zsh -c '…'``. A ``-lc`` payload
        # may itself contain substitution and pipelines, so recurse through
        # the same collector.
        if _basename(argv[0]) in _SHELL_BASENAMES:
            nested_script = _inline_script_from_shell_argv(argv)
            if nested_script:
                for nested in _parse_argvs(nested_script):
                    _consider(nested)

    for argv in _parse_argvs(command):
        _consider(argv)
    return found


def nimble_tools_from_command(command: str) -> list[str]:
    """Return unique scorer tool names for Nimble CLIs inside ``command``."""
    tools: list[str] = []
    for argv in iter_nimble_argvs(command):
        family = family_from_nimble_argv(argv)
        if family and family not in tools:
            tools.append(family)
    return tools


def add_nimble_tools(command: str, tools: list[str]) -> None:
    """Append newly discovered Nimble tool families onto ``tools``."""
    for name in nimble_tools_from_command(command):
        if name not in tools:
            tools.append(name)
