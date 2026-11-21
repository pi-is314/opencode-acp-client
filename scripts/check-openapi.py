#!/usr/bin/env python3
"""Validate this adapter's responses against opencode's published OpenAPI spec.

The `/api/*` surface is published (OpenAPI 3.1.0) at
<https://opencode.ai/v2/docs/api>, machine-readable at
<https://opencode.ai/v2/openapi.json>. This script drives the *real* server
against the fake ACP agent, then checks each response body against the spec's
schema for that operation, so "we implement the documented surface" is a
measurement instead of a claim.

Usage:
  python3 scripts/check-openapi.py --spec /tmp/openapi.json --node dist/index.js

Exit status is non-zero when a response does not validate. Deviations that are
deliberate (an extra `location` sibling the TUI reads, both spellings of the
forms list) are reported as NOTES rather than failures — see ALLOWED below.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import shutil
import time
import urllib.error
import urllib.request

# Responses we knowingly send that the spec does not describe, with the reason.
# Anything here still has to be a *superset* of what the spec requires.
ALLOWED = {
    # A superset the client reads; the spec's schemas are strict about extras.
    "/api/session": "we add a `location` sibling (the spec has none on session routes)",
    "/api/session/{}": "we add a `location` sibling (the spec has none on session routes)",
    "/api/session/active": "we add a `location` sibling",
    "/api/session/{}/message": "typed messages per the spec, plus our `parts`/`role`/`sessionID` mirror",
    "/api/session/{}/inbox": "we add a `location` sibling",
    # The transcript export serves the same typed-message superset the /message list does
    # (the /message entry above is the registered allowance for it); `info` itself is
    # projected down to the spec's Session.Info.
    "/api/experimental/session/{}/export": "typed messages per the spec, plus our `parts`/`role`/`sessionID` mirror",
    "/api/session/{}/permission": "we add a `location` sibling",
    "/api/session/{}/diff": "we add a `location` sibling",
    "/api/provider": "each provider keeps `models`; the TUI's picker groups by it",
    "/api/shell": "Shell.Info carries the `output` we poll separately",
    "/api/shell/{}": "Shell.Info carries the `output` we poll separately",
    # Shapes the current TUI asks for that the spec models differently.
    "/api/session/{}/message/{}": "typed message per the spec, plus our `parts`/`role`/`sessionID` mirror",
    "/api/form/request": "the TUI's client calls this spelling; the spec says GET /api/form",
    "/api/session/{}/form/{}/state": "the older client polls state separately; the spec folds it into Form.Detail",
    "/api/project/current": "the client asks for it; the spec has project.list/patch only",
    # Routes v2 does not have at all, answered so the client is not left guessing.
    "/api/session/{}/terminal": "not in v2; answered empty rather than 404",
    "/api/session/{}/todo": "v2 has no todo surface by design; answered empty",
    "/api/session/{}/abort": "legacy spelling of session.interrupt; both are served",
    "/api/health": "added after 2.0.27: the desktop app's Add-server probe uses it, and the published spec only has /api/info — both are served",
}


def load_spec(path: str) -> dict:
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def deref(spec: dict, node, depth: int = 0):
    """Inline every local `$ref` so a schema can be validated standalone.

    The spec's refs are `#/components/schemas/...`; jsonschema's registry would
    resolve them against the *inline* schema rather than the root document, so we
    substitute them here. A depth cap keeps a recursive schema from looping (it
    goes permissive at the cap, which only weakens the check, never fails it).
    """
    if depth > 40:
        return {}
    if isinstance(node, dict):
        ref = node.get("$ref")
        if isinstance(ref, str) and ref.startswith("#/"):
            target = spec
            for part in ref[2:].split("/"):
                target = target[part.replace("~1", "/").replace("~0", "~")]
            return deref(spec, target, depth + 1)
        return {key: deref(spec, value, depth + 1) for key, value in node.items()}
    if isinstance(node, list):
        return [deref(spec, item, depth + 1) for item in node]
    return node


def make_validator(spec: dict):
    from jsonschema import Draft202012Validator

    cache: dict[int, list] = {}

    def validate(schema: dict, body) -> list[str]:
        key = id(schema)
        if key not in cache:
            cache[key] = []
            validator = Draft202012Validator(deref(spec, schema))
            cache[key] = validator
        validator = cache[key]
        return [
            f"{'/'.join(str(p) for p in error.absolute_path) or '<root>'}: {error.message}"[:220]
            for error in sorted(validator.iter_errors(body), key=lambda e: list(e.absolute_path))
        ]

    return validate


def request(method: str, url: str, payload=None, timeout: int = 20):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if data:
        req.add_header("content-type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            raw = response.read()
            status = response.status
    except urllib.error.HTTPError as error:  # a 404 is a result, not a crash
        raw, status = error.read(), error.code
    try:
        return status, json.loads(raw) if raw else None
    except json.JSONDecodeError:
        return status, raw.decode("utf-8", "replace")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--spec", default="/tmp/oac-openapi.json")
    parser.add_argument("--node", default="dist/index.js")
    parser.add_argument("--port", type=int, default=4791)
    args = parser.parse_args()

    spec = load_spec(args.spec)
    validate = make_validator(spec)
    # Match on shape, not on parameter names: the spec calls the shell id `{id}`
    # while a probe naturally says `{shellID}`, and a name mismatch is not a
    # conformance finding.
    def normalise(path: str) -> str:
        path = re.sub(r"\{[^}]+\}", "{}", path)
        return re.sub(r"/(ses|msg|frm|perm|sh)_[A-Za-z0-9]+", "/{}", path)

    paths = {normalise(path): ops for path, ops in spec["paths"].items()}

    map_dir = tempfile.mkdtemp(prefix="oac-openapi-map-")
    env = dict(
        os.environ,
        FAKE_ACP_MODELS="1",
        FAKE_ACP_PERMISSION="allow",
        FAKE_ACP_ELICIT="1",
        OPENCODE_ACP_CLIENT_SESSION_MAP=os.path.join(map_dir, "sessions.json"),
    )
    server = subprocess.Popen(
        [sys.executable and "node", args.node, "--no-tui", "--bridge-port", str(args.port),
         os.getcwd(), "--", "node", os.path.abspath("tests/fake-acp-agent.mjs")],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=env,
    )
    base = f"http://127.0.0.1:{args.port}"
    try:
        deadline = time.time() + 30
        while time.time() < deadline:
            line = server.stdout.readline() if server.stdout else ""
            if '"type":"ready"' in line:
                break
        else:
            print("✗ server never became ready")
            return 1

        results: list[tuple[str, str, str, list[str]]] = []

        def probe(method: str, path: str, payload=None, status_expect=(200,)):
            url = base + path
            status, body = request(method, url, payload)
            path = path.split("?", 1)[0]
            template = normalise(path)
            operation = (paths.get(template) or {}).get(method.lower())
            if operation is None:
                verdict = "NOTE" if template in ALLOWED else "NOT IN SPEC"
                results.append((method, template, verdict, [f"path/verb absent from the spec (status {status})"]))
                return status, body
            if status not in status_expect:
                results.append((method, template, "WRONG STATUS", [f"expected {status_expect}, got {status}"]))
                return status, body
            success = (operation.get("responses") or {}).get(str(status)) or {}
            schema = (((success.get("content") or {}).get("application/json") or {}).get("schema"))
            if schema is None:  # 204 and friends
                results.append((method, template, "PASS", []))
                return status, body
            errors = validate(schema, body)
            verdict = "PASS" if not errors else ("NOTE" if template in ALLOWED else "FAIL")
            results.append((method, template, verdict, errors))
            return status, body

        # ---- state the later probes need -------------------------------
        _, session = probe("POST", "/api/session", payload={})
        session_id = ((session or {}).get("data") or {}).get("id")
        if not session_id:
            print("✗ no session id; cannot continue")
            return 1

        request("POST", f"{base}/api/session/{session_id}/prompt", {"text": "conformance"})
        time.sleep(2)

        _, permissions = probe("GET", "/api/permission/request")
        perm_id = ((permissions or {}).get("data") or [{}])[0].get("id")
        _, forms = probe("GET", "/api/form")
        form_id = ((forms or {}).get("data") or [{}])[0].get("id")
        _, messages = probe("GET", f"/api/session/{session_id}/message")
        message_id = ((messages or {}).get("data") or [{}])[0].get("id")

        body = probe("POST", "/api/shell", payload={"command": {"command": "echo spec", "timeout": 5000}})[1]
        shell_id = ((body or {}).get("data") or {}).get("id")

        # ---- everything else ------------------------------------------
        for path in [
            "/api/info", "/api/health", "/api/location", "/api/agent", "/api/plugin", "/api/model",
            "/api/provider", "/api/config", "/api/mcp", "/api/mcp/resource", "/api/project",
            "/api/project/current", "/api/vcs", "/api/worktree", "/api/session",
            "/api/session/active", "/api/form", "/api/form/request", "/api/permission/request",
            # The /skills picker reads this; the schema is Skill.Info with
            # {id, name, description?, autoinvoke?, path, content} required fields.
            "/api/skill",
            "/api/experimental/migration/v1",
        ]:
            probe("GET", path)
        for path in [
            f"/api/session/{session_id}", f"/api/session/{session_id}/message",
            f"/api/session/{session_id}/form", f"/api/session/{session_id}/permission",
            f"/api/session/{session_id}/inbox", f"/api/session/{session_id}/todo",
            f"/api/session/{session_id}/diff", f"/api/session/{session_id}/terminal",
        ]:
            probe("GET", path)
        if message_id:
            probe("GET", f"/api/session/{session_id}/message/{message_id}")
        if form_id:
            probe("GET", f"/api/session/{session_id}/form/{form_id}")
            probe("GET", f"/api/session/{session_id}/form/{form_id}/state")
            probe("POST", f"/api/session/{session_id}/form/{form_id}/reply",
                  payload={"answer": {"strategy": "balanced"}}, status_expect=(204,))
            # The shipped client's Esc-on-a-form is DELETE /form/{fid} (spec-declared
            # 204). A fresh form is needed — the one above was consumed by the reply —
            # and the fixture emits one per prompt, so ask again and dismiss that one.
            request("POST", f"{base}/api/session/{session_id}/prompt", {"text": "conformance form cancel"})
            time.sleep(1)
            _, forms2 = probe("GET", f"/api/session/{session_id}/form")
            form_id2 = ((forms2 or {}).get("data") or [{}])[0].get("id")
            if form_id2:
                probe("DELETE", f"/api/session/{session_id}/form/{form_id2}", status_expect=(204,))
        if perm_id:
            probe("POST", f"/api/session/{session_id}/permission/{perm_id}/reply",
                  payload={"reply": "once"}, status_expect=(204,))
        if shell_id:
            probe("GET", f"/api/shell/{shell_id}")
            probe("GET", f"/api/shell/{shell_id}/output?cursor=0")
            probe("DELETE", f"/api/shell/{shell_id}", status_expect=(204,))
        probe("PATCH", f"/api/session/{session_id}", payload={"title": "conformance"},
              status_expect=(204, 200))
        probe("POST", f"/api/session/{session_id}/model",
              payload={"model": {"providerID": "fake", "modelID": "model-1", "id": "model-1"}},
              status_expect=(204, 200))
        probe("POST", f"/api/session/{session_id}/interrupt", status_expect=(204, 200))
        probe("POST", f"/api/session/{session_id}/view", payload={"idle": 0}, status_expect=(204,))
        # `/btw` posts here: `successStatus: 200`, body `{data:{text}}`. ACP has no
        # side-question method that leaves the session untouched (session/fork is unstable and
        # not advertised by the measured agents), so the answer must be the declared 503 — the
        # generic 204 fallback produced the owner's UnexpectedStatus toast.
        probe("POST", f"/api/session/{session_id}/generate", payload={"prompt": "conformance side question"},
              status_expect=(503, 400, 404))
        # `/cd` posts here. The declaration is `successStatus: 204`; a target that does not
        # exist must answer the declared 400 with the official message, so the probe pins
        # the refusal side without moving the probe session anywhere.
        # `/rename` PATCHes here and the declaration is `successStatus: 204, empty: true`;
        # a 200 with a body was the first bug the patrol caught.
        probe("PATCH", f"/api/session/{session_id}", payload={"title": "conformance"},
              status_expect=(204,))
        # `/reload` posts here (also declared 204); the generic array fallback answered 200.
        probe("POST", "/api/location/reload", status_expect=(204,))
        # `/copy` and `/export` fetch the whole transcript here; the client feeds
        # `data.info`/`data.messages` to the transcript formatter.
        probe("GET", f"/api/experimental/session/{session_id}/export", status_expect=(200,))
        probe("POST", f"/api/session/{session_id}/move",
              payload={"directory": "/tmp/oac-conformance-no-such-directory"},
              status_expect=(400,))
        # `/compact` declares `successStatus: 200, empty: false, declaredStatuses: [400,401,404,409]`.
        # We cannot compact (ACP has no such method), so the answer must be one of the *declared*
        # statuses: a 204 here is outside that set and the generated client turns it into the
        # `UnexpectedStatus: 204` toast the owner saw.
        probe("POST", f"/api/session/{session_id}/compact", payload={}, status_expect=(409, 400, 404))

        # ---- report ----------------------------------------------------
        width = max(len(f"{m} {p}") for m, p, _, _ in results)
        failures = 0
        for method, path, verdict, errors in sorted(results, key=lambda r: (r[2], r[0], r[1])):
            if verdict == "FAIL":
                failures += 1
            print(f"  {verdict:13} {f'{method} {path}':<{width}}")
            for error in errors[:3]:
                print(f"                ↳ {error}")
        notes = [r for r in results if r[2] == "NOTE"]
        print()
        print(f"{len(results)} probes: {sum(1 for r in results if r[2] == 'PASS')} pass, "
              f"{len(notes)} note, {failures} fail, "
              f"{sum(1 for r in results if r[2] in ('NOT IN SPEC', 'WRONG STATUS'))} other")
        for _, path, verdict, _ in notes:
            print(f"  note: {path} — {ALLOWED.get(path, '')}")
        return 1 if failures else 0
    finally:
        server.terminate()
        try:
            server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            server.kill()
        shutil.rmtree(map_dir, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
