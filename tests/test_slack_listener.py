import importlib.util
from pathlib import Path


def _load_slack_listener(monkeypatch):
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-test")
    monkeypatch.setenv("WORKEROS_API_SECRET", "test-secret")
    path = Path(__file__).resolve().parents[1] / "workers" / "slack-listener" / "run.py"
    spec = importlib.util.spec_from_file_location("slack_listener_worker", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_slack_app_mention_is_detected_and_cleaned(monkeypatch):
    listener = _load_slack_listener(monkeypatch)

    assert listener.is_addressed_to_bot("<@U123> list failed runs", "U123") is True
    assert listener.clean_user_question("<@U123> list failed runs", "U123") == "list failed runs"
    assert listener.is_addressed_to_bot("plain channel chatter", "U123") is False


def test_process_messages_forwards_app_mention_to_workspace_and_thread(monkeypatch):
    listener = _load_slack_listener(monkeypatch)
    workspace_calls = []
    posts = []

    monkeypatch.setattr(listener, "thread_has_bot_reply", lambda channel, ts, bot_user_id: False)
    monkeypatch.setattr(
        listener,
        "workspace_chat",
        lambda message, conversation_id=None: workspace_calls.append((message, conversation_id)) or {"reply": "done"},
    )
    monkeypatch.setattr(
        listener,
        "slack_post",
        lambda channel, thread_ts, text: posts.append((channel, thread_ts, text)),
    )

    processed = listener.process_messages(
        [
            {"text": "<@U999> summarize incidents", "ts": "1710000000.000001", "user": "U111"},
            {"text": "not for the bot", "ts": "1710000001.000001", "user": "U111"},
        ],
        "C123",
        "U999",
    )

    assert workspace_calls == [("summarize incidents", None)]
    assert posts == [("C123", "1710000000.000001", "done")]
    assert processed == [
        {"ts": "1710000000.000001", "question": "summarize incidents", "replied": True}
    ]


def test_process_messages_skips_thread_when_bot_already_replied(monkeypatch):
    listener = _load_slack_listener(monkeypatch)
    workspace_calls = []

    monkeypatch.setattr(listener, "thread_has_bot_reply", lambda channel, ts, bot_user_id: True)
    monkeypatch.setattr(
        listener,
        "workspace_chat",
        lambda message, conversation_id=None: workspace_calls.append(message) or {"reply": "done"},
    )

    processed = listener.process_messages(
        [{"text": "<@U999> summarize incidents", "ts": "1710000000.000001", "user": "U111"}],
        "C123",
        "U999",
    )

    assert workspace_calls == []
    assert processed == [
        {
            "ts": "1710000000.000001",
            "question": "<@U999> summarize incidents",
            "replied": False,
            "skipped": "already_replied",
        }
    ]


def test_thread_has_bot_reply_reads_slack_thread(monkeypatch):
    listener = _load_slack_listener(monkeypatch)
    calls = []

    def fake_slack_get(path, params=None):
        calls.append((path, params))
        return {
            "messages": [
                {"ts": "1710000000.000001", "user": "U111"},
                {"ts": "1710000002.000001", "user": "U999", "text": "done"},
            ]
        }

    monkeypatch.setattr(listener, "slack_get", fake_slack_get)

    assert listener.thread_has_bot_reply("C123", "1710000000.000001", "U999") is True
    assert calls == [
        (
            "conversations.replies",
            {"channel": "C123", "ts": "1710000000.000001", "limit": 20},
        )
    ]
