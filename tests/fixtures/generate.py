#!/usr/bin/env python3
"""Generates the synthetic log fixtures in this folder.

Every file here is synthetic. Prompt/response/thinking/tool fields carry
sentinel strings so the privacy test can prove they never leak.

Layout (each set is a directory usable as the tool's data root):
  claude/basic      CLAUDE_CONFIG_DIR   (contains projects/)
  codex/basic       CODEX_HOME          (contains sessions/, archived_sessions/)
  gemini/basic      GEMINI_DATA_DIR     (contains <project>/chats/)

Run:  python3 tests/fixtures/generate.py
"""
import json
import os
import shutil

HERE = os.path.dirname(os.path.abspath(__file__))
SENT_PROMPT = "TOKENSTREAK_SENTINEL_PROMPT_7f3a9c"
SENT_RESPONSE = "TOKENSTREAK_SENTINEL_RESPONSE_b21e44"
SENT_THINKING = "TOKENSTREAK_SENTINEL_THINKING_0d9e1a"
SENT_TOOL = "TOKENSTREAK_SENTINEL_TOOL_55c2f0"


def write_lines(path, lines, trailing_newline=True):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        body = "\n".join(l if isinstance(l, str) else json.dumps(l, separators=(",", ":")) for l in lines)
        f.write(body + ("\n" if trailing_newline else ""))


def reset(d):
    shutil.rmtree(d, ignore_errors=True)
    os.makedirs(d)


# ---------------------------------------------------------------- Claude ---
def claude_user(ts, session, cwd, text):
    return {"parentUuid": None, "isSidechain": False, "userType": "external", "cwd": cwd,
            "sessionId": session, "version": "2.0.14", "gitBranch": "main", "type": "user",
            "message": {"role": "user", "content": text}, "uuid": "u-" + ts, "timestamp": ts}


def claude_asst(ts, session, cwd, model, mid, rid, inp, out, cw=0, cr=0, extra=None, msg_extra=None, usage_extra=None):
    usage = {"input_tokens": inp, "cache_creation_input_tokens": cw, "cache_read_input_tokens": cr,
             "output_tokens": out, "service_tier": "standard"}
    if usage_extra:
        usage.update(usage_extra)
    msg = {"id": mid, "type": "message", "role": "assistant", "model": model,
           "content": [{"type": "thinking", "thinking": SENT_THINKING},
                       {"type": "text", "text": SENT_RESPONSE + " with \"usage\":{ inside text"},
                       {"type": "tool_use", "id": "toolu_" + mid[-6:], "name": "Bash", "input": {"command": SENT_TOOL}}],
           "stop_reason": "end_turn", "usage": usage}
    if msg_extra:
        msg.update(msg_extra)
    line = {"parentUuid": "p", "isSidechain": False, "userType": "external", "cwd": cwd, "sessionId": session,
            "version": "2.0.14", "gitBranch": "main", "message": msg, "type": "assistant",
            "uuid": "a-" + ts + mid, "timestamp": ts}
    if rid is not None:
        line["requestId"] = rid
    if extra:
        line.update(extra)
    return line


def gen_claude():
    root = os.path.join(HERE, "claude", "basic")
    reset(root)
    P = os.path.join(root, "projects")
    S = "claude-sonnet-4-5-20250929"
    O = "claude-opus-4-5-20251101"
    H = "claude-haiku-4-5-20251001"

    cwd_a = "/Users/demo/code/alpha"
    a = os.path.join(P, "-Users-demo-code-alpha")
    sa = "11111111-aaaa-4aaa-8aaa-000000000001"
    write_lines(os.path.join(a, sa + ".jsonl"), [
        {"type": "summary", "summary": SENT_PROMPT, "leafUuid": "x"},
        claude_user("2026-09-25T15:00:00.000Z", sa, cwd_a, SENT_PROMPT),
        claude_asst("2026-09-25T15:00:05.000Z", sa, cwd_a, S, "msg_a1", "req_a1", 12, 340, 5000, 12000),
        # Streaming duplicate: same message + request id on a second line.
        claude_asst("2026-09-25T15:00:05.500Z", sa, cwd_a, S, "msg_a1", "req_a1", 12, 340, 5000, 12000),
        claude_user("2026-09-25T15:01:00.000Z", sa, cwd_a, [{"type": "tool_result", "tool_use_id": "t", "content": SENT_TOOL}]),
        claude_asst("2026-09-25T15:01:10.000Z", sa, cwd_a, O, "msg_a2", "req_a2", 3, 1200, 800, 17000),
        # 1h cache creation breakdown.
        claude_asst("2026-09-25T16:30:00.000Z", sa, cwd_a, S, "msg_a3", "req_a3", 5, 90, 3000, 20000,
                    usage_extra={"cache_creation": {"ephemeral_5m_input_tokens": 1000, "ephemeral_1h_input_tokens": 2000}}),
        # Time-zone boundaries around 2026-09-26 00:00 in several zones.
        claude_asst("2026-09-25T23:59:59.999Z", sa, cwd_a, S, "msg_a4", "req_a4", 7, 70, 700, 7000),
        claude_asst("2026-09-26T00:00:00.000Z", sa, cwd_a, S, "msg_a5", "req_a5", 8, 80, 800, 8000),
        claude_asst("2026-09-26T04:00:00.000Z", sa, cwd_a, H, "msg_a6", "req_a6", 9, 90, 900, 9000),
        claude_asst("2026-09-26T07:00:00.000Z", sa, cwd_a, H, "msg_a7", "req_a7", 10, 100, 1000, 10000),
        claude_asst("2026-09-26T11:29:59.000Z", sa, cwd_a, S, "msg_a8", "req_a8", 11, 110, 1100, 11000),
        claude_asst("2026-09-26T18:30:00.000+05:30", sa, cwd_a, S, "msg_a9", "req_a9", 13, 130, 1300, 13000),
        # Recorded costUSD (auto cost mode uses it).
        claude_asst("2026-09-26T12:00:00.000Z", sa, cwd_a, S, "msg_a10", "req_a10", 100, 1000, 0, 0, extra={"costUSD": 0.5}),
        # Long context (> 200K) exercises tiered pricing.
        claude_asst("2026-09-26T13:00:00.000Z", sa, cwd_a, S, "msg_a11", "req_a11", 250000, 4000, 0, 0),
        # <synthetic> model: tokens count, no model, no cost.
        claude_asst("2026-09-26T13:30:00.000Z", sa, cwd_a, "<synthetic>", "msg_a12", "req_a12", 0, 0, 0, 0),
        # Malformed and rejected lines.
        '{"type":"assistant","message":{"usage":{"input_tokens":5,',
        "this is not json at all",
        "",
        claude_asst("2026-09-26T14:00:00.000Z", sa, cwd_a, S, "msg_bad1", None, 999, 999, extra={"requestId": None}),
        claude_asst("2026-09-26T14:00:01.000Z", sa, cwd_a, S, "msg_bad2", "req_bad2", 999, 999, extra={"version": "banana"}),
        claude_asst("2026-09-26 14:00:02", sa, cwd_a, S, "msg_bad3", "req_bad3", 999, 999),
        claude_asst("2026-09-26T14:00:03.000Z", sa, cwd_a, S, "msg_bad4", "", 999, 999),
        # Usage marker inside user text only: not an entry.
        claude_user("2026-09-26T14:10:00.000Z", sa, cwd_a, 'please parse "usage":{"input_tokens":1}'),
    ])

    # Resumed session copies history (same message + request ids) and adds more.
    sb = "11111111-aaaa-4aaa-8aaa-000000000002"
    write_lines(os.path.join(a, sb + ".jsonl"), [
        claude_asst("2026-09-25T15:00:05.000Z", sb, cwd_a, S, "msg_a1", "req_a1", 12, 340, 5000, 12000),
        claude_asst("2026-09-26T09:00:00.000Z", sb, cwd_a, O, "msg_b1", "req_b1", 20, 2000, 4000, 50000),
        # Gateway style: no request id, same message id reused -> keyed by session+timestamp.
        claude_asst("2026-09-26T09:05:00.000Z", sb, cwd_a, S, "msg_gw", None, 1, 10, 0, 100),
        claude_asst("2026-09-26T09:06:00.000Z", sb, cwd_a, S, "msg_gw", None, 2, 20, 0, 200),
        claude_asst("2026-09-26T09:06:00.000Z", sb, cwd_a, S, "msg_gw", None, 2, 20, 0, 200),
        # Sidechain replay of a parent message with a new request id collapses.
        claude_asst("2026-09-26T09:00:00.000Z", sb, cwd_a, O, "msg_b1", "req_b1_replay", 20, 2000, 4000, 50000,
                    extra={"isSidechain": True}),
        # Fast mode (priced with the model's fast multiplier) on Opus 4.6.
        claude_asst("2026-09-26T10:00:00.000Z", sb, cwd_a, "claude-opus-4-6", "msg_b2", "req_b2", 30, 300, 0, 3000,
                    usage_extra={"speed": "fast"}),
        # Advisor iteration adds a second priced entry.
        claude_asst("2026-09-26T10:30:00.000Z", sb, cwd_a, S, "msg_b3", "req_b3", 40, 400, 0, 4000,
                    usage_extra={"iterations": [
                        {"type": "message", "model": S, "input_tokens": 40, "output_tokens": 400},
                        {"type": "advisor_message", "model": O, "input_tokens": 5, "output_tokens": 50,
                         "cache_read_input_tokens": 500}]}),
    ], trailing_newline=False)

    # Agent progress entry and a subagent transcript.
    cwd_b = "/Users/demo/code/beta"
    b = os.path.join(P, "-Users-demo-code-beta")
    sc = "22222222-bbbb-4bbb-8bbb-000000000003"
    write_lines(os.path.join(b, sc + ".jsonl"), [
        claude_user("2026-09-24T22:00:00.000Z", sc, cwd_b, SENT_PROMPT),
        claude_asst("2026-09-24T22:00:10.000Z", sc, cwd_b, H, "msg_c1", "req_c1", 50, 500, 1500, 8000),
        {"type": "progress", "sessionId": sc, "cwd": cwd_b, "timestamp": "2026-09-24T22:01:00.000Z",
         "data": {"type": "agent_progress", "prompt": SENT_PROMPT,
                  "message": {"timestamp": "2026-09-24T22:01:00.000Z", "requestId": "req_c2",
                              "message": {"id": "msg_c2", "model": S, "role": "assistant",
                                          "content": [{"type": "text", "text": SENT_RESPONSE}],
                                          "usage": {"input_tokens": 6, "output_tokens": 60,
                                                    "cache_creation_input_tokens": 600,
                                                    "cache_read_input_tokens": 6000}}}}},
    ])
    write_lines(os.path.join(b, sc, "subagents", "agent-a1.jsonl"), [
        claude_asst("2026-09-24T22:02:00.000Z", sc, cwd_b, H, "msg_c3", "req_c3", 70, 700, 0, 7000,
                    extra={"isSidechain": True}),
    ])


# ----------------------------------------------------------------- Codex ---
def cx(ts, typ, payload):
    return {"timestamp": ts, "type": typ, "payload": payload}


def token_count(ts, total, last=None, model=None):
    info = {"total_token_usage": total, "model_context_window": 272000}
    if last is not None:
        info["last_token_usage"] = last
    p = {"type": "token_count", "info": info, "rate_limits": {"primary": {"used_percent": 3.0}}}
    if model:
        p["model"] = model
    return cx(ts, "event_msg", p)


def u(inp, cached, out, reasoning=0, total=None):
    return {"input_tokens": inp, "cached_input_tokens": cached, "output_tokens": out,
            "reasoning_output_tokens": reasoning, "total_tokens": inp + out if total is None else total}


def gen_codex():
    root = os.path.join(HERE, "codex", "basic")
    reset(root)
    S = os.path.join(root, "sessions")
    cwd = "/Users/demo/code/alpha"

    parent_id = "0199a000-0000-7000-8000-00000000p001"
    parent = [
        cx("2026-09-25T20:00:00.000Z", "session_meta", {"id": parent_id, "timestamp": "2026-09-25T20:00:00.000Z",
           "cwd": cwd, "originator": "codex_cli_rs", "cli_version": "0.46.0", "instructions": SENT_PROMPT}),
        cx("2026-09-25T20:00:01.000Z", "turn_context", {"cwd": cwd, "model": "gpt-5-codex", "approval_policy": "on-request"}),
        cx("2026-09-25T20:00:02.000Z", "event_msg", {"type": "user_message", "message": SENT_PROMPT}),
        cx("2026-09-25T20:00:03.000Z", "response_item", {"type": "message", "role": "assistant",
           "content": [{"type": "output_text", "text": SENT_RESPONSE}]}),
        cx("2026-09-25T20:00:03.500Z", "response_item", {"type": "reasoning", "summary": [{"type": "summary_text", "text": SENT_THINKING}]}),
        cx("2026-09-25T20:00:03.700Z", "response_item", {"type": "function_call", "name": "shell", "arguments": SENT_TOOL}),
        token_count("2026-09-25T20:00:04.000Z", u(10000, 8000, 500, 200), u(10000, 8000, 500, 200)),
        # Same cumulative total again (no advance): must not double count.
        token_count("2026-09-25T20:00:04.500Z", u(10000, 8000, 500, 200), u(10000, 8000, 500, 200)),
        token_count("2026-09-25T23:59:59.000Z", u(25000, 20000, 1500, 600), u(15000, 12000, 1000, 400)),
        # Only a cumulative total: the delta is used.
        token_count("2026-09-26T00:00:01.000Z", u(40000, 30000, 2500, 900)),
        cx("2026-09-26T05:00:00.000Z", "turn_context", {"cwd": cwd, "model": "gpt-5"}),
        token_count("2026-09-26T05:00:10.000Z", u(60000, 45000, 4000, 1500), u(20000, 15000, 1500, 600)),
        "{not json",
        cx("2026-09-26T06:00:00.000Z", "event_msg", {"type": "agent_message", "message": SENT_RESPONSE}),
    ]
    write_lines(os.path.join(S, "2026/09/25", f"rollout-2026-09-25T20-00-00-{parent_id}.jsonl"), parent)

    # Forked session: replays the parent's usage (rewritten timestamps are fine),
    # then records its own.
    child_id = "0199a000-0000-7000-8000-00000000c001"
    child = [
        cx("2026-09-26T05:30:00.000Z", "session_meta", {"id": child_id, "forked_from_id": parent_id,
           "timestamp": "2026-09-26T05:30:00.000Z", "cwd": cwd, "instructions": SENT_PROMPT}),
        cx("2026-09-26T05:30:00.100Z", "turn_context", {"cwd": cwd, "model": "gpt-5-codex"}),
        token_count("2026-09-26T05:30:00.200Z", u(10000, 8000, 500, 200), u(10000, 8000, 500, 200)),
        token_count("2026-09-26T05:30:00.210Z", u(25000, 20000, 1500, 600), u(15000, 12000, 1000, 400)),
        token_count("2026-09-26T05:30:00.220Z", u(40000, 30000, 2500, 900)),
        token_count("2026-09-26T05:30:00.230Z", u(60000, 45000, 4000, 1500), u(20000, 15000, 1500, 600)),
        token_count("2026-09-26T05:45:00.000Z", u(90000, 70000, 6000, 2000), u(30000, 25000, 2000, 500)),
    ]
    write_lines(os.path.join(S, "2026/09/26", f"rollout-2026-09-26T05-30-00-{child_id}.jsonl"), child)

    # No turn_context and no model anywhere: falls back to gpt-5.
    nomodel_id = "0199a000-0000-7000-8000-00000000n001"
    write_lines(os.path.join(S, "2026/09/26", f"rollout-2026-09-26T08-00-00-{nomodel_id}.jsonl"), [
        cx("2026-09-26T08:00:00.000Z", "session_meta", {"id": nomodel_id, "cwd": "/Users/demo/code/gamma"}),
        token_count("2026-09-26T08:00:05.000Z", u(3000, 1000, 200, 50), u(3000, 1000, 200, 50)),
    ])

    # Priority service tier (fast pricing) and a long-context request (> 272K).
    tier_id = "0199a000-0000-7000-8000-00000000t001"
    write_lines(os.path.join(S, "2026/09/26", f"rollout-2026-09-26T09-00-00-{tier_id}.jsonl"), [
        cx("2026-09-26T09:00:00.000Z", "session_meta", {"id": tier_id, "cwd": cwd}),
        cx("2026-09-26T09:00:00.500Z", "turn_context", {"cwd": cwd, "model": "gpt-5.4"}),
        cx("2026-09-26T09:00:01.000Z", "event_msg", {"type": "thread_settings_applied", "thread_settings": {"service_tier": "priority"}}),
        token_count("2026-09-26T09:00:05.000Z", u(5000, 4000, 300, 100), u(5000, 4000, 300, 100)),
        cx("2026-09-26T09:10:00.000Z", "event_msg", {"type": "thread_settings_applied", "thread_settings": {"service_tier": "default"}}),
        token_count("2026-09-26T09:10:05.000Z", u(305000, 204000, 1300, 100), u(300000, 200000, 1000, 0)),
    ])

    # Archived copy with the same relative path is ignored (active copy wins);
    # a copy under a different name collapses by event identity.
    A = os.path.join(root, "archived_sessions")
    shutil.copy(os.path.join(S, "2026/09/26", f"rollout-2026-09-26T08-00-00-{nomodel_id}.jsonl"),
                os.path.join(os.makedirs(os.path.join(A, "2026/09/26"), exist_ok=True) or os.path.join(A, "2026/09/26"),
                             f"rollout-2026-09-26T08-00-00-{nomodel_id}.jsonl"))
    shutil.copy(os.path.join(S, "2026/09/26", f"rollout-2026-09-26T09-00-00-{tier_id}.jsonl"),
                os.path.join(A, f"rollout-copy-{tier_id}.jsonl"))


# ---------------------------------------------------------------- Gemini ---
def gen_gemini():
    root = os.path.join(HERE, "gemini", "basic")
    reset(root)
    proj = os.path.join(root, "alpha-3f2a", "chats")
    sid = "g-session-0001"
    write_lines(os.path.join(proj, "session-2026-09-25T21-00-g0001.jsonl"), [
        {"sessionId": sid, "projectHash": "3f2a" * 16, "startTime": "2026-09-25T21:00:00.000Z",
         "lastUpdated": "2026-09-26T10:00:00.000Z", "kind": "main"},
        {"id": "m1", "timestamp": "2026-09-25T21:00:01.000Z", "type": "user", "content": [{"text": SENT_PROMPT}]},
        {"id": "m2", "timestamp": "2026-09-25T21:00:05.000Z", "type": "gemini", "content": SENT_RESPONSE,
         "thoughts": [{"subject": "Plan", "description": SENT_THINKING, "timestamp": "2026-09-25T21:00:04.000Z"}],
         "toolCalls": [{"id": "c1", "name": "run_shell_command", "args": {"command": SENT_TOOL}, "status": "success",
                        "timestamp": "2026-09-25T21:00:04.500Z", "result": [{"text": SENT_TOOL}]}],
         "tokens": {"input": 15327, "output": 23, "cached": 11526, "thoughts": 919, "tool": 7, "total": 16276},
         "model": "gemini-2.5-pro"},
        # Updated copy of m2 (same id) replaces the first.
        {"id": "m2", "timestamp": "2026-09-25T21:00:05.000Z", "type": "gemini", "content": SENT_RESPONSE,
         "tokens": {"input": 15327, "output": 120, "cached": 11526, "thoughts": 919, "tool": 7, "total": 16373},
         "model": "gemini-2.5-pro"},
        {"$set": {"summary": SENT_PROMPT}},
        "{broken json",
        {"id": "m3", "timestamp": "2026-09-26T00:00:00.000Z", "type": "gemini", "content": SENT_RESPONSE,
         "tokens": {"input": 2000, "output": 300, "cached": 0, "thoughts": 50, "tool": 0, "total": 2350},
         "model": "gemini-2.5-flash"},
        # Exclusive cache accounting (total counts cached separately).
        {"id": "m4", "timestamp": "2026-09-26T10:00:00.000Z", "type": "gemini", "content": SENT_RESPONSE,
         "tokens": {"input": 1000, "output": 100, "cached": 4000, "thoughts": 0, "tool": 0, "total": 5100},
         "model": "gemini-2.5-flash"},
    ])
    # Legacy whole-document format.
    legacy = os.path.join(root, "beta-9c1d", "chats", "session-2026-09-24T08-00-legacy.json")
    os.makedirs(os.path.dirname(legacy), exist_ok=True)
    with open(legacy, "w") as f:
        json.dump({"sessionId": "g-legacy-1", "projectHash": "9c1d" * 16, "startTime": "2026-09-24T08:00:00.000Z",
                   "lastUpdated": "2026-09-24T09:00:00.000Z", "messages": [
                       {"id": "l1", "timestamp": "2026-09-24T08:00:01.000Z", "type": "user", "content": SENT_PROMPT},
                       {"id": "l2", "timestamp": "2026-09-24T08:00:09.000Z", "type": "gemini", "content": SENT_RESPONSE,
                        "tokens": {"input": 8000, "output": 900, "cached": 2000, "thoughts": 300, "tool": 0, "total": 9200},
                        "model": "gemini-2.5-pro"},
                   ]}, f)


if __name__ == "__main__":
    gen_claude()
    gen_codex()
    gen_gemini()
    print("fixtures written under", HERE)
