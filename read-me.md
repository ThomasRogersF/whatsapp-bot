# Twilio WhatsApp Screening Bot — Cloudflare Worker

A Cloudflare Worker that runs a 5-question WhatsApp screening flow via Twilio.
Candidates tap **quick-reply buttons** to answer; results are POSTed to a Make.com (or any) webhook on completion.

---

## Architecture

```
WhatsApp user
    │  (button tap or text)
    ▼
Twilio ──► POST /whatsapp (Cloudflare Worker)
               │
               ├─ Returns <Response/> immediately (HTTP 200 ack)
               │
               └─ ctx.waitUntil(processAndSend(...))
                      │
                      ├─ Rate-limit check (KV sliding window)
                      ├─ Parse ButtonPayload / ButtonText / Body
                      ├─ Load/save session state (KV, TTL 7 days)
                      ├─ State machine Q1 → Q2 → Q3 → Q4 → Q5
                      │
                      ├─ Outbound question  ──► Twilio Messages API (ContentSid)
                      │       └─ Content template (twilio/quick-reply, lazy-created, KV-cached 1 yr)
                      │
                      └─ PASS/FAIL text     ──► Twilio Messages API (plain Body)
                              └─ POST result payload ──► MAKE_WEBHOOK_URL
```

---

## Screening Flow

| Step | Question | Buttons | Payload IDs | Fail condition |
|------|----------|---------|-------------|----------------|
| Q1 | Team role? | Yes / No | `Q1_YES` / `Q1_NO` | `Q1_NO` → fail |
| Q2 | Weekly availability? | Full-time / Part-time / Less than 15 hrs | `Q2_FT` / `Q2_PT` / `Q2_LOW` | `Q2_LOW` or `Q2_PT` when `MIN_WEEKLY_HOURS ≥ 30` → fail |
| Q3 | Start date? | Immediately / 1–2 weeks / 1 month+ | `Q3_NOW` / `Q3_2W` / `Q3_1M` | None (always advances) |
| Q4 | Setup? | Yes / No | `Q4_YES` / `Q4_NO` | `Q4_NO` → fail |
| Q5 | Follow curriculum? | Yes / No | `Q5_YES` / `Q5_NO` | `Q5_NO` → fail |

**Keywords (type at any time):**
- `START` — begin a new screening session
- `RESTART` — clear session and restart from Q1

---

## Canonical Answer Values (stored in session)

| Field | Values |
|-------|--------|
| `q1_team_role` | `"yes"` \| `"no"` |
| `q2_availability` | `"full_time"` \| `"part_time"` \| `"low"` |
| `q3_start_date` | `"immediately"` \| `"1_2_weeks"` \| `"1_month_plus"` |
| `q4_setup` | `"yes"` \| `"no"` |
| `q5_curriculum` | `"yes"` \| `"no"` |

---

## Result Webhook Payload

On PASS or FAIL, the Worker POSTs to `MAKE_WEBHOOK_URL` (if set):

```json
{
  "whatsapp_from": "whatsapp:+15551234567",
  "result": "pass",
  "reason": "",
  "answers": {
    "q1_team_role": "yes",
    "q2_availability": "full_time",
    "q3_start_date": "immediately",
    "q4_setup": "yes",
    "q5_curriculum": "yes"
  },
  "completed_at": "2026-01-15T10:30:00.000Z"
}
```

`reason` is an empty string on PASS and one of the following on FAIL:
- `"Looking for marketplace/freelance work"`
- `"Insufficient weekly hours"`
- `"No suitable teaching setup"`
- `"Unwilling to follow curriculum"`

---

## Environment Variables & Secrets

### `wrangler.toml` vars (non-sensitive, commit freely)

| Variable | Description | Default |
|----------|-------------|---------|
| `MIN_WEEKLY_HOURS` | Minimum weekly hours for part-time acceptance | `"15"` |
| `TWILIO_WHATSAPP_FROM` | Twilio sender in `"whatsapp:+57xxx"` format | *(set to your number)* |
| `MARIA_WA_ME_LINK` | URL shown to PASS candidates | *(set to your link)* |

### Secrets (set via `wrangler secret put`)

| Secret | Required | Description |
|--------|----------|-------------|
| `TWILIO_ACCOUNT_SID` | **Yes** | Starts with `"AC..."` — Twilio Console dashboard |
| `TWILIO_AUTH_TOKEN` | **Yes** | Twilio Console dashboard |
| `MAKE_WEBHOOK_URL` | No | Result webhook URL; omit to skip POSTing results |

---

## KV Namespace Keys

| Key pattern | Purpose | TTL |
|-------------|---------|-----|
| `session:{from}` | Per-user session state | 7 days |
| `ratelimit:{from}` | Rate-limit timestamps | 60 s |
| `content_sid:{step}` | Cached Twilio Content template SID | 1 year |

Content templates (`content_sid:Q1` … `content_sid:Q5`) are created automatically via the Twilio Content API the first time each question is sent, then cached in KV for one year.  No manual template setup is required.

---

## Deployment

### 1. Prerequisites

```bash
npm install -g wrangler
wrangler login
```

### 2. Create KV namespaces

```bash
wrangler kv:namespace create BOT_KV
# copy the printed id → paste into wrangler.toml [[kv_namespaces]] id

wrangler kv:namespace create BOT_KV --preview
# copy the printed preview_id → paste into wrangler.toml preview_id
```

### 3. Set secrets

```bash
wrangler secret put TWILIO_ACCOUNT_SID
wrangler secret put TWILIO_AUTH_TOKEN
wrangler secret put MAKE_WEBHOOK_URL      # optional
```

### 4. Update `wrangler.toml`

Edit the `[vars]` section:
```toml
TWILIO_WHATSAPP_FROM = "whatsapp:+57xxxxxxxxxx"
MARIA_WA_ME_LINK     = "https://wa.me/57xxxxxxxxxx?text=Hi%20Maria..."
```

### 5. Deploy

```bash
npm run deploy
# or: wrangler deploy
```

### 6. Configure Twilio webhook

In the Twilio Console:

**For WhatsApp Sandbox (testing):**
Messaging → Try it out → Send a WhatsApp message → Sandbox Settings
Set **"A message comes in"** to:
```
https://twilio-whatsapp-bot.<your-account>.workers.dev/whatsapp
```
Method: **HTTP POST**

**For production (Messaging Service):**
Messaging → Services → `<your service>` → Integration
Set the inbound webhook URL as above.

### 7. Verify

```bash
wrangler tail   # stream live logs
```

Send `START` to your WhatsApp sandbox number.
On the first message, the Worker creates the 5 Content templates via the Twilio Content API and caches their SIDs.  All subsequent messages use the cached SIDs with no extra API calls.

---

## Local Development

```bash
wrangler dev
```

> **Note:** Interactive button testing requires a real Twilio webhook.
> Local dev mode can be used to verify health checks and basic request parsing, but you'll need `ngrok` (or similar) + the Twilio Sandbox pointed at your tunnel to test the full button flow.

---

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Returns `ok` (health check) |
| `POST` | `/whatsapp` | Twilio webhook — returns empty `<Response/>` immediately |
