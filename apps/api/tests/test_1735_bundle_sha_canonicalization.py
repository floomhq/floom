"""#1735 — bundle SHA canonicalization is collision-safe (length-prefixed).

`_bundle_sha256_from_manifest_files` length-prefixes each path and content byte
string before hashing (matching the #1733 context-digest pattern), so distinct
(path, content) splits that would collide under naive concatenation produce
distinct digests. These tests pin that contract + the surrounding guarantees the
issue lists: content-sensitivity, order-independence, and that
`_attach_bundle_sha256` overwrites a stale/forged manifest value.
"""

from __future__ import annotations

from db.sqlite import _attach_bundle_sha256, _bundle_sha256_from_manifest_files


def _manifest(files: dict[str, str]) -> dict:
    return {"_files": files}


def test_sha_changes_when_content_changes():
    a = _bundle_sha256_from_manifest_files(_manifest({"run.py": "print(1)\n"}))
    b = _bundle_sha256_from_manifest_files(_manifest({"run.py": "print(2)\n"}))
    assert a and b and a != b


def test_sha_is_deterministic_regardless_of_dict_order():
    files1 = {"a.py": "A", "b.py": "B", "c.py": "C"}
    files2 = {"c.py": "C", "a.py": "A", "b.py": "B"}
    assert (
        _bundle_sha256_from_manifest_files(_manifest(files1))
        == _bundle_sha256_from_manifest_files(_manifest(files2))
    )


def test_boundary_ambiguity_does_not_collide():
    # Under naive path+content concatenation both flatten to "run.pyX...":
    #   {"run.py": "ab", "x": "c"}  -> "run.pyab" + "xc"
    #   {"run.py": "a",  "x": "bc"} (mutating the split) -> would collide naively.
    # The classic collision pair: differ only in where the path/content boundary
    # falls for the SAME concatenated bytes.
    a = _bundle_sha256_from_manifest_files(_manifest({"ab": "c"}))
    b = _bundle_sha256_from_manifest_files(_manifest({"a": "bc"}))
    assert a and b and a != b

    # And across two files where the seam between them shifts.
    c = _bundle_sha256_from_manifest_files(_manifest({"x": "y", "xy": "z"}))
    d = _bundle_sha256_from_manifest_files(_manifest({"x": "yxy", "_pad": "z"}))
    assert c and d and c != d


def test_attach_overwrites_stale_or_forged_bundle_sha():
    manifest = {
        "_files": {"run.py": "print(1)\n"},
        "runtime": {"bundle_sha256": "deadbeef" * 8, "runner": "e2b"},
    }
    out = _attach_bundle_sha256(manifest)
    real = _bundle_sha256_from_manifest_files(manifest)
    assert real
    assert out["runtime"]["bundle_sha256"] == real
    assert out["runtime"]["bundle_sha256"] != "deadbeef" * 8
    # unrelated runtime fields preserved
    assert out["runtime"]["runner"] == "e2b"


def test_no_files_returns_none():
    assert _bundle_sha256_from_manifest_files({"_files": {}}) is None
    assert _bundle_sha256_from_manifest_files({}) is None
