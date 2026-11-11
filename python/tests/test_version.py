"""The version in the code must match the version being packaged.

`__version__` is what a user prints to tell you which client they are running,
and it lives in a different file from the one that decides what gets uploaded.
The publishing runbook used to say, in as many words, that nothing would catch a
mismatch for you. Now something does.

A drift here is quiet in the worst way: the wheel is correct, PyPI is correct,
and only the bug report you receive is wrong.
"""

from __future__ import annotations

import re
from pathlib import Path

import whatsarab

PYPROJECT = Path(__file__).resolve().parent.parent / "pyproject.toml"


def _declared_version() -> str:
    """Read [project].version without depending on a TOML parser.

    tomllib is 3.11+, and this package supports 3.9 — pulling in tomli just for
    one line would make a test add a dependency the library itself does not have.
    """
    text = PYPROJECT.read_text(encoding="utf-8")
    # Say what is wrong rather than dying on an index. A test that fails with a
    # bare IndexError sends whoever is mid-release reading THIS file instead of
    # the manifest that actually moved.
    assert "[project]" in text, f"no [project] section in {PYPROJECT}"
    project = text.split("[project]", 1)[1].split("\n[", 1)[0]
    match = re.search(r'^version\s*=\s*"([^"]+)"', project, re.MULTILINE)
    assert match, f'no version = "..." under [project] in {PYPROJECT}'
    return match.group(1)


def test_dunder_version_matches_pyproject() -> None:
    assert whatsarab.__version__ == _declared_version()


def test_version_is_a_release_number() -> None:
    # Catches the other half of the mistake: editing one file to something that
    # is not a version at all ("0.1.1-dev", an empty string, a stray quote).
    assert re.fullmatch(r"\d+\.\d+\.\d+", whatsarab.__version__), whatsarab.__version__
