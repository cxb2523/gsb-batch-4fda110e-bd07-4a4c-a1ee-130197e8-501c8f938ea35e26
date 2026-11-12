#!/usr/bin/env python3
"""Local acceptance test for the fault-tolerant session collection in app.wsgi.

Runs with the standard library only, no Apache or mod_wsgi required:

    python -I tests/test_collection.py

It builds a throwaway sample directory containing all four required cases:

  1. a normal .jsonl session file,
  2. a .jsonl file with corrupt JSON lines mixed among valid ones,
  3. an unreadable .jsonl file (ACL/chmod when the user permits it, an
     exclusively held lock as the portable fallback),
  4. a corrupt metadata.json (sessions must still come back with meta_error).

The collection function from app.wsgi is loaded directly and pointed at the
sample directory, then the returned statistics are printed and asserted.
A second, clean sample directory checks that a healthy collection reports
zero problems. Exit code is non-zero if any assertion fails.
"""

import importlib.util
import json
import os
import sys
import tempfile
import types
from importlib.machinery import SourceFileLoader
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
WSGI_PATH = REPO_ROOT / 'app.wsgi'

# Two valid sessions, one file with two bad lines, one file that cannot be
# opened at all. Values are fixed (no randomness) so runs are reproducible.
NORMAL_ID = '11111111-1111-1111-1111-111111111111'
BAD_LINES_ID = '22222222-2222-2222-2222-222222222222'
UNREADABLE_ID = '33333333-3333-3333-3333-333333333333'
PROJECT_FOLDER = 'sample-project'


def load_app_wsgi():
    """Import app.wsgi as a module without a WSGI server.

    app.wsgi imports `pwd`, which only exists on Unix; inject a stub so the
    module also loads on Windows for local testing. Nothing under test calls
    pwd directly (it is only used inside _resolve_home, which we bypass by
    reassigning the module globals below)."""
    if 'pwd' not in sys.modules:
        sys.modules['pwd'] = types.SimpleNamespace(
            getpwuid=lambda uid: types.SimpleNamespace(pw_dir=tempfile.gettempdir()))
    # The .wsgi suffix has no registered loader, so build the spec from an
    # explicit source loader rather than spec_from_file_location alone.
    loader = SourceFileLoader('app_wsgi_under_test', str(WSGI_PATH))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


def write_jsonl(path, lines):
    path.write_text('\n'.join(lines) + '\n', encoding='utf-8')


def make_unreadable(path):
    """Make `path` unreadable to the current process.

    Returns a cleanup callable that restores read access. Tries real
    permission/ACL changes first and self-checks them; falls back to holding
    the file under an exclusive lock on platforms where the current user can
    still read a "chmod 000" file (e.g. root on Unix). Raises if no mechanism
    can produce an actual read failure, so the test never silently passes."""
    if os.name == 'nt':
        # Deny read (R) for the current user via the ACL. /reset restores the
        # inherited permissions afterwards; denial does not block deletion.
        import subprocess
        user = os.environ.get('USERNAME')
        if not user:
            try:
                user = os.getlogin()
            except OSError:
                user = None
        if user:
            result = subprocess.run(
                ['icacls', str(path), '/deny', f'{user}:(R)'],
                capture_output=True, text=True)
            if result.returncode == 0 and not _is_readable(path):
                def cleanup():
                    subprocess.run(['icacls', str(path), '/reset'],
                                   capture_output=True, text=True)
                return cleanup
        # Fallback: lock the first byte without read sharing. A second opener
        # gets PermissionError, which is exactly the fault the app must survive.
        import msvcrt
        handle = open(path, 'r')
        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)

        def cleanup(handle=handle):
            handle.close()

        return cleanup

    # POSIX: drop all permission bits.
    os.chmod(path, 0o000)
    if not _is_readable(path):
        def cleanup(path=path):
            os.chmod(path, 0o644)

        return cleanup

    # Running as root (or similar): chmod cannot deny the owner. There is no
    # portable mandatory lock on POSIX, so surface the limitation explicitly
    # instead of pretending the unreadable case was exercised.
    raise RuntimeError(
        'cannot make a file unreadable for this user (likely root); '
        'the unreadable-file case cannot be exercised on this system')


def _is_readable(path):
    try:
        with open(path, 'rb') as f:
            f.read(1)
        return True
    except OSError:
        return False


def build_fixture(base_dir):
    """Create the four-case sample tree. Returns (projects_dir, cleanup)."""
    projects = base_dir / 'projects'
    project_dir = projects / PROJECT_FOLDER
    project_dir.mkdir(parents=True)

    # Case 1: a perfectly healthy session file.
    write_jsonl(project_dir / f'{NORMAL_ID}.jsonl', [
        json.dumps({
            'type': 'user',
            'cwd': '/home/me/normal-project',
            'gitBranch': 'main',
            'version': '1.5.0',
            'message': {'role': 'user', 'content': 'A normal, healthy session'},
        }),
        json.dumps({
            'type': 'assistant',
            'message': {'usage': {'input_tokens': 1200,
                                  'cache_read_input_tokens': 300,
                                  'cache_creation_input_tokens': 0}},
        }),
    ])

    # Case 2: two corrupt lines interleaved with valid ones. The valid lines
    # must still parse, so the session appears despite the bad data.
    write_jsonl(project_dir / f'{BAD_LINES_ID}.jsonl', [
        json.dumps({
            'type': 'user',
            'cwd': '/home/me/bad-lines-project',
            'gitBranch': 'dev',
            'message': {'role': 'user', 'content': 'Session with some corrupt lines'},
        }),
        'this is not json at all',
        '{"type": "user", "broken": ',          # truncated JSON
        json.dumps({'type': 'assistant', 'message': {'content': 'recovered'}}),
    ])

    # Case 3: a file the process cannot open.
    unreadable = project_dir / f'{UNREADABLE_ID}.jsonl'
    write_jsonl(unreadable, [json.dumps({'type': 'user', 'cwd': '/home/me/locked'})])
    restore_unreadable = make_unreadable(unreadable)

    # Case 4: corrupt metadata.json. Sessions must still be returned and the
    # caller must receive a non-empty meta_error string.
    data_dir = base_dir / 'data'
    data_dir.mkdir()
    (data_dir / 'metadata.json').write_text('{not valid json', encoding='utf-8')

    def cleanup():
        restore_unreadable()

    return projects, data_dir, cleanup


def run_case(app, base_dir, label, expect):
    projects, data_dir, cleanup = build_fixture(base_dir)
    try:
        # Point the loaded app.wsgi globals at the sample tree. Reassigning the
        # module globals is what keeps this independent of Apache SetEnv and
        # of the real user home directory.
        app.PROJECTS_DIR = projects
        app.META_FILE = data_dir / 'metadata.json'
        app.CACHE_FILE = base_dir / 'cache' / 'sessions.json'
        app.SETTINGS_FILE = data_dir / 'settings.json'

        sessions, meta_error, stats = app.list_sessions()

        print(f'--- {label} ---')
        print(f'sessions returned   : {len(sessions)}')
        print(f'stats               : {json.dumps(stats, ensure_ascii=False, indent=2)}')
        print(f'meta_error          : {meta_error!r}')

        # Shared shape checks.
        for key in ('sessions_parsed', 'bad_lines_skipped',
                    'unreadable_files', 'unreadable_file_details'):
            assert key in stats, f'missing stats key: {key}'

        # Case 4: corrupt metadata never blocks the listing.
        assert sessions, 'sessions must still be returned with corrupt metadata.json'
        assert meta_error and isinstance(meta_error, str) and meta_error, \
            'meta_error must be a non-empty string when metadata.json is corrupt'
        assert 'metadata.json' in meta_error, \
            f'meta_error should mention metadata.json, got: {meta_error!r}'

        # Cases 1 and 2: the readable sessions survive, including the one with
        # bad lines, and the unreadable file is absent from the listing.
        returned_ids = {s['id'] for s in sessions}
        assert NORMAL_ID in returned_ids, 'healthy session missing from results'
        assert BAD_LINES_ID in returned_ids, \
            'session containing bad lines must still be parsed and returned'
        assert UNREADABLE_ID not in returned_ids, \
            'unreadable session file must be skipped, not listed'

        bad_line_session = next(s for s in sessions if s['id'] == BAD_LINES_ID)
        assert bad_line_session['cwd'] == '/home/me/bad-lines-project', \
            'valid lines around the corrupt ones must still be parsed'

        assert stats['sessions_parsed'] == expect['sessions_parsed'], stats
        assert stats['bad_lines_skipped'] == expect['bad_lines_skipped'], stats
        assert stats['unreadable_files'] == expect['unreadable_files'], stats
        assert len(stats['unreadable_file_details']) == expect['unreadable_files'], stats
        detail = stats['unreadable_file_details'][0]
        assert detail['file'].endswith(f'{UNREADABLE_ID}.jsonl'), detail
        assert detail['reason'], 'the failure reason must be recorded'

        # The cache persists the bad-line count, so a second collection reports
        # the same statistics without rescanning anything.
        sessions2, meta_error2, stats2 = app.list_sessions()
        assert len(sessions2) == len(sessions)
        assert stats2['bad_lines_skipped'] == stats['bad_lines_skipped'], stats2
        assert stats2['unreadable_files'] == stats['unreadable_files'], stats2
        assert stats2['sessions_parsed'] == stats['sessions_parsed'], stats2
        assert meta_error2 == meta_error
        print('second (cached) run: statistics stable')
    finally:
        cleanup()


def run_clean_case(app, base_dir):
    """A healthy tree must report zero problems and no meta_error."""
    projects = base_dir / 'projects'
    project_dir = projects / 'clean-project'
    project_dir.mkdir(parents=True)
    data_dir = base_dir / 'data'
    data_dir.mkdir(parents=True)

    write_jsonl(project_dir / f'{NORMAL_ID}.jsonl', [
        json.dumps({'type': 'user', 'cwd': '/home/me/clean',
                    'message': {'role': 'user', 'content': 'all good'}}),
    ])
    (data_dir / 'metadata.json').write_text(
        json.dumps({NORMAL_ID: {'name': 'Clean one'}}), encoding='utf-8')

    app.PROJECTS_DIR = projects
    app.META_FILE = data_dir / 'metadata.json'
    app.CACHE_FILE = base_dir / 'cache' / 'sessions.json'
    app.SETTINGS_FILE = data_dir / 'settings.json'

    sessions, meta_error, stats = app.list_sessions()
    print('--- clean sample ---')
    print(f'stats               : {json.dumps(stats, ensure_ascii=False)}')
    assert meta_error is None, f'healthy metadata must not set meta_error: {meta_error!r}'
    assert len(sessions) == 1
    assert sessions[0]['name'] == 'Clean one', 'readable metadata must still apply'
    assert stats['sessions_parsed'] == 1, stats
    assert stats['bad_lines_skipped'] == 0, stats
    assert stats['unreadable_files'] == 0, stats
    assert stats['unreadable_file_details'] == [], stats


def run_unenumerable_case(app, base_dir):
    """PROJECTS_DIR pointing at a file must degrade, never raise."""
    base_dir.mkdir(parents=True)
    not_a_dir = base_dir / 'projects'
    not_a_dir.write_text('I am a file, not a directory', encoding='utf-8')
    data_dir = base_dir / 'data'
    data_dir.mkdir(parents=True)

    app.PROJECTS_DIR = not_a_dir
    app.META_FILE = data_dir / 'metadata.json'
    app.CACHE_FILE = base_dir / 'cache' / 's.json'
    app.SETTINGS_FILE = data_dir / 'settings.json'

    sessions, meta_error, stats = app.list_sessions()
    print('--- unenumerable projects path ---')
    print(f'stats               : {json.dumps(stats, ensure_ascii=False)}')
    assert sessions == []
    assert meta_error is None
    assert stats['unreadable_files'] == 1, stats
    assert stats['unreadable_file_details'][0]['file'] == str(not_a_dir), stats
    assert stats['bad_lines_skipped'] == 0
    print('degraded without raising')


def main():
    app = load_app_wsgi()
    with tempfile.TemporaryDirectory(prefix='cs-collection-test-') as tmp:
        tmp = Path(tmp)
        # Separate trees so the clean case cannot be influenced by the first.
        run_case(
            app, tmp / 'dirty', 'dirty sample (all four required cases)',
            expect={
                'sessions_parsed': 2,   # normal + bad-lines file
                'bad_lines_skipped': 2,
                'unreadable_files': 1,
            },
        )
        run_clean_case(app, tmp / 'clean')
        run_unenumerable_case(app, tmp / 'unenumerable')

    print('\nAll assertions passed: collection is fault-tolerant and the '
          'statistics are correct.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
