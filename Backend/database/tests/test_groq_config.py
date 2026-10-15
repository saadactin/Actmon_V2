"""groq_params(): one model setting for every AI feature, sized for reasoning models."""
from app.services.common import groq_config


def test_default_model_when_unset(monkeypatch):
    monkeypatch.delenv("GROQ_MODEL", raising=False)
    assert groq_config.groq_model() == groq_config.DEFAULT_GROQ_MODEL


def test_blank_setting_falls_back_to_default(monkeypatch):
    monkeypatch.setenv("GROQ_MODEL", "   ")
    assert groq_config.groq_model() == groq_config.DEFAULT_GROQ_MODEL


def test_gpt_oss_gets_reasoning_headroom_and_effort(monkeypatch):
    monkeypatch.setenv("GROQ_MODEL", "openai/gpt-oss-120b")
    p = groq_config.groq_params(800)
    # 800 alone came back empty: the model's thinking is billed to the same budget.
    assert p == {"model": "openai/gpt-oss-120b", "max_tokens": 800 + 1500, "reasoning_effort": "low"}
    assert groq_config.groq_params(2000, reasoning="medium")["max_tokens"] == 6000


def test_qwen3_gets_headroom_but_no_reasoning_effort(monkeypatch):
    monkeypatch.setenv("GROQ_MODEL", "qwen/qwen3.8-27b")
    p = groq_config.groq_params(1000)
    assert p["max_tokens"] > 1000
    assert "reasoning_effort" not in p  # gpt-oss style values are rejected by qwen


def test_plain_model_is_passed_through_untouched(monkeypatch):
    monkeypatch.setenv("GROQ_MODEL", "some-future-chat-model")
    assert groq_config.groq_params(1500) == {"model": "some-future-chat-model", "max_tokens": 1500}
