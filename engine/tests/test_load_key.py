"""Tests for render_track.load_key — how the engine finds the ElevenLabs key.

Small, but this is the first thing a manual run hits and the last thing anyone
wants to debug at the start of a three-hour render. The failure it guards
against is not "the key is missing" — that is fine and expected — it is being
told so in a way that names the fix.
"""
import os
import sys

import pytest

ENGINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ENGINE)

import render_track  # noqa: E402


@pytest.fixture(autouse=True)
def no_cached_key(monkeypatch):
    # load_key memoises into a module global, so one test resolving a key would
    # otherwise satisfy every test after it.
    monkeypatch.setattr(render_track, "KEY", None)
    monkeypatch.delenv("ELEVENLABS_API_KEY", raising=False)


def test_the_environment_wins(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("ELEVENLABS_API_KEY", "from-env")
    assert render_track.load_key() == "from-env"


def test_env_local_is_the_fallback(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    # "example-" prefix on purpose: this line is a real `ELEVENLABS_API_KEY=`
    # assignment in a tracked file, which the secret scanner in
    # test/server.env.test.js flags wherever it appears outside test/. The
    # prefix is the placeholder form that scanner recognises. Renaming it back
    # to something tidier breaks `npm test`.
    (tmp_path / ".env.local").write_text(
        'ELEVENLABS_API_KEY="example-from-file"\n', encoding="utf-8")
    assert render_track.load_key() == "example-from-file"


def test_a_missing_env_local_says_which_variable_to_set(monkeypatch, tmp_path):
    # The regression. An unguarded open() raised FileNotFoundError before the
    # assert could speak, so a manual run on the box reported a missing
    # '.env.local' — a file that has never existed there — rather than naming
    # ELEVENLABS_API_KEY or where the key actually lives.
    monkeypatch.chdir(tmp_path)
    with pytest.raises(AssertionError) as e:
        render_track.load_key()
    assert "ELEVENLABS_API_KEY" in str(e.value)
    assert "api.env" in str(e.value)


def test_the_message_names_the_directory_it_looked_in(monkeypatch, tmp_path):
    # Which directory matters: the lookup is relative to the CWD, so the same
    # command works from engine/ and fails one level up.
    monkeypatch.chdir(tmp_path)
    with pytest.raises(AssertionError) as e:
        render_track.load_key()
    assert str(tmp_path) in str(e.value)


def test_an_env_local_without_the_key_is_not_a_key(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    (tmp_path / ".env.local").write_text("SOMETHING_ELSE=1\n", encoding="utf-8")
    with pytest.raises(AssertionError):
        render_track.load_key()
