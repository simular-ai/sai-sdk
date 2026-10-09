---
name: sai
description: Hand a task to Sai, a computer-use agent on a real Windows or macOS computer, over plain HTTP with curl and jq, and bring back the result.
---

# Sai over HTTP

Use this skill when the user asks to do something on a computer that this environment cannot do itself: open a desktop application, work in a browser with the user's accounts, read or produce files on their machine, or anything that needs a screen. Sai runs the task on the user's computer and returns text.

Do not use it for work that can be done locally in this repository.

If the `sai` MCP tools (`sai_task_start`, `sai_task_wait`, `sai_task_approve`) are available in this session, use them instead: they run the same loop below without shell commands. The HTTP steps here are for sessions without the MCP server.

## Prerequisites

- `SAI_API_KEY` is set in the environment. If it is not, stop and ask the user to create one at https://platform.simular.ai and export it. Never ask for the key value in chat.
- `SAI_API_URL` is optional. Default to `https://api.simular.ai`.
- `curl` and `jq` are on the path.

Every request carries `-H "Authorization: Bearer $SAI_API_KEY"`.

## The loop

Run these steps in order. Do not skip the poll.

1. **Start.** `POST /v1/agents/message` with `{"message": <task>, "wait": false}`. Read `sessionId` from the `202` body. Omit `machineId` unless the user named a computer or a previous `400` listed candidates.
2. **Poll.** `GET /v1/agents/events?sessionId=<id>&wait=30`, then repeat with `&since=<cursor>` from the last response. Print each `data-progress` text as a short progress line. Stop polling when `status` is not `running`.
3. **On `needs_approval`.** Read the top-level `approval` object in the poll response (same shape as a `data-approval-request` event's `data`) and check `approval.isLinkOnly`.
   - `false`: decide whether the action is what the user asked for. If yes, `POST /v1/agents/approve` with `{"approvalId": ..., "response": "yes"}`. Use `"response": "task"` when the same kind of request will repeat within this task. Use `"no"` when it is outside the task. For `approvalType: "choice"`, add `"selections"`, one inner array per question, using values from `questions[].options[].value`; if the answer is not obvious from the task, ask the user with AskUserQuestion first.
   - `true`: you cannot answer it. Call AskUserQuestion and hand the user `approval.approvalUrl` with one sentence saying what it is for (Google connect, a site password, phone verification). When they confirm they are done, go back to step 2 with the same cursor.
4. **On `idle`.** Report `text` to the user verbatim, then summarise if it is long.
5. **On `error`.** Report the `error` event's `errorText`. Do not retry automatically. If the event (or a `tool-output-error`) carries `code`, stop and do not start the task again today:
   - `insufficient_credits`: tell the user their credit is spent. Free plan: it refreshes at `resetsAt` (UTC midnight; convert to their local time). Paid plan: top up at https://platform.simular.ai. Call `GET /v1/agents/account` and include `plan.title` and `credits.usd` in the message.
   - `free_computer_time_exhausted`: tell the user the free plan's daily computer time is used up and the computer was shut down. It resets daily (exact local time in the Sai app); they can come back tomorrow or upgrade. No retry today.

To run a task on a specific model, add `"model": <id>` to the start body. Ids come from `GET /v1/agents/models` (`allowed: false` means not on this plan); `"auto"` is the default. The choice sticks to the session, so send it once.

A free account's first task of the day can stay in `running` for about two minutes while the computer starts. Keep polling.

## Rate limits and errors

- `429` on any call: wait 60 seconds and retry once. If it happens again, tell the user the account's hourly limit is reached (600 messages per hour on a paid plan, 60 on free; 1200 polls per hour) and stop. Never poll with `wait=0` in a loop.
- `400` on start with a `machines` array: several computers exist. Pick the one the user named, or ask with AskUserQuestion.
- `400 {"error":"unknown_model"}` or `403 {"error":"model_not_allowed_for_plan"}` on start: drop `model` or pick one from the `allowedModels` list in the reply.
- `403` on start: the `machineId` is not on this account. Call `GET /v1/agents/machines` and use one of the returned ids.
- `409` on start: the message was refused; report `error` to the user.
- `403` on poll: the `sessionId` is wrong or not this account's. Check the value you saved from the start response.
- `409 {"error":"link_only"}` on approve: treat as `isLinkOnly: true` and hand over `approvalUrl`.

## Cancelling

If the user cancels, or you decide the task should stop, call `POST /v1/agents/abort` with `{"sessionId": <id>}` using the session from the start response. Report `aborted` from the reply.

## Commands

Start a task and capture the session id:

```bash
SESSION=$(curl -sS "${SAI_API_URL:-https://api.simular.ai}/v1/agents/message" \
  -H "Authorization: Bearer $SAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg m "Open Notepad, type hello, save it to the desktop as hello.txt" '{message:$m, wait:false}')" \
  | tee /dev/stderr | jq -r .sessionId)
```

Poll once (repeat, feeding `cursor` back as `since`):

```bash
curl -sS "${SAI_API_URL:-https://api.simular.ai}/v1/agents/events?sessionId=$SESSION&since=$CURSOR&wait=30" \
  -H "Authorization: Bearer $SAI_API_KEY" \
  | jq '{status, cursor, text, approval, progress: [.events[] | select(.type=="data-progress") | .data.text]}'
```

Approve a command request:

```bash
curl -sS "${SAI_API_URL:-https://api.simular.ai}/v1/agents/approve" \
  -H "Authorization: Bearer $SAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg id "$APPROVAL_ID" '{approvalId:$id, response:"yes"}')"
```

Build JSON bodies with `jq -n` as above so user text with quotes never breaks the request.

## Reference

Full API documentation: https://platform.simular.ai/documentation. Endpoints used here: `POST /v1/agents/message`, `GET /v1/agents/events`, `POST /v1/agents/approve`, `POST /v1/agents/abort`, `GET /v1/agents/machines`, `GET /v1/agents/models`, `GET /v1/agents/account`.
