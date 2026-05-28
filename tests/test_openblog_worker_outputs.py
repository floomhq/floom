import importlib.util
from pathlib import Path


def _openblog_run_module():
    path = Path(__file__).resolve().parents[1] / "workers" / "openblog" / "run.py"
    spec = importlib.util.spec_from_file_location("openblog_worker_run", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_openblog_skips_empty_image_archive(tmp_path):
    module = _openblog_run_module()
    image_dir = tmp_path / "images"
    image_dir.mkdir()
    archive_path = tmp_path / "openblog_images.zip"

    created = module._zip_nonempty_directory(image_dir, archive_path)

    assert created is False
    assert not archive_path.exists()


def test_openblog_zips_nonempty_image_archive(tmp_path):
    module = _openblog_run_module()
    image_dir = tmp_path / "images"
    image_dir.mkdir()
    (image_dir / "image.png").write_bytes(b"real image bytes")
    archive_path = tmp_path / "openblog_images.zip"

    created = module._zip_nonempty_directory(image_dir, archive_path)

    assert created is True
    assert archive_path.stat().st_size >= 100
