"""Pure-script workers must be able to resolve mounted contexts via env.

A pure-script worker (`command = "python run.py"`, run with cwd=workdir) that
writes a file into a WRITEABLE context volume did not persist, because the
sandbox never exposed the mount path to the script: the command env carried no
`CONTEXT_<NAME>` variable, so a script could only find the writeable dir via the
undocumented relative `context/<name>` path. The persist routine already tars
the correct absolute path (`{workdir}/context/{name}`); the gap was purely that
the script had no reliable way to write there.

This injects one `CONTEXT_<NAME>` env var per mounted context pointing at that
absolute mount path, so `os.environ["CONTEXT_MY_STATE"]` returns the writeable
dir. These vars are NOT in the internal-env scrub list, so they reach the worker.

Run: cd apps/api && python -m pytest tests/test_context_env_injection.py -q
"""
from __future__ import annotations

import sys
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

from runner_sandbox.e2b_driver import (
    _E2B_INTERNAL_ENV_VARS,
    _context_env_map,
    _context_env_var_name,
    _scrub_internal_env_command,
)

WORKDIR = "/home/user/worker"


class TestContextEnvVarName:
    def test_simple_name(self):
        assert _context_env_var_name("my-state") == "CONTEXT_MY_STATE"

    def test_underscores_and_dots(self):
        assert _context_env_var_name("phd-search-state") == "CONTEXT_PHD_SEARCH_STATE"
        assert _context_env_var_name("search.state.v2") == "CONTEXT_SEARCH_STATE_V2"

    def test_leading_trailing_and_repeated_separators(self):
        assert _context_env_var_name("--foo__bar--") == "CONTEXT_FOO_BAR"

    def test_already_upper_alnum(self):
        assert _context_env_var_name("state1") == "CONTEXT_STATE1"


class TestContextEnvMap:
    def test_single_context_absolute_mount_path(self):
        env = _context_env_map({"my-state"}, WORKDIR)
        assert env == {"CONTEXT_MY_STATE": "/home/user/worker/context/my-state"}

    def test_multiple_contexts_readable_and_writeable(self):
        env = _context_env_map({"my-state", "shared-facts"}, WORKDIR)
        assert env == {
            "CONTEXT_MY_STATE": "/home/user/worker/context/my-state",
            "CONTEXT_SHARED_FACTS": "/home/user/worker/context/shared-facts",
        }

    def test_empty_when_no_contexts(self):
        assert _context_env_map(set(), WORKDIR) == {}

    def test_path_uses_provided_workdir_not_hardcoded(self):
        env = _context_env_map({"my-state"}, "/tmp/alt-workdir")
        assert env["CONTEXT_MY_STATE"] == "/tmp/alt-workdir/context/my-state"

    def test_injected_vars_survive_internal_env_scrub(self):
        # The scrub only unsets a fixed infra allowlist; CONTEXT_* must reach
        # the worker. Assert none of the injected names are unset by the scrub.
        env = _context_env_map({"my-state"}, WORKDIR)
        scrubbed = _scrub_internal_env_command("python run.py", "some-worker")
        for name in env:
            assert f"-u {name}" not in scrubbed
        # sanity: the scrub really does unset the infra vars it targets.
        for var in _E2B_INTERNAL_ENV_VARS:
            assert f"-u {var}" in scrubbed
