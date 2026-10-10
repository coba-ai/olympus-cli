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
webhook id `wh_…`. The organization is part of the path.

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
| 503 | `machine_not_ready` | the agent machine is unreachable; nothing was saved |
| 503 | `machine_uncertain` | an update may have been half-applied on the machine; read the webhook again |

Limit: 60 requests per minute per token.

## Endpoints

```
GET    /me                          → {data:{user:{email}, memberships:[{org:{slug,name}, role}], token:{name, last4, organization}}}
GET    /orgs/:org/agents            → {data:[{profile_name, name, paused}]}

GET    /orgs/:org/webhooks          → {data:[{id, name, agent, full_tools, url, last_delivery_at, last_delivery_status, created_at}]}
GET    /orgs/:org/webhooks/:id      → {data:{…, instructions}}
POST   /orgs/:org/webhooks          {name, agent, instructions, full_tools?}  → 201 {data:{…}, secret}
PATCH  /orgs/:org/webhooks/:id      {name?, agent?, instructions?, full_tools?} → {data:{…}}
DELETE /orgs/:org/webhooks/:id      → 204
```

- `token.organization` is `{slug, name}` for a token limited to one organization, otherwise `null`.
  Such a token only sees that organization's membership.
- Roles are `operator` and `teammate`. Reading agents and listing webhooks is open to members;
  reading one webhook (its instructions) and every write need `operator`.
- `agent` is an agent's `profile_name`. `full_tools` defaults to `false`.
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
