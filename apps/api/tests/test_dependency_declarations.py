from __future__ import annotations

from pathlib import Path


def _declared_packages() -> set[str]:
    requirements = Path(__file__).resolve().parents[1] / "requirements.txt"
    names: set[str] = set()
    for raw_line in requirements.read_text(encoding="utf-8").splitlines():
        line = raw_line.split("#", 1)[0].strip()
        if not line or line.startswith("-"):
            continue
        name = (
            line.split("==", 1)[0]
            .split(">=", 1)[0]
            .split("<", 1)[0]
            .split("[", 1)[0]
            .strip()
            .lower()
        )
        if name:
            names.add(name)
    return names


def test_runtime_import_dependencies_are_declared() -> None:
    declared = _declared_packages()

    # These import names are used directly by API/runtime modules during pytest
    # collection. Keep them declared here so clean checkouts fail with a clear
    # assertion instead of ModuleNotFoundError during collection.
    required_import_packages = {
        "croniter": "croniter",
        "agents": "openai-agents",
        "bcrypt": "bcrypt",
        "ddgs": "ddgs",
        "litellm": "litellm",
    }

    missing = {
        import_name: package_name
        for import_name, package_name in required_import_packages.items()
        if package_name not in declared
    }

    assert missing == {}
