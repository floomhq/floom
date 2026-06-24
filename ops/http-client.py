#!/usr/bin/env python3
"""Small urllib-based HTTP helper for CI environments where curl is unavailable."""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def request(url: str, *, method: str = "GET", data: str | None = None, headers: dict[str, str] | None = None, timeout: int = 20, follow: bool = True):
    payload = data.encode("utf-8") if data is not None else None
    req = urllib.request.Request(url, data=payload, method=method, headers=headers or {})
    opener = urllib.request.build_opener() if follow else urllib.request.build_opener(NoRedirect)
    try:
        with opener.open(req, timeout=timeout) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()
    except Exception:
        return "000", b""


def field_value(doc, field: str):
    value = doc
    for part in field.split("."):
        if not isinstance(value, dict):
            return ""
        value = value.get(part)
        if value is None:
            return ""
    return value if isinstance(value, str) else ""


def vercel_headers() -> dict[str, str]:
    token = os.environ.get("VERCEL_TOKEN", "")
    headers = {"Authorization": f"Bearer {token}"}
    return headers


def cmd_vercel_json_get(args: argparse.Namespace) -> int:
    status, body = request(args.url, headers=vercel_headers(), timeout=args.timeout)
    try:
        doc = json.loads(body.decode("utf-8")) if body else {}
    except Exception:
        doc = {}
    print(field_value(doc, args.field))
    return 0


def cmd_vercel_request(args: argparse.Namespace) -> int:
    headers = vercel_headers()
    if args.data is not None:
        headers["Content-Type"] = "application/json"
    _status, body = request(args.url, method=args.method, data=args.data, headers=headers, timeout=args.timeout)
    sys.stdout.buffer.write(body)
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    status, _body = request(args.url, timeout=args.timeout, follow=False)
    print(status)
    return 0


def cmd_fetch(args: argparse.Namespace) -> int:
    status, body = request(args.url, timeout=args.timeout, follow=True)
    if status == "000" or int(status) >= 400:
        return 1
    with open(args.output, "wb") as fh:
        fh.write(body)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("vercel-json-get")
    p.add_argument("--url", required=True)
    p.add_argument("--field", required=True)
    p.add_argument("--timeout", type=int, default=20)
    p.set_defaults(func=cmd_vercel_json_get)

    p = sub.add_parser("vercel-request")
    p.add_argument("--url", required=True)
    p.add_argument("--method", default="GET")
    p.add_argument("--data")
    p.add_argument("--timeout", type=int, default=20)
    p.set_defaults(func=cmd_vercel_request)

    p = sub.add_parser("status")
    p.add_argument("--url", required=True)
    p.add_argument("--timeout", type=int, default=20)
    p.set_defaults(func=cmd_status)

    p = sub.add_parser("fetch")
    p.add_argument("--url", required=True)
    p.add_argument("--output", required=True)
    p.add_argument("--timeout", type=int, default=30)
    p.set_defaults(func=cmd_fetch)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
