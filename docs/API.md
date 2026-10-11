# Olympus API v1

Base URL: `https://app.tryolympus.ai/api/v1`. JSON in, JSON out.

Do not follow redirects while sending an `Authorization` header. `https://tryolympus.ai` redirects
to `app.`; treat any 3xx from the API as a configuration error.

## Authentication

```
Authorization: Bearer oly_…
```

A token acts as the person who created it, with their role in each organization. It can be
limited to one organization when it is created. Get one with `olympus login` (device flow below)
or in the app under **Settings → API tokens**; the value is shown once. Revoke it on the same page.

## Responses

Success bodies are `{"data": …}`. Ids are strings: organization slug, agent `profile_name`,
webhook id `wh_…`, task id `t` + 7 base36 characters, subtask id `s` + 7. The organization is part of the path.

Errors are `{"error": {"code": "…", "message": "…", "details": {…}}}` (`details` only when there is something in it).

| HTTP | code | meaning |
|---|---|---|
| 400 | `bad_request` | malformed JSON body |
| 401 | `unauthorized` | missing, malformed or unknown token |
| 403 | `forbidden` | your role cannot do this |
| 404 | `not_found` | not found, or an organization you cannot see (also: a token limited to another organization) |
| 409 | `machine_needs_update` / `route_missing` | the organization's agent machine needs an update, or no longer has this webhook |
| 422 | `invalid` | `details.fields` is `{field: ["message", …]}` |
| 429 | `rate_limited` | see `Retry-After` (seconds) |
| 502 | `agent_failed` | an agent could not do the job (breakdown only): `message` says why; nothing was saved |
| 503 | `machine_not_ready` | the agent machine is unreachable or not connected; nothing was saved |
| 503 | `machine_uncertain` | an update may have been half-applied on the machine; read the webhook again |

Limit: 60 requests per minute per token.

## Endpoints

```
GET    /me                          → {data:{user:{email}, memberships:[{org:{slug,name}, role}], token:{name, last4, organization}}}
GET    /orgs/:org/agents            → {data:[{profile_name, name, paused, primary?, role_line?, created_at?}]}

GET    /orgs/:org/webhooks          → {data:[{id, name, agent, full_tools, url, last_delivery_at, last_delivery_status, created_at}]}
GET    /orgs/:org/webhooks/:id      → {data:{…, instructions}}
POST   /orgs/:org/webhooks          {name, agent, instructions, full_tools?}  → 201 {data:{…}, secret}
PATCH  /orgs/:org/webhooks/:id      {name?, agent?, instructions?, full_tools?} → {data:{…}}
DELETE /orgs/:org/webhooks/:id      → 204

GET    /orgs/:org/people            → {data:[{id, name, kind:"user"|"agent", email?, paused?, me}]}
GET    /orgs/:org/tags              → {data:["pricing","urgent",…]}

GET    /orgs/:org/tasks[?week]                           → {data:{week, current, version, me, tasks:[item…]}}
GET    /orgs/:org/tasks/:id[?week]                       → {data:item}
POST   /orgs/:org/tasks[?week]                           {text, description?, assignee?, section?, tags?, today?, one_thing?} → 201 {data:item}
PATCH  /orgs/:org/tasks/:id[?week]                       {text?, description?, assignee?, section?, tags?, add_tags?, remove_tags?, done?, today?, one_thing?} → {data:item}
DELETE /orgs/:org/tasks/:id[?week]                       → 204
POST   /orgs/:org/tasks/:id/subtasks[?week]              {text, assignee?} → 201 {data:item}
PATCH  /orgs/:org/tasks/:id/subtasks/:sid[?week]         {text?, done?, assignee?, today?} → {data:item}
DELETE /orgs/:org/tasks/:id/subtasks/:sid[?week]         → {data:item}
POST   /orgs/:org/tasks/:id/delegate[?week]              {agent?} → 201 {data:{task:item, session:{id, title, agent, url}}}
POST   /orgs/:org/tasks/:id/breakdown[?week]             {agent?} → {data:{task:item, agent, added:[subtask…]}}

GET    /orgs/:org/days[?week]                            → {data:{week, days:[{day, closed, closed_at, score, entry}]}}
GET    /orgs/:org/days/:day                              → {data:{day, closed, closed_at, score, entry|null}}
PUT    /orgs/:org/days/:day                              {shipped?, blockers?, learnings?, reflection?, close?} → {data:{…as GET…}}
```

- `token.organization` is `{slug, name}` for a token limited to one organization, otherwise `null`.
  Such a token only sees that organization's membership.
- Roles are `operator` and `teammate`. Reading agents and listing webhooks is open to members;
  reading one webhook (its instructions) and every write need `operator`.
- `agent` is an agent's `profile_name`. `full_tools` defaults to `false`.
- `primary`, `role_line` and `created_at` on agents are newer servers only; an absent field means unknown.
- The webhook `secret` is returned once, on create, and cannot be read again.

## Device login

How `olympus login` gets a token without a password ([RFC 8628](https://www.rfc-editor.org/rfc/rfc8628) shape). Neither call needs a token.

```
POST /device/code   {client_name?}  → {device_code, user_code:"ABCD-EFGH", verification_uri, verification_uri_complete, expires_in, interval}
POST /device/token  {device_code}   → 400 {"error":{"code":"authorization_pending" | "slow_down" | "expired_token" | "access_denied"}}
                                    → 200 {data:{token:"oly_…"}}
```

`/device/code` answers at the top level, not under `data`. Show `user_code`, send the person to
`verification_uri_complete`, and poll `/device/token` every `interval` seconds (add 5 on
`slow_down`) until it returns the token, which happens once. Stop at `expires_in`.

## Delivering to a webhook

`POST` to the webhook's `url` with:

- `Content-Type: application/json`
- `X-Webhook-Timestamp`: current unix time in seconds; more than 300 seconds off is rejected.
- `X-Webhook-Signature-V2`: hex HMAC-SHA256 of `<timestamp>.<raw body>`, keyed with the secret.
- `X-Request-ID`: unique per event. To retry, sign again with a fresh timestamp and resend the same id.

```sh
TS=$(date +%s)
BODY='{"event":"example"}'
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" -hex | sed 's/^.* //')
curl -X POST "$WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Timestamp: $TS" \
  -H "X-Webhook-Signature-V2: $SIG" \
  -H "X-Request-ID: $(uuidgen)" \
  --data "$BODY"
```

## Tasks

Any member of the organization, `teammate` included, can read and write tasks; there is no role gate.
Every `people` and tasks response carries `Cache-Control: no-store`. An unknown task or subtask id (in
that week) is a 404 `not_found`.

**People.** Members first (by name; `kind:"user"`, `id:"u_<n>"`, `email`), then every agent, the primary
first (`kind:"agent"`, `id` is the `profile_name`, `paused`). `me:true` is on your own row only.
**Tags.** `GET /tags` returns the organization's tags across all weeks, most used first, at most 50.

**Week.** Tasks live in weeks. `?week=YYYY-MM-DD` works on every tasks route; any date is accepted and
normalised to that week's Monday (the response's `week`). Without it you get the current week. A
malformed value is 422 with `fields.week`. Reading a week that has no tasks returns `version:0,
tasks:[]` and stores nothing; writing to it creates it. `current` says whether `week` is the current
week; `me` is your person id. `tasks` is in board order: the starred (`one_thing`) task first, then
`the_rest`, then `backlog`, each by `order` then id.

**Item.**

```jsonc
{
  "id": "t8f3k2a", "text": "Ship the pricing page", "description": "",
  "section": "the_rest",          // "the_rest" | "backlog"; older tasks may read "one_thing"
  "order": 0, "done": false, "done_at": null,       // done_at: ISO 8601 or null
  "assignee": {"id": "u_12", "name": "Abraham Kuri", "kind": "user"} | null,
                                  // an id that no longer exists reads {"id":"u_9","name":null,"kind":null}
  "tags": ["pricing"],
  "today": false,                 // flagged for today
  "one_thing": false,             // starred: the person's one thing for the day
  "added_on": "2026-10-05" | null,
  "delegated_to": null, "delegated_at": null,       // read-only
  "subtasks": [{"id": "s1x2y3z", "text": "…", "done": false, "done_at": null,
                "assignee": {…} | null, "today": false, "order": 0}]
}
```

A new task is `done:false`, with no tags or subtasks unless given, at the end of its section; a new
subtask goes at the end of its parent's list. Subtask routes (POST answers 201) return the **parent**
item, including after a subtask is deleted. Task `DELETE` answers 204 with no body.

**Input rules.** Types are strict, and every failure is 422 `invalid` with `details.fields`. Unknown body
keys are ignored.

- `text`, `description`, `section` are strings. `text` is required and non-blank on create, and
  non-blank when present on update.
- `section` accepts `the_rest` or `backlog`; moving a task puts it at the end of the new section.
- `tags` is an array of strings (trimmed, blanks dropped, duplicates removed, order kept) and replaces
  the list. `add_tags` / `remove_tags` (same shape) edit it instead, so concurrent edits never drop each
  other's tags. Sending `tags` together with either is 422 `fields.tags`. Tags are exact strings
  (`Urgent` is not `urgent`).
- `done`, `today`, `one_thing` are JSON booleans. `done:true` sets `done_at` to now; `false` clears it.
  Repeating either is fine.
- `assignee` is a string, or `null` to unassign: `"me"`, a person id (`"u_12"`, `"zeus"`) or a member's
  email (case-insensitive). Anything that matches nobody in the organization is 422 `fields.assignee`
  (`must be a member or agent of this organization`); a paused agent is `is paused`.
- `today:true` flags the item for today. Refused with 422 `fields.today` when the week is not the
  current week, or when the owner is a person (or unassigned) who already has 3 items flagged today,
  counting tasks and subtasks. Agents have no cap. `today:false` removes the flag.
- `one_thing:true` stars the task as its assignee's one thing for the day. Refused with 422
  `fields.one_thing` when the week is not the current week, the task has no assignee, or that person
  already has a one thing that day (the message names the other task). `one_thing:false` removes it; a
  task with the older `one_thing` section moves to the end of `the_rest`.
- Every write bumps the week's `version`.
- Subtasks take `text`, `done`, `assignee` and `today` with the same rules.

## Agents on tasks

`POST /tasks/:id/delegate` and `POST /tasks/:id/breakdown` start an agent session, so they need a role
that may start one (members who can do so from the app); anyone else gets 403. Reading the task is
also required, and an unknown task id (in that week) is 404. `?week` selects the week the task id
belongs to.

`agent` (optional) is an agent's `profile_name`. Without it the task's assignee is used if it is an
active agent, otherwise the organization's primary agent. An unknown or paused agent, or an
organization with no agent at all, is 422 `fields.agent`.

**Delegate.** Opens a new session for the agent, seeded with the stored task's text and description
(the body cannot supply them), then records on the task `delegated_to` and `delegated_at`. The answer is
201 with the updated `task` and the `session`: `id`, `title` (a string or `null` while it is untitled),
`agent` (a display string; do not parse it) and `url` (an absolute link to the session). Calling it again
opens another session. The session is opened before it is recorded on the task: if the task is deleted
in between you get 404 and the session still exists.

**Breakdown.** Asks the agent for subtasks and appends them, up to 5 per task, then returns the updated
`task`, the agent's display name in `agent`, and `added`, the new subtask items in order. The request is
synchronous and can take up to about 90 seconds, so clients should allow at least 90 s (the CLI waits
100 s). Errors, none of which saves anything: 422 `fields.subtasks` when the task already has 5; 422
`fields.agent`; 503 `machine_not_ready` when the agent machine is not connected or unreachable; and
502 `agent_failed` when the agent's reply was unusable, too slow or refused, with a human-readable
`message`. If a client gives up waiting, the subtasks may still land; read the task to find out.

## Days (close of day)

A day is a weekday, `YYYY-MM-DD`, Monday to Friday; anything malformed or on a weekend is 422
`fields.day`. These routes only ever show and change **your own** entries, never a teammate's.
`?week` on `GET /days` works as for tasks (any date, normalised to Monday; malformed is 422
`fields.week`). Responses carry `Cache-Control: no-store`.

`GET /days` returns the week's five weekdays in order. `closed` is true once the entry has been closed
(`closed_at` is then an ISO 8601 time); `score` is the stored score or `null`. A day with nothing saved
has `entry:null`, `closed:false`, `closed_at:null`, `score:null`.

```jsonc
"entry": {
  "shipped": "…", "reflection": "…",
  "blockers":  [{"id": "b1", "text": "…"}],
  "learnings": [{"id": "l1", "text": "…"}],
  "summary": {"tasks_created": 0, "tasks_done": 0, "one_thing_progress": …, "learnings": 0,
              "allocation": [{"tag": "pricing", "count": 2}]},
  "agent_note": null,             // string once the agent has written one
  "week_close": false
}
```

`PUT /days/:day` saves the entry and answers with the same shape as `GET /days/:day`.

- **Merge.** Keys you do not send keep their stored value. `blockers` and `learnings` are arrays of
  strings that **replace** the stored list (ids are assigned `b1…` / `l1…` in order). `shipped` and
  `reflection` are strings.
- **`close`** is a boolean, default `true`: the entry is marked closed and `closed_at` is set.
  `close:false` saves a draft and leaves `closed_at` as it was; the response's `closed` says whether the day is closed.
- **Read-only.** `summary`, `score` and `agent_note` are computed by the server; they cannot be set
  through this endpoint. Closing a week is not available through the API.
- Types are strict; a wrong type is 422 on that field.
