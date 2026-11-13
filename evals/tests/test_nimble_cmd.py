"""Unit tests for bashlex-based Nimble CLI family extraction."""

from __future__ import annotations

import pytest

from evals.commons.nimble_cmd import (
    add_nimble_tools,
    family_from_nimble_argv,
    iter_nimble_argvs,
    nimble_tools_from_command,
)


@pytest.mark.parametrize(
    ("argv", "expected"),
    [
        (["nimble", "search", "--query", "acme"], "nimble search"),
        (["nimble", "map", "--url", "https://x"], "nimble map"),
        (["nimble", "crawl", "run", "--url", "https://x"], "nimble crawl"),
        (["nimble", "tasks", "get", "--id", "t1"], "nimble task"),
        (["nimble", "task", "results", "--id", "t1"], "nimble task"),
        (["nimble", "extract", "run", "--url", "https://x"], "nimble extract"),
        (["nimble", "extract:templates", "list"], "nimble extract"),
        (["nimble", "agents", "list"], "nimble agent"),
        (["nimble", "agents:runs", "create", "--agent-id", "x"], "nimble agent create"),
        (["nimble", "agents", "create", "--agent-name", "x"], "nimble agent create"),
        (["nimble", "agents:templates", "list"], "nimble agent"),
        (
            [
                "nimble",
                "--client-source",
                "nimble-agent-skills",
                "search",
                "--query",
                "acme",
            ],
            "nimble search",
        ),
        (
            [
                "nimble",
                "--transform",
                "data.markdown",
                "extract",
                "run",
                "--url",
                "https://example.com",
            ],
            "nimble extract",
        ),
        (["nimble", "--debug", "map", "--url", "https://x"], "nimble map"),
        (["/usr/local/bin/nimble", "search", "--query", "x"], "nimble search"),
        (["nimble", "--version"], None),
        (["echo", "nimble", "search"], None),
    ],
)
def test_family_from_nimble_argv(argv: list[str], expected: str | None) -> None:
    assert family_from_nimble_argv(argv) == expected


@pytest.mark.parametrize(
    ("command", "expected"),
    [
        ("nimble search --query acme", ["nimble search"]),
        (
            "nimble --client-source nimble-agent-skills agents:runs create --agent-id x",
            ["nimble agent create"],
        ),
        (
            "nimble --client-source nimble-agent-skills search --query 'acme corp'",
            ["nimble search"],
        ),
        (
            'nimble --transform "data.markdown" extract run --url https://example.com',
            ["nimble extract"],
        ),
        ("nimble extract:templates list --limit 100", ["nimble extract"]),
        ("nimble agents:templates list", ["nimble agent"]),
        ("nimble agents run --agent-name foo --input 'hi'", ["nimble agent"]),
        (
            "nimble agents:runs get --agent-id a --run-id r",
            ["nimble agent"],
        ),
        (
            "nimble agents:runs result --agent-id a --run-id r",
            ["nimble agent"],
        ),
        (
            "nimble agents:runs stream-events --agent-id a --run-id r",
            ["nimble agent"],
        ),
        ("nimble crawl status --id abc", ["nimble crawl"]),
        ("nimble crawl run --url https://docs.example.com", ["nimble crawl"]),
        ("nimble map --url https://docs.example.com --limit 1000", ["nimble map"]),
        ("nimble tasks results --id tid", ["nimble task"]),
        # Nested zsh -lc (Codex shape)
        (
            '/bin/zsh -lc "nimble --client-source nimble-agent-skills search --query acme"',
            ["nimble search"],
        ),
        (
            "/bin/zsh -lc 'nimble map --url https://x && nimble crawl run --url https://x'",
            ["nimble map", "nimble crawl"],
        ),
        (
            '/bin/zsh -lc "nimble --client-source nimble-agent-skills agents list '
            '&& nimble --client-source nimble-agent-skills agents:templates list"',
            ["nimble agent"],
        ),
        # Multi-line script inside -lc
        (
            '/bin/zsh -lc "mkdir -p .nimble\n'
            'nimble --transform \\"data.markdown\\" extract --url '
            '\\"https://example.com\\" --format markdown > .nimble/out.md\n'
            'wc -l .nimble/out.md"',
            ["nimble extract"],
        ),
        # Must not false-positive on echo / prose
        ("echo 'nimble search --query acme'", []),
        ("cat <<'EOF'\nnimble search --query acme\nEOF", []),
        ("nimble --version && echo ok", []),
        # Dedup
        (
            "nimble search --query a; nimble search --query b",
            ["nimble search"],
        ),
        # env wrapper
        ("env nimble search --query acme", ["nimble search"]),
        ("/usr/bin/env nimble extract run --url https://x", ["nimble extract"]),
    ],
)
def test_nimble_tools_from_command(command: str, expected: list[str]) -> None:
    assert nimble_tools_from_command(command) == expected


def test_iter_nimble_argvs_nested_shell() -> None:
    argvs = iter_nimble_argvs(
        '/bin/zsh -lc "nimble --client-source x agents:runs create --agent-id a"'
    )
    assert len(argvs) == 1
    assert argvs[0][0] == "nimble"
    assert "agents:runs" in argvs[0]


@pytest.mark.parametrize(
    ("command", "expected"),
    [
        # Command substitution as a variable value
        ("out=$(nimble search --query acme)", ["nimble search"]),
        ("out=`nimble search --query acme`", ["nimble search"]),
        ("out=$(nimble extract run --url https://example.com)", ["nimble extract"]),
        # Substitution piped into a post-processor, then used
        (
            (
                "urls=$(nimble map --url https://example.com --limit 100 "
                "| jq -r .urls[])\n"
                'echo "$urls" | head -10'
            ),
            ["nimble map"],
        ),
        # Substitution inside double quotes as an argument
        (
            'echo "Found $(nimble search --query acme | jq length) results"',
            ["nimble search"],
        ),
        # Substitution used as another nimble call's argument
        (
            'nimble search --query "$(nimble extract --url https://example.com)"',
            ["nimble search", "nimble extract"],
        ),
        (
            "nimble search --query `nimble map --url https://example.com`",
            ["nimble search", "nimble map"],
        ),
        # Several substitutions in one line
        (
            "a=$(nimble search --query acme); b=$(nimble crawl run --url https://x)",
            ["nimble search", "nimble crawl"],
        ),
        # Logical operators inside the substitution body
        (
            "out=$(nimble extract --url https://x || nimble crawl run --url https://x)",
            ["nimble extract", "nimble crawl"],
        ),
        (
            "out=$(nimble map --url https://x && nimble search --query acme)",
            ["nimble map", "nimble search"],
        ),
        ("out=`nimble search --query acme && nimble map --url https://x`", ["nimble search", "nimble map"]),
        # env wrapper inside the substitution
        ("out=$(env NIMBLE_API_KEY=k nimble search --query acme)", ["nimble search"]),
        (
            "out=$(env -i PATH=/usr/bin nimble map --url https://x)",
            ["nimble map"],
        ),
        # Substitution wrapping a nested shell, and nesting -lc inside -lc
        (
            "out=$(/bin/zsh -lc 'nimble search --query acme && nimble map --url https://x')",
            ["nimble search", "nimble map"],
        ),
        (
            (
                "x=$(bash -lc 'y=$(zsh -lc \"nimble extract --url https://x "
                '|| nimble crawl run --url https://x\"); echo $y\')'
            ),
            ["nimble extract", "nimble crawl"],
        ),
        (
            (
                "/bin/zsh -lc 'out=$(nimble search --query acme); "
                'echo "$out" | head -5; '
                "nimble extract --url https://x || nimble crawl run --url https://x'"
            ),
            ["nimble search", "nimble extract", "nimble crawl"],
        ),
        # Pipeline and logic combinations outside any substitution
        ("nimble map --url https://x | head -5", ["nimble map"]),
        ("nimble search --query acme 2>&1 | tee out.json | head -20", ["nimble search"]),
        (
            "nimble extract --url https://x || nimble crawl run --url https://x",
            ["nimble extract", "nimble crawl"],
        ),
        (
            (
                "nimble search --query a && nimble map --url https://x && "
                "nimble extract --url https://x"
            ),
            ["nimble search", "nimble map", "nimble extract"],
        ),
        ("false || nimble crawl status --id t1", ["nimble crawl"]),
        # Dedup across the whole command, including substitution copies
        (
            (
                "nimble search --query a | head -3; "
                'x=$(nimble search --query b); echo "$x"'
            ),
            ["nimble search"],
        ),
        (
            (
                "nimble agents:runs create --agent-id a && "
                "x=$(nimble agents:runs create --agent-id b)"
            ),
            ["nimble agent create"],
        ),
        # Comment text beside a real call is ignored, the call still counts
        ("nimble map --url https://x # nimble search --query acme", ["nimble map"]),
        ("# nimble search --query acme\nnimble map --url https://x", ["nimble map"]),
        (
            "nimble search --query acme # $(nimble crawl run --url x)",
            ["nimble search"],
        ),
        # Trailing ``&&`` in prose stays prose; the substitution still counts
        ('echo "v=$(nimble search --query a) && x"', ["nimble search"]),
    ],
)
def test_command_substitution_and_pipelines(command: str, expected: list[str]) -> None:
    assert nimble_tools_from_command(command) == expected


@pytest.mark.parametrize(
    "command",
    [
        # Literal nimble text that is not an invocation
        "echo 'nimble search --query acme'",
        'echo "nimble search --query acme"',
        "echo nimble map --url https://x",
        "'nimble search --query acme'",
        "grep -r 'nimble search' src/",
        # Heredoc bodies (plain, quoted, dash-indented, indented terminator)
        "cat <<EOF\nnimble search --query acme\nEOF",
        "cat <<'EOF'\nnimble search --query acme\nEOF",
        'cat <<"EOF"\nnimble search --query acme\nEOF',
        "cat <<-'EOF'\n\tnimble search --query acme\n\tEOF",
        "cat <<'EOF'\nnimble search --query acme\nEOF\n",
        "python - <<'PY'\nnimble search --query acme\nPY",
        # A heredoc body holding a substitution-looking line is still text
        "cat <<'EOF'\nx=$(nimble search --query a && nimble map --url b)\nEOF",
        # Quoted literal inside a substitution builder
        'echo "$(printf \'%s\' \'nimble search\')"',
        "echo '$(nimble search --query a && nimble map --url b)'",
        # No nimble at all
        "",
        "   ",
    ],
)
def test_literal_mentions_never_count(command: str) -> None:
    assert nimble_tools_from_command(command) == []
    assert iter_nimble_argvs(command) == []


@pytest.mark.parametrize(
    "command",
    [
        "nimble --version",
        "nimble --help",
        "nimble -h",
        "nimble",
        "bash -lc 'nimble --version'",
        'bash -lc "nimble --help"',
        "x=$(nimble --version)",
        "nimble --version && echo ok",
        "nimble --debug",
    ],
)
def test_subcommandless_calls_yield_no_family(command: str) -> None:
    assert nimble_tools_from_command(command) == []


@pytest.mark.parametrize(
    "command",
    [
        # bashlex cannot parse these (unbalanced quote, case patterns,
        # arithmetic expansion). Failures must never raise or guess.
        "nimble search --query 'unterminated",
        "case x in a) nimble search;; esac",
        "n=$(( 1 + 2 )); nimble map --url https://x",
        "if [[ -n \"$X\" ]]; then nimble search --query acme; fi",
        "time nimble search --query acme",
        "arr=(a b); nimble map --url https://x",
        "cat <<'A' <<'B'\none\nA\ntwo\nB",
    ],
)
def test_unparseable_scripts_return_empty(command: str) -> None:
    assert nimble_tools_from_command(command) == []
    assert iter_nimble_argvs(command) == []


def test_add_nimble_tools_appends_unique() -> None:
    tools = ["web_search"]
    add_nimble_tools(
        "nimble --client-source nimble-agent-skills search --query a",
        tools,
    )
    add_nimble_tools(
        "nimble --client-source nimble-agent-skills search --query b",
        tools,
    )
    assert tools == ["web_search", "nimble search"]


def test_normalize_wrapper_matches_module() -> None:
    from evals.commons.normalize import _add_nimble_tools

    tools: list[str] = []
    _add_nimble_tools(
        '/bin/zsh -lc "nimble --client-source nimble-agent-skills '
        'agents:runs create --agent-id x"',
        tools,
    )
    assert tools == ["nimble agent create"]


@pytest.mark.parametrize(
    "command",
    [
        # Codex-shaped argv layouts (synthetic placeholders only — never copy
        # prompts/domains from nimble-web-expert-production or local traces).
        'nimble --client-source nimble-agent-skills search --query \'"WidgetCo Holdings, LLC" Delaware\' --max-results 10 --search-depth deep',
        "nimble --client-source nimble-agent-skills extract run --url 'https://example.com/' --format markdown",
        "nimble --client-source nimble-agent-skills extract:templates list --limit 100",
        "nimble map --url \"https://docs.example.com/rest-api\" --limit 100000 --sitemap include",
        "nimble crawl run --url \"https://docs.example.com/rest-api\" --limit 500",
        "nimble crawl status --id \"9630a454-cf5d-4181-b3c3-ac311cffc545\"",
    ],
)
def test_trace_shaped_commands_classify(command: str) -> None:
    tools = nimble_tools_from_command(command)
    assert tools, f"expected a nimble family for {command!r}"
    assert all(t.startswith("nimble ") for t in tools)


def test_add_nimble_tools_dedups_across_substitution_calls() -> None:
    tools = ["web_search"]
    add_nimble_tools("nimble search --query a | head -3", tools)
    add_nimble_tools("out=$(nimble search --query b && nimble map --url https://x)", tools)
    add_nimble_tools("nimble search --query c || nimble crawl run --url https://x", tools)
    assert tools == ["web_search", "nimble search", "nimble map", "nimble crawl"]


def test_iter_nimble_argvs_collects_substitution_bodies() -> None:
    argvs = iter_nimble_argvs(
        "out=$(nimble extract --url https://x || nimble crawl run --url https://x); "
        "nimble map --url https://x | head -5"
    )
    families = [family_from_nimble_argv(argv) for argv in argvs]
    assert families == ["nimble extract", "nimble crawl", "nimble map"]
    assert all(argv[0] == "nimble" for argv in argvs)


def test_logical_substitution_break_is_whitespace_only() -> None:
    # The repair that makes ``$(… && …)`` parse must not alter the command
    # text other than inserting a line break, so classification is unchanged.
    from evals.commons.nimble_cmd import _break_logical_substitutions

    command = "x=$(nimble search --query a && nimble map --url b)"
    repaired = _break_logical_substitutions(command)
    assert repaired.replace("\n", "") == command
    assert nimble_tools_from_command(command) == ["nimble search", "nimble map"]


def test_quoted_logical_operators_do_not_trigger_repair() -> None:
    # ``&&`` inside a quoted argument is data, not a list separator.
    from evals.commons.nimble_cmd import _break_logical_substitutions

    command = "x=$(nimble search --query 'a && b')"
    assert _break_logical_substitutions(command) == command
    assert nimble_tools_from_command(command) == ["nimble search"]


@pytest.mark.parametrize(
    "command",
    [
        # Real shell snippets that glue an unterminated ``${`` to the next
        # token: bashlex loops forever on these, so the parser must stay
        # finite. No nimble call is present, so the answer is [].
        "grep '${'file",
        "echo '${'x",
    ],
)
def test_unterminated_brace_expansion_terminates(command: str) -> None:
    assert nimble_tools_from_command(command) == []


def test_unterminated_brace_expansion_still_finds_the_real_call() -> None:
    # The snippet before the literal command must not swallow it.
    tools = nimble_tools_from_command(
        "grep -r '${'file; nimble search --query acme"
    )
    assert tools == ["nimble search"]


def test_neutralized_brace_does_not_change_command_text() -> None:
    from evals.commons.nimble_cmd import _neutralize_unclosed_brace_dollar

    command = "grep '${'file; nimble search --query acme"
    neutralized = _neutralize_unclosed_brace_dollar(command)
    # Only the split insertion differs; nothing is dropped or reordered.
    assert neutralized.replace("$ {", "${") == command
    # A brace expansion whose ``}`` is present is left exactly alone.
    for terminated in ('echo "${HOME}"; nimble map --url https://x', "echo ${X:-a b}"):
        assert _neutralize_unclosed_brace_dollar(terminated) == terminated


@pytest.mark.parametrize(
    "command",
    [
        # ``${`` glued to the next token inside one word is the exact shape on
        # which bashlex's word expansion loops forever. Both are real snippets.
        "grep '${'file",
        "sed 's/${/x/' file",
        "echo '$'${'x",
    ],
)
def test_brace_guard_keeps_bashlex_finite(command: str) -> None:
    # Returning [] is the documented answer for an unparseable script; the
    # point here is that it returns at all.
    assert nimble_tools_from_command(command) == []


@pytest.mark.parametrize(
    ("command", "expected"),
    [
        # Shell options between the binary and ``-c`` / ``-lc``
        ("bash -x -lc 'nimble search --query acme'", ["nimble search"]),
        ("bash -euc 'nimble map --url https://x'", ["nimble map"]),
        ("bash -o pipefail -c 'nimble crawl run --url https://x'", ["nimble crawl"]),
        ("sh --norc -c 'nimble extract --url https://x'", ["nimble extract"]),
        # Absolute shell paths and an env prefix in front of the shell
        ("/bin/bash -lc 'nimble extract --url https://x'", ["nimble extract"]),
        ("env X=1 bash -lc 'nimble map --url https://x'", ["nimble map"]),
        # A nested shell inside the -c payload still gets collected
        (
            "bash -lc \"out=$(zsh -c 'nimble search --query acme'); echo $out\"",
            ["nimble search"],
        ),
        # A shell invocation with no inline script has nothing to collect
        ("bash script.sh", []),
        ("bash -l", []),
        ("bash -lc", []),
    ],
)
def test_shell_option_handling(command: str, expected: list[str]) -> None:
    assert nimble_tools_from_command(command) == expected
