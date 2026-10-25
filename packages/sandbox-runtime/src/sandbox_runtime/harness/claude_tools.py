"""Open Inspect tools for the Claude harness, as one in-process SDK MCP server.

These are the same seven tools OpenCode gets as ``.opencode/tool/*.js``
plugins, ported over the same control-plane side channels
(``/sessions/:id/children``, ``/pr``, ``/slack-notify``, ``/media``). They run
inside the bridge process, so they see the bridge's environment rather than
the child's clean one, and no credential has to reach the ``claude`` process
for them to work.
"""

from __future__ import annotations

import json
import mimetypes
import subprocess
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any, Final
from urllib.parse import quote, urlencode

import httpx

from ..direct_upload import DirectUploadError, put_parts
from ..repo_config import load_repo_manifest

if TYPE_CHECKING:
    from ..log_config import StructuredLogger

OI_TOOL_SERVER_NAME: Final = "oi"
TOOL_REQUEST_TIMEOUT_SECONDS: Final = 30.0
MEDIA_UPLOAD_TIMEOUT_SECONDS: Final = 120.0
# Videos up to this size are posted through the control plane; larger videos
# and every file artifact go straight to storage (``direct_upload``).
VIDEO_INLINE_MAX_BYTES: Final = 100 * 1024 * 1024
# ``POST /pr`` waits synchronously for the sandbox push; the control plane
# gives that push 360 seconds before it reports a timeout of its own. The tool
# must outlast the server so a slow push is reported once, by the server.
PULL_REQUEST_TIMEOUT_SECONDS: Final = 390.0
ASK_USER_TOOL_NAME: Final = "ask_user"
# What the agent reads once its card is on screen. The sandbox may be saved
# while the creator thinks, so nothing waits here: the turn has to end.
ASK_USER_SHOWN_MESSAGE: Final = (
    "The question is now on the user's screen (questionId {question_id}). End your turn now: "
    "do not call any more tools and do not write anything else. The user's answer will arrive "
    'as the next user message, starting with "[回答 {question_id}" or "[用户".'
)
ASK_USER_DESCRIPTION: Final = (
    "Ask the user ONE question as an interactive card in the product's UI, then end your turn. "
    "Use it whenever you need the user to choose between options, fill in information you "
    "cannot infer, upload a file, or approve a spend before you generate paid media "
    "(kind 'confirm_cost' with the credit cost). Do not use it for questions you can answer "
    "yourself, and never ask in plain text when a card fits. One question per call and one call "
    "per turn: after it returns, stop immediately (no more tool calls, no more text); the answer "
    "arrives as the next user message. Card kinds and the fields each needs: 'single' (options; "
    "allowOther adds a free-text 其他 row), 'multi' (options, pick several), 'binary' (exactly 2 "
    "options), 'voice' (options whose artifactId is a preview audio you uploaded), 'image' "
    "(options whose artifactId is an image you uploaded), 'fields' (fields to fill in), "
    "'multi_question' (questions: several option groups on one card), 'confirm_cost' (cost: "
    "totalCredits and lines), 'upload' (upload: accept, e.g. 'video/*'). 'secondary' adds up to "
    "4 extra buttons such as 换一批 or 重画; pressing one answers with its value. "
    "Write title, labels and option text in the user's language."
)
NAME_PROJECT_TOOL_NAME: Final = "name_project"
# Longer than any title reads well in the project list; the control plane has its own cap.
PROJECT_NAME_MAX_CHARS: Final = 60
NAME_PROJECT_DESCRIPTION: Final = (
    "Name this project: the title the user sees on the project page and in their history. "
    "Until you call it the project is listed under the first words of their first message, or "
    "as untitled when that was only a link. Call it once, as soon as you know what is being "
    "made (the brief is clear, or the user picked a direction). Write a short title in the "
    "user's language that says what the piece is, the way a finished work is titled: "
    "「颜料宇宙 · 30 秒动效片」, 'Oat latte launch film'. Not a file name or code name, no "
    "link, date or version number, and not the user's sentence repeated back. The name lands "
    "only while nobody has named the project: after that, renaming is the user's, by clicking "
    "the title. Nothing appears in the conversation, so do not mention the call."
)
NAME_PROJECT_SCHEMA: Final = {
    "type": "object",
    "properties": {
        "title": {
            "type": "string",
            "description": f"The project's name, at most {PROJECT_NAME_MAX_CHARS} characters.",
        }
    },
    "required": ["title"],
}

_STATUS_LABELS: Final = {
    "created": "PENDING",
    "active": "RUNNING",
    "completed": "DONE",
    "failed": "FAILED",
    "cancelled": "CANCELLED",
    "archived": "DONE",
}

_SLACK_REASON_GUIDANCE: Final = {
    "feature_unavailable": "The deployment is not configured to send agent notifications. Tell the user this is unavailable.",
    "feature_disabled": "Agent notifications are disabled for this repository. Ask the user to enable them in integration settings.",
    "channel_not_found_or_forbidden": "The channel was not found, is archived, or the bot is not in it. If the channel name is correct and not archived, ask the user to invite the bot.",
    "empty_message_after_sanitization": "The message body was empty after sanitization. Try again with non-empty content.",
    "rate_limited": "Slack rate-limited the request. Wait before retrying.",
    "slack_api_error": "Slack returned an unexpected error. The post did not go through.",
    "delivery_unknown": "Slack may have posted the notification, but confirmation timed out. Do not retry automatically; check the channel first to avoid posting it twice.",
    "invalid_input": "The notification arguments were invalid; correct them and retry.",
    "bridge_error": "Could not reach the control plane to post the notification.",
}
_SLACK_STATUS_FALLBACK: Final = {
    400: "invalid_input",
    403: "feature_disabled",
    404: "channel_not_found_or_forbidden",
    422: "empty_message_after_sanitization",
    429: "rate_limited",
    503: "feature_unavailable",
}

_MEDIA_MIME_TYPES: Final = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".mp4": "video/mp4",
    ".html": "text/html",
    ".htm": "text/html",
}


@dataclass(frozen=True)
class ToolServerConfig:
    control_plane_url: str
    session_id: str
    auth_token: str
    repo_manifest_path: Path
    has_repository: bool
    slack_notify_enabled: bool


class ControlPlaneToolClient:
    """Authenticated session-scoped requests, the Python twin of ``_bridge-client.js``."""

    def __init__(
        self,
        config: ToolServerConfig,
        log: StructuredLogger,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self.config = config
        self.log = log
        self._http_client = http_client

    def _client(self) -> httpx.AsyncClient:
        if self._http_client is None:
            self._http_client = httpx.AsyncClient(timeout=TOOL_REQUEST_TIMEOUT_SECONDS)
        return self._http_client

    def http(self) -> httpx.AsyncClient:
        """The underlying client, for requests outside the control plane (signed storage URLs)."""
        return self._client()

    async def aclose(self) -> None:
        if self._http_client is not None:
            await self._http_client.aclose()
            self._http_client = None

    def url(self, path: str) -> str:
        base = self.config.control_plane_url.rstrip("/")
        return f"{base}/sessions/{quote(self.config.session_id, safe='')}{path}"

    async def request(
        self,
        method: str,
        path: str,
        *,
        json_body: Any | None = None,
        files: Mapping[str, Any] | None = None,
        data: Mapping[str, Any] | None = None,
        timeout_seconds: float = TOOL_REQUEST_TIMEOUT_SECONDS,
    ) -> httpx.Response:
        headers = {"Authorization": f"Bearer {self.config.auth_token}"}
        return await self._client().request(
            method,
            self.url(path),
            headers=headers,
            json=json_body,
            files=files,
            data=data,
            timeout=timeout_seconds,
        )


def _error_text(response: httpx.Response) -> str:
    text = response.text
    try:
        body = json.loads(text)
    except ValueError:
        return text
    if isinstance(body, dict):
        return str(body.get("error") or body.get("message") or text)
    return text


def _format_status(status: str) -> str:
    return _STATUS_LABELS.get(status, status.upper())


def _format_timestamp(value: Any) -> str:
    if not value:
        return "n/a"
    try:
        return (
            datetime.fromtimestamp(float(value) / 1000, tz=UTC).isoformat().replace("+00:00", "Z")
        )
    except (TypeError, ValueError, OSError):
        return str(value)


def project_name(args: Mapping[str, Any]) -> str | None:
    """The title a ``name_project`` call gives the project, or ``None`` when it is not usable."""
    raw = args.get("title")
    if not isinstance(raw, str):
        return None
    title = " ".join(raw.split())
    return title if 0 < len(title) <= PROJECT_NAME_MAX_CHARS else None


def _text_result(text: str) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": text}]}


def _error_result(text: str) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": text}], "is_error": True}


def _issues(response: httpx.Response) -> list[str]:
    """The control plane's list of what is wrong with a card, or its error message."""
    try:
        body = response.json()
    except ValueError:
        return [response.text]
    if isinstance(body, dict) and isinstance(body.get("issues"), list) and body["issues"]:
        return [str(issue) for issue in body["issues"]]
    return [_error_text(response)]


def _pull_request_failure(message: str) -> str:
    return json.dumps({"kind": "failure", "message": message, "agentMessage": message})


def _pull_request_success(result: Mapping[str, Any]) -> str:
    state = "draft" if result.get("state") == "draft" else "open"
    head, base = result.get("headBranch"), result.get("baseBranch")
    branches = f" ({head} -> {base})" if head and base else ""
    number, url = result.get("prNumber"), result.get("prUrl")
    if result.get("updated"):
        agent_message = (
            f"Pull request updated with your latest commits.\n\nPR #{number}{branches}: {url}"
        )
    else:
        status = (
            "The pull request is in draft mode."
            if state == "draft"
            else "The pull request is now ready for review."
        )
        agent_message = (
            f"Pull request created successfully!\n\nPR #{number}{branches}: {url}\n\n{status}"
        )
    return json.dumps(
        {
            "kind": "updated" if result.get("updated") else "created",
            "prNumber": number,
            "prUrl": url,
            "state": state,
            "headBranch": head,
            "baseBranch": base,
            "agentMessage": agent_message,
        }
    )


def _manual_pull_request(create_pr_url: str) -> str:
    agent_message = (
        "Branch pushed successfully.\n\nCreate the pull request in GitHub:\n"
        f"{create_pr_url}\n\nUse your logged-in GitHub account to finish creating the PR."
    )
    return json.dumps(
        {"kind": "manual", "createPrUrl": create_pr_url, "agentMessage": agent_message}
    )


def _current_branch(repo_path: Path | None) -> str | None:
    args = [
        "git",
        *(["-C", str(repo_path)] if repo_path else []),
        "rev-parse",
        "--abbrev-ref",
        "HEAD",
    ]
    try:
        output = subprocess.run(args, capture_output=True, text=True, timeout=5, check=True).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    branch = output.strip()
    return branch if branch and branch != "HEAD" else None


def _dimensions_field(value: Any) -> str:
    """A ``{width, height}`` object as the JSON string the media endpoint parses."""
    if isinstance(value, Mapping):
        return json.dumps({"width": value.get("width"), "height": value.get("height")})
    return str(value)


def _slack_failure(reason: str, message: str | None = None, retry_after: Any = None) -> str:
    guidance = _SLACK_REASON_GUIDANCE.get(reason, _SLACK_REASON_GUIDANCE["slack_api_error"])
    detail = f"{guidance} ({message})" if message else guidance
    envelope: dict[str, Any] = {"ok": False, "reason": reason, "agentMessage": detail}
    if isinstance(retry_after, int | float) and not isinstance(retry_after, bool):
        envelope["retryAfterSeconds"] = retry_after
    return json.dumps(envelope)


class OpenInspectTools:
    """Tool handlers; ``build_server`` wraps them for the SDK."""

    def __init__(self, client: ControlPlaneToolClient) -> None:
        self.client = client
        self.log = client.log
        self.config = client.config

    # --- child sessions -------------------------------------------------

    async def spawn_child(self, args: Mapping[str, Any]) -> dict[str, Any]:
        body: dict[str, Any] = {"title": args.get("title"), "prompt": args.get("prompt")}
        if args.get("model"):
            body["model"] = args["model"]
        if args.get("reasoning") is not None:
            body["reasoningEffort"] = args["reasoning"]
        try:
            response = await self.client.request("POST", "/children", json_body=body)
        except httpx.HTTPError as error:
            return _text_result(f"Failed to spawn child: {error}")
        if response.status_code >= 400:
            message = _error_text(response)
            if response.status_code == 403:
                return _text_result(
                    f"Cannot spawn child: {message}. This may be a depth limit or repository restriction."
                )
            if response.status_code == 429:
                return _text_result(
                    f"Rate limited: {message}. Wait a moment before spawning another child."
                )
            return _text_result(f"Failed to spawn child: {message} (HTTP {response.status_code})")
        result = response.json()
        return _text_result(
            "\n".join(
                [
                    "Child spawned successfully.",
                    "",
                    f"  Child ID: {result.get('sessionId')}",
                    "  Status:  PENDING",
                    "",
                    "The child will continue independently. Check status only when you need its result; do not poll repeatedly.",
                ]
            )
        )

    async def send_child_prompt(self, args: Mapping[str, Any]) -> dict[str, Any]:
        child_id = str(args.get("childId") or "")
        encoded = quote(child_id, safe="")
        try:
            response = await self.client.request(
                "POST", f"/children/{encoded}/prompt", json_body={"content": args.get("prompt")}
            )
        except httpx.HTTPError as error:
            return _text_result(f"Failed to prompt child: {error}")
        if response.status_code >= 400:
            message = _error_text(response)
            if response.status_code == 404:
                return _text_result(
                    f'Child "{child_id}" not found. Use get-child-status to list direct children.'
                )
            if response.status_code == 409:
                return _text_result(f'Cannot prompt child "{child_id}": {message}')
            if response.status_code == 429:
                return _text_result(
                    f'Cannot queue another prompt for child "{child_id}": {message}'
                )
            return _text_result(f"Failed to prompt child: {message} (HTTP {response.status_code})")
        result = response.json()
        return _text_result(
            "\n".join(
                [
                    f'Follow-up durably queued for child "{child_id}".',
                    f"Message ID: {result.get('messageId')}",
                    "The prompt will run after any current child work. Use get-child-status when you need the result.",
                ]
            )
        )

    async def cancel_child(self, args: Mapping[str, Any]) -> dict[str, Any]:
        child_id = str(args.get("childId") or "")
        encoded = quote(child_id, safe="")
        cancel_nested = args.get("cancelNested", True)
        try:
            response = await self.client.request(
                "POST",
                f"/children/{encoded}/cancel",
                json_body={"cancelNested": bool(cancel_nested)},
            )
        except httpx.HTTPError as error:
            return _text_result(f"Failed to cancel child: {error}")
        if response.status_code >= 400:
            if response.status_code == 404:
                return _text_result(
                    f'Child "{child_id}" not found. Use get-child-status to list available children.'
                )
            message = _error_text(response)
            if response.status_code == 409:
                return _text_result(f"Cannot cancel: {message}")
            return _text_result(f"Failed to cancel child: {message} (HTTP {response.status_code})")
        result = response.json()
        nested = result.get("cancelledDescendantIds")
        nested_count = len(nested) if isinstance(nested, list) else 0
        nested_note = (
            f" Also cancelled {nested_count} nested child session(s)." if nested_count else ""
        )
        status = str(result.get("status") or "cancelled").upper()
        return _text_result(
            f'Child "{child_id}" cancelled successfully.{nested_note} Status: {status}'
        )

    async def get_child_status(self, args: Mapping[str, Any]) -> dict[str, Any]:
        try:
            if args.get("childId"):
                return _text_result(await self._child_detail(str(args["childId"]), args))
            return _text_result(await self._list_children())
        except httpx.HTTPError as error:
            return _text_result(f"Failed to get child status: {error}")

    async def _list_children(self) -> str:
        response = await self.client.request("GET", "/children")
        if response.status_code >= 400:
            return f"Failed to list children: {_error_text(response)} (HTTP {response.status_code})"
        children = response.json().get("children") or []
        if not children:
            return "No child sessions found."
        counts = {"pending": 0, "running": 0, "done": 0, "failed": 0}
        lines: list[str] = []
        for child in children:
            label = _format_status(str(child.get("status") or ""))
            key = {"PENDING": "pending", "RUNNING": "running", "FAILED": "failed"}.get(
                label, "done"
            )
            counts[key] += 1
            lines.extend(
                [
                    f"  [{label}] {child.get('id')}",
                    f"    Title: {child.get('title') or '(untitled)'}",
                    f"    Created: {_format_timestamp(child.get('createdAt'))}",
                    "",
                ]
            )
        header = (
            f"{len(children)} child session(s): {counts['running']} running, "
            f"{counts['pending']} pending, {counts['done']} done, {counts['failed']} failed"
        )
        return "\n".join([header, "", *lines])

    async def _child_detail(self, child_id: str, args: Mapping[str, Any]) -> str:
        include: list[str] = []
        include_trajectory = bool(args.get("includeTrajectory") or args.get("includeEventData"))
        if args.get("includeResponse"):
            include.append("result")
        if include_trajectory:
            include.append("trajectory")
        params: dict[str, str] = {}
        if include:
            params["include"] = ",".join(include)
        if include_trajectory and args.get("trajectoryLimit"):
            params["trajectoryLimit"] = str(args["trajectoryLimit"])
        if include_trajectory and args.get("trajectoryCursor"):
            params["trajectoryCursor"] = str(args["trajectoryCursor"])
        query = f"?{urlencode(params)}" if params else ""
        response = await self.client.request("GET", f"/children/{quote(child_id, safe='')}{query}")
        if response.status_code == 404:
            return (
                f'Child "{child_id}" not found. Use get-child-status without a childId '
                "to list all child sessions."
            )
        if response.status_code >= 400:
            return f"Failed to get child: {_error_text(response)} (HTTP {response.status_code})"
        detail = response.json()
        return self._format_child_detail(detail, child_id, args)

    @staticmethod
    def _format_child_detail(
        detail: Mapping[str, Any], child_id: str, args: Mapping[str, Any]
    ) -> str:
        # ``ChildSessionDetail``: the session row sits under ``session``;
        # sandbox, artifacts, responses and events sit beside it.
        session = detail.get("session") or {}
        status = _format_status(str(session.get("status") or ""))
        lines = [
            f"Child {session.get('id') or child_id}",
            f"  Status: {status}",
            f"  Title: {session.get('title') or '(untitled)'}",
            f"  Model: {session.get('model') or 'default'}",
            f"  Repo: {session.get('repoOwner') or ''}/{session.get('repoName') or ''}",
            f"  Branch: {session.get('branchName') or '(none)'}",
            f"  Created: {_format_timestamp(session.get('createdAt'))}",
            f"  Updated: {_format_timestamp(session.get('updatedAt'))}",
        ]
        sandbox = detail.get("sandbox")
        if sandbox:
            lines.append(f"  Sandbox: {sandbox.get('status')}")
        artifacts = detail.get("artifacts") or []
        if artifacts:
            lines.extend(["", "  Artifacts:"])
            for artifact in artifacts:
                kind = artifact.get("type")
                label = (
                    f"PR: {artifact.get('url')}"
                    if kind == "pr"
                    else f"{kind}: {artifact.get('url')}"
                )
                lines.append(f"    - {label}")
        final = detail.get("finalResponse")
        if final:
            unfinished = bool(detail.get("hasUnfinishedPrompt"))
            label = (
                "  Latest completed response (newer prompt queued or running):"
                if unfinished
                else "  Final response:"
            )
            lines.extend(["", label, f"    Success: {'yes' if final.get('success') else 'no'}"])
            if final.get("error"):
                lines.append(f"    Error: {final['error']}")
            lines.append("    Text:")
            text = str(final.get("textContent") or "(empty)")
            lines.extend(f"      {line}" for line in text.split("\n"))
            calls = final.get("toolCalls") or []
            if calls:
                lines.extend(["", "    Tool summary:"])
                lines.extend(f"      - {call.get('summary') or call.get('tool')}" for call in calls)
        elif args.get("includeResponse"):
            lines.extend(["", "  Final response: not available yet"])
        trajectory = detail.get("trajectory")
        if trajectory:
            events = trajectory.get("events") or []
            suffix = " (more available)" if trajectory.get("hasMore") else ""
            lines.extend(["", f"  Trajectory ({len(events)} events{suffix}):"])
            for event in events:
                lines.append(
                    f"    - [{_format_timestamp(event.get('createdAt'))}] {event.get('type')}"
                )
                if args.get("includeEventData") and "data" in event:
                    lines.append(f"      {json.dumps(event.get('data'))}")
            if trajectory.get("hasMore") and trajectory.get("cursor"):
                lines.append(
                    f'    More events available. Re-run with trajectoryCursor="{trajectory["cursor"]}".'
                )
        recent = detail.get("recentEvents") or []
        if recent:
            lines.extend(["", "  Recent events:"])
            for event in recent:
                data = event.get("data") if isinstance(event.get("data"), Mapping) else None
                raw = (
                    (data or {}).get("message") or (data or {}).get("content") or event.get("type")
                )
                summary = raw if isinstance(raw, str) else json.dumps(raw)
                lines.append(
                    f"    [{_format_timestamp(event.get('createdAt'))}] {event.get('type')}: "
                    f"{summary[:120]}"
                )
        return "\n".join(lines)

    # --- pull requests --------------------------------------------------

    async def create_pull_request(self, args: Mapping[str, Any]) -> dict[str, Any]:
        title = args.get("title") or "Changes from Claude Agent session"
        body = args.get("body") or "Automated PR created via create-pull-request tool"
        repositories = load_repo_manifest(self.config.repo_manifest_path)
        valid_values = ", ".join(f"{repo.owner}/{repo.name}" for repo in repositories)
        repo_owner = repo_name = None
        repo_path: Path | None = None
        requested = str(args.get("repo") or "").strip()
        if requested:
            lowered = requested.lower()
            target = next(
                (r for r in repositories if f"{r.owner}/{r.name}".lower() == lowered), None
            )
            if target is None and repositories:
                return _text_result(
                    _pull_request_failure(
                        f"Failed to create pull request: {requested} is not part of this session. "
                        f"Valid values: {valid_values}."
                    )
                )
            if target is None:
                separator = requested.rfind("/")
                if separator <= 0 or separator == len(requested) - 1:
                    return _text_result(
                        _pull_request_failure(
                            'Failed to create pull request: repo must be "owner/name".'
                        )
                    )
                repo_owner, repo_name = requested[:separator], requested[separator + 1 :]
            else:
                repo_owner, repo_name, repo_path = target.owner, target.name, target.path
        elif len(repositories) > 1:
            return _text_result(
                _pull_request_failure(
                    "Failed to create pull request: this session spans multiple repositories "
                    f"— pass repo with one of: {valid_values}."
                )
            )
        elif repositories:
            # The bridge runs from the workspace root, one level above the
            # checkout; the branch must be read from the repository itself.
            repo_path = repositories[0].path
        head_branch = _current_branch(repo_path)
        # Absent optionals stay absent: the route accepts an omitted field but
        # rejects JSON null, and ``draft`` omitted means "the repository's default".
        payload: dict[str, Any] = {
            "title": title,
            "body": body,
            "timestamp": int(datetime.now(tz=UTC).timestamp() * 1000),
        }
        for key, value in (
            ("baseBranch", args.get("baseBranch")),
            ("headBranch", head_branch),
            ("repoOwner", repo_owner),
            ("repoName", repo_name),
            ("draft", args.get("draft")),
        ):
            if value is not None:
                payload[key] = value
        try:
            response = await self.client.request(
                "POST", "/pr", json_body=payload, timeout_seconds=PULL_REQUEST_TIMEOUT_SECONDS
            )
        except httpx.HTTPError as error:
            return _text_result(_pull_request_failure(f"Failed to create pull request: {error}"))
        if response.status_code >= 400:
            message = _error_text(response)
            user_message = f"Failed to create pull request: {message}"
            if response.status_code == 401:
                user_message = (
                    f"Authentication failed: {message}. The GitHub token may have expired - "
                    "please re-authenticate."
                )
            elif response.status_code == 404:
                user_message = f"Session not found: {message}. The session may have been deleted or the ID is incorrect."
            elif response.status_code == 409:
                user_message = (
                    f"Conflict: {message} To open an additional pull request, create a new branch "
                    "('git checkout -b'), commit, and call this tool again."
                )
            return _text_result(_pull_request_failure(user_message))
        result = response.json()
        if result.get("status") == "manual" and result.get("createPrUrl"):
            return _text_result(_manual_pull_request(str(result["createPrUrl"])))
        return _text_result(_pull_request_success(result))

    # --- slack ------------------------------------------------------------

    async def slack_notify(self, args: Mapping[str, Any]) -> dict[str, Any]:
        try:
            response = await self.client.request(
                "POST",
                "/slack-notify",
                json_body={
                    "channel": args.get("channel"),
                    "text": args.get("text"),
                    "thread_ts": args.get("thread_ts"),
                    "reason": args.get("reason"),
                },
            )
        except httpx.HTTPError as error:
            return _text_result(_slack_failure("bridge_error", str(error)))
        if response.status_code < 400:
            try:
                return _text_result(json.dumps(response.json()))
            except ValueError as error:
                return _text_result(
                    _slack_failure(
                        "slack_api_error",
                        f"Control plane returned a non-JSON 2xx response: {error}",
                    )
                )
        reason = message = retry_after = None
        try:
            body = response.json()
            if isinstance(body, dict):
                reason = body.get("error") if isinstance(body.get("error"), str) else None
                message = body.get("message") if isinstance(body.get("message"), str) else None
                retry_after = body.get("retryAfter")
        except ValueError:
            message = response.text or None
        fallback = _SLACK_STATUS_FALLBACK.get(response.status_code, "slack_api_error")
        final_reason = reason if reason in _SLACK_REASON_GUIDANCE else fallback
        return _text_result(_slack_failure(final_reason, message, retry_after))

    # --- media --------------------------------------------------------------

    async def upload_media(self, args: Mapping[str, Any]) -> dict[str, Any]:
        raw_path = str(args.get("filePath") or "")
        path = Path(raw_path).expanduser()
        if not path.is_file():
            return _text_result(f"upload-media requires a path to a file (got {raw_path!r}).")
        artifact_type = str(args.get("artifactType") or "screenshot")
        if artifact_type == "file":
            return await self._upload_file(path, args)
        mime = _MEDIA_MIME_TYPES.get(path.suffix.lower()) or mimetypes.guess_type(path.name)[0]
        if mime not in _MEDIA_MIME_TYPES.values():
            return _text_result(
                "upload-media only previews .png, .jpg, .jpeg, .webp, .mp4, and .html files; "
                "send any other file with artifactType 'file'."
            )
        if mime == "video/mp4" and artifact_type != "video":
            return _text_result("MP4 files must be uploaded with artifactType 'video'.")
        if mime == "text/html" and artifact_type != "page":
            return _text_result("HTML files must be uploaded with artifactType 'page'.")
        if artifact_type == "page" and mime != "text/html":
            return _text_result("artifactType 'page' requires an .html file.")
        data: dict[str, Any] = {"artifactType": artifact_type}
        for key in ("caption", "sourceUrl", "endUrl"):
            if args.get(key):
                data[key] = str(args[key])
        # Sizes travel as JSON object strings; that is what the endpoint parses.
        if args.get("viewport") is not None:
            data["viewport"] = _dimensions_field(args["viewport"])
        for key in ("fullPage", "annotated"):
            if args.get(key):
                data[key] = "true"
        if artifact_type == "video":
            for key in ("caption", "durationMs", "recordingStartedAt", "recordingEndedAt"):
                if not args.get(key):
                    return _text_result(f"Video uploads require {key}.")
            if args.get("dimensions") is None:
                return _text_result("Video uploads require dimensions.")
            for key in ("durationMs", "recordingStartedAt", "recordingEndedAt"):
                data[key] = str(args[key])
            data["dimensions"] = _dimensions_field(args["dimensions"])
            data["truncated"] = "true" if args.get("truncated") else "false"
            # The MP4 is stored as uploaded; the flag only describes it.
            data["hasAudio"] = "true" if args.get("hasAudio") is True else "false"
            if path.stat().st_size > VIDEO_INLINE_MAX_BYTES:
                video = {key: value for key, value in data.items() if key != "artifactType"}
                return await self._upload_direct(
                    path, {"artifactType": "video", "filename": path.name}, {"video": video}
                )
        try:
            response = await self.client.request(
                "POST",
                "/media",
                files={"file": (path.name, path.read_bytes(), mime)},
                data=data,
                timeout_seconds=MEDIA_UPLOAD_TIMEOUT_SECONDS,
            )
        except (httpx.HTTPError, OSError) as error:
            return _text_result(f"Failed to upload media: {error}")
        if response.status_code >= 400:
            return _text_result(f"Failed to upload media: {_error_text(response)}")
        return _text_result(json.dumps(response.json(), indent=2))

    async def _upload_file(self, path: Path, args: Mapping[str, Any]) -> dict[str, Any]:
        """Any file, handed to the user as a download."""
        filename = str(args.get("name") or path.name)
        start: dict[str, Any] = {"artifactType": "file", "filename": filename}
        content_type = mimetypes.guess_type(filename)[0]
        if content_type:
            start["contentType"] = content_type
        extra: dict[str, Any] = {}
        if args.get("caption"):
            extra["caption"] = str(args["caption"])
        if args.get("kind") in ("file", "project"):
            extra["kind"] = args["kind"]
        return await self._upload_direct(path, start, extra)

    async def _upload_direct(
        self, path: Path, start: dict[str, Any], extra: dict[str, Any]
    ) -> dict[str, Any]:
        """Open a direct upload, send the parts to storage, and record the artifact."""
        try:
            size = path.stat().st_size
            if size == 0:
                return _text_result("upload-media cannot upload an empty file.")
            response = await self.client.request(
                "POST", "/uploads", json_body={**start, "sizeBytes": size}
            )
            if response.status_code >= 400:
                return _text_result(f"Failed to upload media: {_error_text(response)}")
            upload = response.json()
            identity = {
                "artifactType": start["artifactType"],
                "uploadId": upload["uploadId"],
                "filename": upload["filename"],
            }
            try:
                parts = await put_parts(
                    self.client.http(),
                    path,
                    size,
                    list(upload["parts"]),
                    int(upload["partSizeBytes"]),
                )
            except DirectUploadError:
                await self.client.request(
                    "POST", f"/uploads/{upload['artifactId']}/abort", json_body=identity
                )
                raise
            complete = {**identity, **extra, "parts": parts}
            if "contentType" in start:
                complete["contentType"] = start["contentType"]
            response = await self.client.request(
                "POST",
                f"/uploads/{upload['artifactId']}/complete",
                json_body=complete,
                timeout_seconds=MEDIA_UPLOAD_TIMEOUT_SECONDS,
            )
        except (httpx.HTTPError, OSError, DirectUploadError, KeyError, ValueError) as error:
            return _text_result(f"Failed to upload media: {error}")
        if response.status_code >= 400:
            return _text_result(f"Failed to upload media: {_error_text(response)}")
        return _text_result(json.dumps(response.json(), indent=2))

    # --- questions ------------------------------------------------------------

    async def ask_user(self, args: Mapping[str, Any]) -> dict[str, Any]:
        """Show a question card; the turn ends and the answer comes back as a prompt."""
        card = {key: value for key, value in args.items() if value is not None}
        try:
            response = await self.client.request("POST", "/questions", json_body=card)
        except httpx.HTTPError as error:
            return _error_result(
                f"The question was not shown ({error}). Ask it in plain text instead, then end "
                "your turn."
            )
        if response.status_code == 400:
            issues = _issues(response)
            return _error_result(
                "The question was not shown because the card is invalid:\n"
                + "\n".join(f"- {issue}" for issue in issues)
                + "\nFix these and call ask_user again."
            )
        if response.status_code >= 400:
            return _error_result(
                f"The question was not shown: {_error_text(response)} "
                f"(HTTP {response.status_code}). Ask it in plain text instead, then end your turn."
            )
        question_id = str(response.json().get("questionId") or "")
        return _text_result(ASK_USER_SHOWN_MESSAGE.format(question_id=question_id))

    async def name_project(self, args: Mapping[str, Any]) -> dict[str, Any]:
        """Name the project; the harness sends the name on as the session's title."""
        if project_name(args) is None:
            return _error_result(
                f"The project was not named: title must be 1 to {PROJECT_NAME_MAX_CHARS} "
                "characters on one line. Call name_project again with a shorter title."
            )
        return _text_result("Named. Carry on without mentioning it.")


_TEXT: Final = {"type": "string"}
_OPTION_SCHEMA: Final = {
    "type": "object",
    "properties": {
        "value": {"type": "string", "description": "What the answer reports when this is picked."},
        "title": {"type": "string", "description": "The option as the user sees it."},
        "description": _TEXT,
        "tag": {"type": "string", "description": "A short badge, e.g. 推荐."},
        "aside": {"type": "string", "description": "A note on the right, e.g. a price."},
        "artifactId": {
            "type": "string",
            "description": "voice: the preview audio; image: the picture (an uploaded artifact).",
        },
    },
    "required": ["value", "title"],
}
ASK_USER_SCHEMA: Final = {
    "type": "object",
    "properties": {
        "title": {"type": "string", "description": "The question itself, shown as the heading."},
        "kind": {
            "type": "string",
            "enum": [
                "single",
                "multi",
                "binary",
                "voice",
                "image",
                "fields",
                "multi_question",
                "confirm_cost",
                "upload",
            ],
        },
        "options": {
            "type": "array",
            "items": _OPTION_SCHEMA,
            "description": "single / multi / binary (exactly 2) / voice / image.",
        },
        "allowOther": {
            "type": "boolean",
            "description": "single: add a last 其他 row with a text input.",
        },
        "fields": {
            "type": "array",
            "description": "fields: the inputs to fill in.",
            "items": {
                "type": "object",
                "properties": {
                    "key": _TEXT,
                    "label": _TEXT,
                    "placeholder": _TEXT,
                    "defaultValue": _TEXT,
                    "required": {"type": "boolean"},
                    "help": _TEXT,
                },
                "required": ["key", "label"],
            },
        },
        "questions": {
            "type": "array",
            "description": "multi_question: option groups shown together.",
            "items": {
                "type": "object",
                "properties": {
                    "key": _TEXT,
                    "label": _TEXT,
                    "options": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {"value": _TEXT, "label": _TEXT},
                            "required": ["value", "label"],
                        },
                    },
                    "defaultValue": _TEXT,
                },
                "required": ["key", "label", "options"],
            },
        },
        "cost": {
            "type": "object",
            "description": "confirm_cost: what the user is asked to spend, in the product's credits.",
            "properties": {
                "totalCredits": {"type": "number"},
                "lines": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {"label": _TEXT, "credits": {"type": "number"}},
                        "required": ["label", "credits"],
                    },
                },
            },
            "required": ["totalCredits", "lines"],
        },
        "upload": {
            "type": "object",
            "description": "upload: which files to ask for.",
            "properties": {
                "accept": {"type": "string", "description": "e.g. video/*,audio/*"},
                "hint": _TEXT,
            },
            "required": ["accept"],
        },
        "submitLabel": {
            "type": "string",
            "description": "The main button's label; defaults to 确定.",
        },
        "secondary": {
            "type": "array",
            "description": "Up to 4 extra buttons, e.g. 换一批.",
            "items": {
                "type": "object",
                "properties": {"value": _TEXT, "label": _TEXT},
                "required": ["value", "label"],
            },
        },
    },
    "required": ["title", "kind"],
}


def build_tools(client: ControlPlaneToolClient) -> list[Any]:
    """The ``@tool`` definitions, gated the way the OpenCode plugins are."""
    from claude_agent_sdk import tool

    handlers = OpenInspectTools(client)
    config = client.config
    tools: list[Any] = []

    tools.append(
        tool(
            "spawn-child",
            "Use this tool ONLY when the user's current request explicitly and affirmatively asks to "
            "create a 'child session' or 'child sessions' in a separate sandbox. DO NOT use it for "
            "'sub-agent', 'subagent', 'sub agent', 'sub-task', 'subtask', or Agent tool requests; use "
            "the Agent tool for those in-process delegations instead. Merely mentioning, comparing, or "
            "rejecting child sessions does not authorize this tool. Never infer permission or suggest "
            "creating a child session. The child inherits the repository, not conversation context, "
            "and continues running after the parent responds. Returns a child ID; check status only "
            "when its result is needed.",
            {
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        "description": "Short title describing the child session (shown in the UI).",
                    },
                    "prompt": {
                        "type": "string",
                        "description": "Detailed instructions for the child agent. Be specific — the child has no context beyond what you provide here.",
                    },
                    "model": {
                        "type": "string",
                        "description": "Override the LLM model for the child, in 'provider/model' format. Defaults to the parent's model. The child runs on the parent's harness, so only models that harness supports are accepted.",
                    },
                    "reasoning": {
                        "type": "string",
                        "description": "Override the reasoning effort for the child ('none', 'low', 'medium', 'high', 'xhigh', 'max'; use 'xhigh', not 'x-high'). Defaults to the parent's.",
                    },
                },
                "required": ["title", "prompt"],
            },
        )(handlers.spawn_child)
    )
    tools.append(
        tool(
            "send-child-prompt",
            "Queue a follow-up prompt for a direct child session you spawned earlier. Use it only when "
            "the child's work needs a correction or a next step; the prompt runs after any current "
            "child work. Use get-child-status when you need the result.",
            {
                "type": "object",
                "properties": {
                    "childId": {
                        "type": "string",
                        "description": "The child ID (from spawn-child or get-child-status).",
                    },
                    "prompt": {
                        "type": "string",
                        "description": "The follow-up instructions for the child.",
                    },
                },
                "required": ["childId", "prompt"],
            },
        )(handlers.send_child_prompt)
    )
    tools.append(
        tool(
            "cancel-child",
            "Cancel a running child session only when the user requests it or the work is clearly "
            "obsolete. Do not cancel because a child is slow, the parent is finished, or as cleanup. "
            "Nested children are cancelled by default. The child's sandbox will be stopped and its "
            "status set to cancelled.",
            {
                "type": "object",
                "properties": {
                    "childId": {
                        "type": "string",
                        "description": "The child ID to cancel (from spawn-child or get-child-status).",
                    },
                    "cancelNested": {
                        "type": "boolean",
                        "description": "Whether to also cancel all nested child sessions. Defaults to true.",
                    },
                },
                "required": ["childId"],
            },
        )(handlers.cancel_child)
    )
    tools.append(
        tool(
            "get-child-status",
            "Check child session status only when its result is needed; do not poll repeatedly. "
            "Without a childId, lists all child sessions with summary counts. With a childId, returns "
            "details. Set includeResponse to retrieve the child's final assistant response when "
            "available. Set includeTrajectory for a paginated persisted event trajectory.",
            {
                "type": "object",
                "properties": {
                    "childId": {
                        "type": "string",
                        "description": "Specific child ID to get details for. Omit to list all child sessions.",
                    },
                    "includeResponse": {
                        "type": "boolean",
                        "description": "Include the child's final assistant response when available.",
                    },
                    "includeTrajectory": {
                        "type": "boolean",
                        "description": "Include a persisted child event trajectory page.",
                    },
                    "trajectoryLimit": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 1000,
                        "description": "Maximum trajectory events to retrieve when includeTrajectory is true.",
                    },
                    "trajectoryCursor": {
                        "type": "string",
                        "description": "Cursor returned by a previous trajectory page.",
                    },
                    "includeEventData": {
                        "type": "boolean",
                        "description": "Include raw JSON payloads for each trajectory event.",
                    },
                },
            },
        )(handlers.get_child_status)
    )
    if config.has_repository:
        tools.append(
            tool(
                "create-pull-request",
                "Create a pull request for the committed changes. DO NOT use 'gh' CLI - use this tool "
                "instead. It handles git push and PR creation automatically with pre-configured "
                "authentication. You MUST provide a descriptive title and body that explain what changes "
                "were made. Call this after committing your changes. Calling it again from the same "
                "branch updates that branch's open pull request with your latest commits. To open a "
                "separate, additional pull request (including stacked PRs), create a new branch with "
                "'git checkout -b', commit, and call this tool again.",
                {
                    "type": "object",
                    "properties": {
                        "title": {
                            "type": "string",
                            "description": "Title of the pull request. Should be concise and descriptive of the changes made.",
                        },
                        "body": {
                            "type": "string",
                            "description": "Body/description of the pull request. Explain what changes were made and why. Use markdown formatting for clarity.",
                        },
                        "baseBranch": {
                            "type": "string",
                            "description": "Target branch to merge into. Defaults to the session's base branch. For a stacked pull request, pass the head branch of the pull request you are stacking on.",
                        },
                        "repo": {
                            "type": "string",
                            "description": 'Target repository as "owner/name". Required when the session spans multiple repositories; may be omitted for single-repository sessions.',
                        },
                        "draft": {
                            "type": "boolean",
                            "description": "Whether to open the pull request as a draft. Set to true only when the user explicitly asks for a draft; otherwise omit this field.",
                        },
                    },
                    "required": ["title", "body"],
                },
            )(handlers.create_pull_request)
        )
    if config.slack_notify_enabled:
        tools.append(
            tool(
                "slack-notify",
                "Post a message to a Slack channel that the user has authorized. Use this only when the "
                "user has explicitly asked you to notify Slack — this is an externally-visible action that "
                "other humans will see. The user must tell you which channel; do not guess. The bot must "
                "already be invited to the channel; if you get channel_not_found_or_forbidden, ask the user "
                "to invite the bot. Plain text + Slack mrkdwn formatting only. The server attaches the "
                "attribution footer and View Session button — do not fabricate them.",
                {
                    "type": "object",
                    "properties": {
                        "channel": {
                            "type": "string",
                            "description": "Target channel as either a channel ID (e.g. C01ABC) or the channel name as the user said it (e.g. ops or #ops).",
                        },
                        "text": {
                            "type": "string",
                            "description": "Message body. Plain text + Slack mrkdwn. No interactive elements.",
                        },
                        "thread_ts": {
                            "type": "string",
                            "description": "Optional Slack thread timestamp to reply within an existing thread.",
                        },
                        "reason": {
                            "type": "string",
                            "description": "Optional short note explaining why you are posting. Recorded server-side for audit; not shown in Slack.",
                        },
                    },
                    "required": ["channel", "text"],
                },
            )(handlers.slack_notify)
        )
    tools.append(
        tool(
            "upload-media",
            "Upload a screenshot (.png, .jpg, .jpeg, .webp), a video preview (H.264 .mp4, with "
            "artifactType 'video'), a self-contained HTML page (.html, with artifactType 'page') "
            "or any other file for the user to download (artifactType 'file': documents, archives, "
            "editing-app project files, masters in any codec, up to 4 GiB) from the sandbox "
            "filesystem so it appears in the session. Use it after making something you want the "
            "user to see or take away.",
            {
                "type": "object",
                "properties": {
                    "filePath": {
                        "type": "string",
                        "description": "Absolute path of the file to upload.",
                    },
                    "artifactType": {
                        "type": "string",
                        "enum": ["screenshot", "video", "page", "file"],
                        "description": "Defaults to screenshot; .mp4 previews require video, .html "
                        "files page; 'file' takes any file as a download.",
                    },
                    "name": {
                        "type": "string",
                        "description": "File only: the name it downloads under (defaults to the file's own).",
                    },
                    "kind": {
                        "type": "string",
                        "enum": ["file", "project"],
                        "description": "File only: 'project' marks a bundle of the whole project.",
                    },
                    "caption": {
                        "type": "string",
                        "description": "Caption shown with the media (required for video).",
                    },
                    "sourceUrl": {
                        "type": "string",
                        "description": "URL the media was captured from, if any.",
                    },
                    "endUrl": {
                        "type": "string",
                        "description": "URL at the end of a recording, if any.",
                    },
                    "fullPage": {"type": "boolean"},
                    "annotated": {"type": "boolean"},
                    "viewport": {
                        "type": "object",
                        "description": "Viewport size of a screenshot, in pixels.",
                        "properties": {
                            "width": {"type": "integer"},
                            "height": {"type": "integer"},
                        },
                        "required": ["width", "height"],
                    },
                    "durationMs": {"type": "integer", "description": "Video only (required)."},
                    "recordingStartedAt": {
                        "type": "integer",
                        "description": "Video only (required): epoch milliseconds.",
                    },
                    "recordingEndedAt": {
                        "type": "integer",
                        "description": "Video only (required): epoch milliseconds.",
                    },
                    "dimensions": {
                        "type": "object",
                        "description": "Video only (required): frame size in pixels.",
                        "properties": {
                            "width": {"type": "integer"},
                            "height": {"type": "integer"},
                        },
                        "required": ["width", "height"],
                    },
                    "truncated": {"type": "boolean", "description": "Video only."},
                    "hasAudio": {
                        "type": "boolean",
                        "description": "Video only. True when the MP4 has an audio track; it is kept and played.",
                    },
                },
                "required": ["filePath"],
            },
        )(handlers.upload_media)
    )
    tools.append(tool(ASK_USER_TOOL_NAME, ASK_USER_DESCRIPTION, ASK_USER_SCHEMA)(handlers.ask_user))
    tools.append(
        tool(NAME_PROJECT_TOOL_NAME, NAME_PROJECT_DESCRIPTION, NAME_PROJECT_SCHEMA)(
            handlers.name_project
        )
    )
    return tools


def build_tool_server(client: ControlPlaneToolClient) -> Any:
    """The SDK MCP server config for ``ClaudeAgentOptions.mcp_servers["oi"]``."""
    from claude_agent_sdk import create_sdk_mcp_server

    return create_sdk_mcp_server(
        name=OI_TOOL_SERVER_NAME, version="1.0.0", tools=build_tools(client)
    )
