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
| 409 | `conflict` | the record changed since you read it; `details.current` may carry the current record |
| 409 | `crm_not_set_up` | this organization's CRM is not set up yet |
| 409 | `machine_needs_update` / `route_missing` | the organization's agent machine needs an update, or no longer has this webhook |
| 422 | `invalid` | `details.fields` is `{field: ["message", …]}` |
| 429 | `rate_limited` | see `Retry-After` (seconds) |
| 502 | `agent_failed` | an agent could not do the job (breakdown only): `message` says why; nothing was saved |
| 503 | `crm_unavailable` | the CRM cannot be reached right now; see `Retry-After` (seconds) |
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

GET    /orgs/:org/crm/…                                  → CRM: pipelines, tags, search, deals, people, companies (see CRM)
GET    /orgs/:org/subscriptions[/:id]                    → {data:[sub…]} | {data:sub}; also POST, PATCH, DELETE, rotate_secret, ping (see Subscriptions)
GET    /orgs/:org/event_types                            → {data:["task.created", …]}
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

## CRM

Everything is under `/orgs/:org/crm`. Reading is open to any member; every write needs `operator`.
Responses carry `Cache-Control: no-store`. An unknown record id, or an organization you cannot see,
is the usual 404 `not_found`.

**Shapes grow.** The server may add fields to any object below over time. Clients must ignore fields
they do not know. Ids are opaque strings: store and send them back unchanged. Amounts are
whole-number strings (`"1200"`); send a number or a decimal string. Times are ISO 8601.

```
GET    /orgs/:org/crm/pipelines                              → {data:[pipeline]}
GET    /orgs/:org/crm/tags[?entity=deal|person|company]      → {data:["…"]}
GET    /orgs/:org/crm/search?q=…[&entity=deal|person|company] → {data:[{entity, id, label, sub}]}

GET    /orgs/:org/crm/deals[?pipeline&stage&status&q&owner&archived&sort&page] → {data:{deals:[row], total, page, per}}
GET    /orgs/:org/crm/deals/:id                              → {data:deal}
POST   /orgs/:org/crm/deals                {name, pipeline?, stage?, amount?, currency?, next_action?, owner?, company?, person?} → 201 {data:deal}
PATCH  /orgs/:org/crm/deals/:id            {name?, amount?, currency?, next_action?, lost_reason?, tags?, version?} → {data:deal}
POST   /orgs/:org/crm/deals/:id/move       {stage, from_stage?}                → {data:deal}
PUT    /orgs/:org/crm/deals/:id/owner      {owner: email|"me"|null, expected?} → {data:deal}
PUT    /orgs/:org/crm/deals/:id/company    {id} | {name, …}, expected?        → {data:deal}
PUT    /orgs/:org/crm/deals/:id/person     {id} | {full_name, …}, expected?   → {data:deal}
POST   /orgs/:org/crm/deals/:id/notes      {body}                             → 201 {data:deal}
POST   /orgs/:org/crm/deals/:id/tasks      {title, due_at?, assignee?}        → 201 {data:deal}
PATCH  /orgs/:org/crm/deals/:id/tasks/:task_id {done}                         → {data:deal}
POST   /orgs/:org/crm/deals/:id/archive    {archived}                         → {data:deal}

GET    /orgs/:org/crm/people[?q&sort&page&archived]          → {data:{people:[row], total, page, per}}
GET    /orgs/:org/crm/people/:id                             → {data:person}
POST   /orgs/:org/crm/people               {full_name, email?, phone?, job_title?, linkedin_url?, company?} → 201 {data:person}
PATCH  /orgs/:org/crm/people/:id           {full_name?, email?, phone?, job_title?, linkedin_url?, notes?, tags?, version?} → {data:person}
POST   /orgs/:org/crm/people/:id/archive   {archived}                         → {data:person}

GET    /orgs/:org/crm/companies[?q&sort&page&archived]       → {data:{companies:[row], total, page, per}}
GET    /orgs/:org/crm/companies/:id                          → {data:company}
POST   /orgs/:org/crm/companies            {name, domain?, website?, industry?, linkedin_url?, phone?, city?} → 201 {data:company}
PATCH  /orgs/:org/crm/companies/:id        {name?, domain?, website?, industry?, linkedin_url?, phone?, city?, notes?, tags?, version?} → {data:company}
POST   /orgs/:org/crm/companies/:id/archive {archived}                        → {data:company}
```

**Lists.** `page` starts at 1; `total`, `page` and `per` describe the page you got. Filters are strict: an
unknown `status` or `sort` is 422 with `fields.<param>`, not ignored. Deals take `status`
(`open`, `won`, `lost`), `stage` (a stage id, or `none`), `owner` (a member email, `me` or `none`) and
`archived` (`only` or `include`; archived records are left out by default). `stage` without `pipeline` is 422 (also on create). People and companies take `q`, `sort`,
`page` and `archived`. `search` needs a non-empty `q` and returns at most 5 results per entity (15 in all).

**Shapes.** A deal in a list is a row; fetching one returns the full deal.

```jsonc
// deal row
{ "id": "…", "name": "Acme renewal", "amount": "1200" | null, "currency": "USD" | null,
  "status": "open" | "won" | "lost" | null,
  "pipeline": {"id": "…" | null, "name": "…"} | null,
  "stage": {"id": "…", "name": "…", "kind": "…"} | null, "in_stage_since": "…" | null,
  "company_name": "…" | null, "person_name": "…" | null, "person_email": "…" | null,
  "owner_email": "…" | null, "next_action": "…" | null,
  "tags": ["…"], "archived": false, "updated_at": "…" }

// deal (GET/POST/PATCH and every deal action): the row's fields, except company_name,
// person_name and person_email, plus
{ "lost_reason": "…" | null, "created_at": "…", "version": "<opaque>", "pipeline_currencies": ["USD"],
  "company": {…company} | null, "person": {…person} | null,
  "stages": [{"id": "…", "name": "…", "kind": "…", "position": 0}],      // the deal's pipeline
  "history": [{"occurred_at": "…", "from_stage": "…", "to_stage": "…", "actor": "…", "note": "…"}],
  "notes": [{"id": "…", "author": "…", "body": "…", "created_at": "…"}], "notes_count": 0,
  "tasks": [{"id": "…", "title": "…", "status": "…", "due_at": "…" | null, "assignee": "…" | null}] }

// person
{ "id": "…", "full_name": "…", "email": "…" | null, "phone": "…" | null, "job_title": "…" | null,
  "linkedin_url": "…" | null, "notes": "…" | null, "company": {"id": "…", "name": "…"} | null,
  "tags": ["…"], "archived": false, "version": "<opaque>",   // version: single-record responses only
  "open_deals": 0 }

// company
{ "id": "…", "name": "…", "domain": "…" | null, "website": "…" | null, "industry": "…" | null,
  "linkedin_url": "…" | null, "phone": "…" | null, "city": "…" | null, "notes": "…" | null,
  "tags": ["…"], "archived": false, "version": "<opaque>", "open_deals": 0 }

// person and company, single-record responses also carry
"deals": [{"id": "…", "name": "…", "pipeline": "<pipeline id>", "stage": {"name": "…", "kind": "…"}, "status": "…", "amount": "…", "currency": "…"}]   // a stage ref has no id
// and a company also carries "people": [{"id": "…", "full_name": "…", "email": "…", "job_title": "…"}]

// pipeline (live pipelines and stages only)
{ "id": "…", "name": "…", "stages": [{"id": "…", "name": "…", "kind": "…", "position": 0}], "currencies": ["USD"] }

// search result
{ "entity": "deal" | "person" | "company", "id": "…", "label": "…", "sub": "…" }
```

The company and person nested in a deal are the core record: no `deals` or `people` list, but with `version` and `deal_count`.
List rows are narrower than the detail: company rows omit `website`, `linkedin_url`, `phone`, `notes` and `version`;
person rows omit `linkedin_url`, `notes`, `version` and `deal_count` (they have `open_deals`). No nested lists; a few counts
(`open_deals`, `open_value`, `currencies` on companies). `archived` is also given as `archived_at`.

**Writes.**

- **Strict bodies.** A key that is not in the lists above is 422 with `fields.<key>`: `is not allowed`.
  This differs from tasks on purpose: a typo must not silently drop data. A `PATCH` with none of the
  editable keys is 422 `fields.base`. Only the fields you send change.
- **`version` (optional).** Send the `version` you read. If the record changed since, the answer is 409
  `conflict`, and `details.current` may carry the current record. Omit it and the server uses the current
  version: last writer wins for the fields you sent. `move` takes `from_stage` and the owner, company and
  person routes take `expected` (the value you last saw) the same way: sent, a mismatch is 409 `conflict`;
  omitted, no check.
- **`tags`** replaces the whole list: at most 20, each at most 200 characters. There is no add/remove;
  read, change, write back. Sending `tags` together with other fields is two writes. If the second fails,
  the first stays.
- **Create.** `owner` defaults to the caller. `owner` and `assignee` accept a member's email
  (case-insensitive) or `"me"`; anything else is 422. `company` and `person` on a deal or person are either
  `{id}` of an existing record or the fields of a new one, not both. `pipeline` and `stage` are ids.
- **Move.** Moving a deal to the stage it is already in is a no-op 200.
- **Archive.** `archived: true` archives, `false` restores. Nothing is deleted through the API.

Task `done` is set by task id. Extra CRM errors: 409 `crm_not_set_up` (the organization has no CRM yet), 503 `crm_unavailable` (try again
after `Retry-After` seconds), 409 `conflict` (above), plus the existing 409 `machine_needs_update` and 503
`machine_not_ready`. A 422 for a duplicate carries `details.existing`. A 503 `machine_not_ready` after a write may carry
`details.saved` (true: the change may already be saved) and `details.id` (on create). When `saved` is true no
`Retry-After` is sent and you must not retry blindly: read the record first.

## Subscriptions

Subscriptions send task events to your URL ([Receiving events](#receiving-events)). **Every route here
needs `operator`, reads included**: a subscriber URL can itself be a secret. A member who is not an operator
gets 403 `forbidden`.

```
GET    /orgs/:org/subscriptions                       → {data:[sub]}
GET    /orgs/:org/subscriptions/:id                   → {data:sub}
POST   /orgs/:org/subscriptions  {name, url, events}  → 201 {data:sub, secret}
PATCH  /orgs/:org/subscriptions/:id {name?, url?, events?, active?} → {data:sub}
DELETE /orgs/:org/subscriptions/:id                   → 204
POST   /orgs/:org/subscriptions/:id/rotate_secret     → {data:sub, secret}
POST   /orgs/:org/subscriptions/:id/ping              → {data:{delivered, status, error}}
GET    /orgs/:org/event_types                         → {data:["task.created", …]}   (any member)
```

```jsonc
// sub
{ "id": "sub_…", "name": "…", "url": "https://…", "events": ["task.completed"], "active": true,
  "created_by": {"id": "u_12", "name": "…"} | null, "last_delivery_at": "…" | null,
  "last_delivery_status": 200 | 0 | null,    // 0: no HTTP answer (network error or timeout)
  "consecutive_failures": 0, "created_at": "…" }
```

- `events` is a non-empty list of types from `GET /event_types`, or `["*"]` for all of them. An unknown
  type is 422 `fields.events`. A `url` that is not `https`, or that points at a private address, is 422
  `fields.url`.
- At most 10 subscriptions per organization (422 `fields.base`).
- The `secret` is returned once, on create and on `rotate_secret`, and cannot be read again. Rotating
  replaces it; do not rely on the old secret still working.
- `ping` sends one `ping` event synchronously and makes a single attempt. It is delivered whatever `events`
  says and does not change `consecutive_failures`. The answer is `delivered` (a 2xx came back), the HTTP
  `status` (or `null`) and a short `error` string (or `null`).
- `PATCH` with `active: true` re-enables a subscription and resets `consecutive_failures` to 0.

## Receiving events

When a task on the weekly board changes (from the app, the API or an agent), Olympus sends a signed JSON
`POST` to the `url` of every active subscription that wants that event.

**Event types.**

| type | fires when |
|---|---|
| `task.created` | a task is added |
| `task.updated` | any change to an existing task: text, description, section, tags, flags, assignee, done, subtasks, delegation |
| `task.completed` | a task becomes done (also sends `task.updated`) |
| `task.reopened` | a done task is reopened (also sends `task.updated`) |
| `task.assigned` | the assignee changes (also sends `task.updated`) |
| `task.delegated` | a task is delegated to an agent (also sends `task.updated`) |
| `task.deleted` | a task is deleted |
| `ping` | only from the `ping` endpoint; always delivered |

The specific types are sent in addition to `task.updated`, so subscribe to what you want. Reordering alone
sends nothing. A change to a subtask is a `task.updated` of the parent task, with `changes.subtasks`. A
new week being filled in with carried-over tasks sends nothing. One write sends at most one event per
task and type, after it has been saved.

**Request.**

- `Content-Type: application/json`
- `User-Agent: Olympus-Webhooks/1`
- `X-Olympus-Event`: the event type.
- `X-Request-ID`: the event id (`evt_…`). The same on every retry of that event.
- `X-Webhook-Timestamp`: unix time in seconds, fresh on every attempt.
- `X-Webhook-Signature-V2`: hex HMAC-SHA256 of `<timestamp>.<raw body>`, keyed with the subscription's secret.

```jsonc
{ "id": "evt_…", "type": "task.completed", "created_at": "2026-10-12T15:04:05Z",
  "organization": {"slug": "acme"},
  "subscription": "sub_…",
  "actor": {"id": "u_12", "name": "Ann Lee", "kind": "user"} | null,   // null when unknown
  "week": "2026-10-12",
  "data": {
    "task": {…},      // the task item, as GET /orgs/:org/tasks/:id returns it; for task.deleted, its last state
    "changes": {"done": {"from": false, "to": true}}   // {field: {from, to}}; omitted on created and deleted
  } }
```

`changes` uses the API field names (`text`, `description`, `section`, `done`, `assignee` as a person id or
`null`, `tags`, `today`, `one_thing`, `delegated_to`). Subtask changes read
`"subtasks": {"added": [id…], "removed": [id…], "updated": [id…]}`. A `ping` has `data: {}`. The body is
UTF-8 JSON of at most 256 KB; if it would be larger, `description` fields are truncated to fit.

**Delivery.**

- One request per event and subscription. Timeouts: 5 s to connect, 10 s to read. Redirects are not
  followed; a 3xx counts as a failure. Any 2xx is success.
- Network errors, timeouts, 408, 429 and 5xx are retried, up to 6 attempts in all, with a growing delay
  (up to about an hour). Any other 4xx is not retried.
- Delivery is at-least-once: dedupe on `X-Request-ID`. Order is not guaranteed.
- After 20 failed events in a row the subscription is switched off (`active: false`). Re-enable it with
  `PATCH` `active: true`, which resets the counter. A success resets it too.
- URLs must be `https`. Private, loopback, link-local and cloud-metadata addresses are refused when sending.

**Verify every request** before trusting it: compute the HMAC over `<timestamp>.<raw body>` with your
secret, compare in constant time, and reject timestamps more than about 300 seconds from your clock. Use
the raw bytes you received, not re-serialised JSON.

```js
import { createHmac, timingSafeEqual } from "node:crypto";

// headers: lower-cased names (Node's req.headers); rawBody: the exact bytes received.
export function verify(secret, headers, rawBody, toleranceSeconds = 300) {
  const ts = headers["x-webhook-timestamp"];
  const sig = headers["x-webhook-signature-v2"] ?? "";
  if (!/^\d+$/.test(ts ?? "")) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > toleranceSeconds) return false;
  const want = createHmac("sha256", secret).update(`${ts}.`).update(rawBody).digest();
  const got = Buffer.from(sig, "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}
```
