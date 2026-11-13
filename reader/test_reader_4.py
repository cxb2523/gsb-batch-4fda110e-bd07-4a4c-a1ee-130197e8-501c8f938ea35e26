"""Auditable per-run records for `reader run` (offline, standard library only).

Each run appends one JSON object to <state_dir>/<name>.runlog.jsonl. These
checks use locally built HTML pages and replace `fetch` with stubs, so they
never reach the network or the crawl4ai helper.
"""
from reader_test_support import *

PAGE_VALUE = "widget"
BROKEN_PAGE = '<script id="__NEXT_DATA__">{"unrelated": []}</script>'


def make_spec():
    return {
        "type": "embedded_json",
        "source": "__NEXT_DATA__",
        "rows": "items",
        "paths": {"name": "name", "count": "count"},
        "required": ["name", "count"],
        "name": "audit",
        "url_template": "https://public.example/item/{id}",
        "params": {"id": "one"},
        "want": "item name and count",
        "example": None,
    }


def make_page(name=PAGE_VALUE, count=3):
    return ('<script id="__NEXT_DATA__">'
            + json.dumps({"items": [{"name": name, "count": count}]})
            + "</script>")


def last_record():
    path = reader.run_log_path("audit")
    lines = path.read_text(encoding="utf-8").splitlines()
    assert lines, "run must append an audit record"
    record = json.loads(lines[-1])
    # The record must never carry page content.
    assert "html" not in record and "body" not in record and "rows" not in record
    return record


def install_heal_stub(monkeypatch, tmp_path):
    # Prints a corrected embedded_json spec pointing at the live data shape.
    command = tmp_path / "heal_stub.py"
    command.write_text('''import json
schema = {
    "type": "embedded_json",
    "source": "__NEXT_DATA__",
    "rows": "items",
    "paths": {"name": "name", "count": "count"},
    "required": ["name", "count"],
}
print(json.dumps(schema))
''')
    monkeypatch.setenv("READER_COMPILE_CMD", shlex.join([sys.executable, str(command)]))


def test_run_record_normal_urllib_and_crwl(monkeypatch, capsys):
    reader.save(make_spec())
    assert not reader.override_path("audit").exists()
    for method in ("urllib", "crwl"):
        monkeypatch.setattr(reader, "fetch", lambda url, **kwargs: (make_page(), method))
        assert reader.main(["run", "audit", "--param", "id=two"]) == 0
        capsys.readouterr()
        record = last_record()
        assert record["status"] == "ok"
        assert record["exit_code"] == 0
        assert record["url"] == "https://public.example/item/two"
        assert record["fetch_method"] == method
        assert record["healed"] is False
        assert record["heal_attempted"] is False
        assert record["spec_source"] == "original"
        assert record["spec_path"] == str(reader.spec_path("audit"))
        assert record["row_count"] == 1
        assert record["failure_stage"] is None
        assert record["missing_fields"] == []
        assert record["error"] is None
        assert record["record_version"] == 1
        assert record["started_at"] and record["finished_at"]
    # One record per run; run state lives in a different file and stays intact.
    assert len(reader.run_log_path("audit").read_text().splitlines()) == 2
    assert reader.state_path("audit").exists()
    assert json.loads(reader.state_path("audit").read_text())["page_hash"] == reader.page_hash(make_page())


def test_run_record_no_heal_failure(monkeypatch):
    reader.save(make_spec())
    monkeypatch.setattr(reader, "fetch", lambda url, **kwargs: (BROKEN_PAGE, "urllib"))
    with checks.raises(reader.ReaderError) as exc:
        reader.run_spec(reader.load("audit"), {}, True)
    assert exc.value.code == 12
    record = last_record()
    assert record["status"] == "failed"
    assert record["exit_code"] == 12
    assert record["failure_stage"] == "extract"
    assert record["fetch_method"] == "urllib"
    assert record["url"] == "https://public.example/item/one"
    assert record["heal_attempted"] is False
    assert record["healed"] is False
    assert record["spec_source"] == "original"
    assert record["row_count"] is None
    missing = record["missing_fields"]
    assert "list rows >= 1" in missing
    assert "name" in missing and "count" in missing
    assert record["error"].startswith("extraction failed; missing fields:")


def test_run_record_failure_after_heal(monkeypatch, tmp_path):
    spec = make_spec()
    spec["paths"]["name"] = "missing.name"
    reader.save(spec)
    # The heal command still cannot produce the required fields from this page.
    monkeypatch.setenv("READER_COMPILE_CMD", shlex.join([sys.executable, str(DATA / "compile_stub.py")]))
    monkeypatch.setenv("STUB_MODE", "broken")
    monkeypatch.setattr(reader, "fetch", lambda url, **kwargs: (make_page(), "urllib"))
    before = reader.spec_path("audit").read_bytes()
    with checks.raises(reader.ReaderError) as exc:
        reader.run_spec(reader.load("audit"), {}, False)
    assert exc.value.code == 12
    record = last_record()
    assert record["status"] == "failed"
    assert record["exit_code"] == 12
    assert record["failure_stage"] == "heal"
    assert record["heal_attempted"] is True
    assert record["healed"] is False
    assert record["fetch_method"] == "urllib"
    assert record["missing_fields"], "record must name the fields still missing after healing"
    assert any("name" in field for field in record["missing_fields"])
    assert record["error"].startswith("extraction failed after one heal; missing fields:")
    # A failed heal leaves the shipped spec and records no successful rows.
    assert reader.spec_path("audit").read_bytes() == before
    assert not reader.override_path("audit").exists()
    assert record["row_count"] is None


def test_run_record_successful_heal_switches_spec_source(monkeypatch, tmp_path):
    spec = make_spec()
    spec["paths"]["name"] = "missing.name"
    reader.save(spec)
    install_heal_stub(monkeypatch, tmp_path)
    monkeypatch.setattr(reader, "fetch", lambda url, **kwargs: (make_page(), "crwl"))
    result = reader.run_spec(reader.load("audit"), {}, False)
    assert result["rows"] == [{"name": PAGE_VALUE, "count": 3}]
    record = last_record()
    assert record["status"] == "ok" and record["exit_code"] == 0
    assert record["heal_attempted"] is True and record["healed"] is True
    assert record["fetch_method"] == "crwl"
    assert record["spec_source"] == "runtime_override"
    assert record["spec_path"] == str(reader.override_path("audit"))
    assert record["row_count"] == 1
    # The next run uses the healed override without compiling and logs that source.
    before = len(reader.run_log_path("audit").read_text().splitlines())
    result = reader.run_spec(reader.load("audit"), {}, False)
    assert result["rows"][0]["name"] == PAGE_VALUE
    record = last_record()
    assert record["spec_source"] == "runtime_override"
    assert record["healed"] is False and record["heal_attempted"] is False
    assert len(reader.run_log_path("audit").read_text().splitlines()) == before + 1


@checks.mark.parametrize("code,reason", [
    (2, "refused target: resolves to a non-public address"),
    (10, "fetch failed: DNS lookup: name not known"),
])
def test_run_record_fetch_refused_and_failed(monkeypatch, code, reason):
    reader.save(make_spec())
    monkeypatch.setattr(reader, "fetch", mock.Mock(side_effect=reader.ReaderError(code, reason)))
    with checks.raises(reader.ReaderError) as exc:
        reader.run_spec(reader.load("audit"), {}, False)
    assert exc.value.code == code
    record = last_record()
    assert record["status"] == "failed"
    assert record["exit_code"] == code
    assert record["failure_stage"] == "fetch"
    assert record["error"] == reason
    assert record["fetch_method"] is None
    assert record["row_count"] is None
    assert record["heal_attempted"] is False
    assert record["missing_fields"] == []
    assert record["url"] == "https://public.example/item/one"
    # The two fetch failure modes remain distinguishable in the record.
    other_code = 10 if code == 2 else 2
    assert record["exit_code"] != other_code


def test_run_record_fetch_and_extract_failures_are_distinct(monkeypatch):
    reader.save(make_spec())
    monkeypatch.setattr(reader, "fetch", mock.Mock(side_effect=reader.ReaderError(10, "fetch failed: offline")))
    assert reader.main(["run", "audit"]) == 10
    fetch_record = last_record()
    assert fetch_record["failure_stage"] == "fetch" and fetch_record["exit_code"] == 10
    monkeypatch.setattr(reader, "fetch", lambda url, **kwargs: (BROKEN_PAGE, "urllib"))
    assert reader.main(["run", "audit", "--no-heal"]) == 12
    extract_record = last_record()
    assert extract_record["failure_stage"] == "extract" and extract_record["exit_code"] == 12
    assert extract_record["missing_fields"] and fetch_record["missing_fields"] == []


def test_run_record_marks_local_state_write_failure(monkeypatch):
    reader.save(make_spec())
    monkeypatch.setattr(reader, "fetch", lambda url, **kwargs: (make_page(), "urllib"))
    monkeypatch.setattr(reader, "save_json", mock.Mock(side_effect=OSError("disk full")))
    with checks.raises(OSError):
        reader.run_spec(reader.load("audit"), {}, False)
    record = last_record()
    # Extraction succeeded but its state could not persist; the record must not claim success.
    assert record["status"] == "failed"
    assert record["exit_code"] == 2
    assert record["failure_stage"] == "local"
    assert "disk full" in record["error"]
    assert record["fetch_method"] == "urllib"


def load_tests(loader, suite, pattern):
    return checks.suite(globals())
