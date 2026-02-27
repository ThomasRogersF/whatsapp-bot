# WhatsApp Screening Bot — Cloudflare Worker (Green-API)

A Cloudflare Worker that runs an 8-question WhatsApp screening flow via Green-API.
Candidates reply with numbered options; results are POSTed to a Make.com (or any) webhook on completion.

---

## Architecture

```
WhatsApp user
    │  (text reply)
    ▼
Green-API ──► POST /greenapi/webhook (Cloudflare Worker)
               │
               ├─ Returns HTTP 200 immediately
               │
               └─ ctx.waitUntil(processAndSend(...))
                      │
                      ├─ Rate-limit check (KV sliding window, 5/10 s)
                      ├─ Load/save session state (KV, TTL 7 days)
                      ├─ State machine Q1 → Q2 → … → Q8
                      │
                      ├─ Outbound question  ──► Green-API sendMessage API
                      │
                      └─ PASS/FAIL message  ──► Green-API sendMessage API
                              └─ POST result payload ──► MAKE_WEBHOOK_URL
```

---

## Screening Flow (Spanish, Q1–Q8)

| Step | Question | Options | Fail condition |
|------|----------|---------|----------------|
| Q1 | Team role? | 1=Sí / 2=No | Option 2 → fail |
| Q2 | Weekly availability? | 1=Full-time (30+h) / 2=Part-time (15–29h) / 3=<15h | Option 3, or option 2 when `MIN_WEEKLY_HOURS ≥ 30` → fail |
| Q3 | Start date? | 1=Immediately / 2=1–2 weeks / 3=1 month+ | None (always advances) |
| Q4 | Stable setup? | 1=Sí / 2=No | Option 2 → fail |
| Q5 | Follow SOP? | 1=Sí / 2=No | Option 2 → fail |
| Q6 | English level? | 1=Good / 2=Me defiendo / 3=Low | Option 3 → fail |
| Q7 | Age? | Numeric | Age ≥ 35 → fail |
| Q8 | Student types? | 1=Kids / 2=Teens / 3=Adults / 4=All | None (always passes) |

**Special commands (type at any time):**
- `PING` — responds "pong" (debug / connectivity check)
- `START` — begin a new screening session
- `RESTART` — clear session and restart from Q1

---

## Result Webhook Payload

On PASS or FAIL, the Worker POSTs to `MAKE_WEBHOOK_URL` (if set):

```json
{
  "whatsapp_from": "573001234567@c.us",
  "result": "pass",
  "reason": "",
  "answers": {
    "team_role": "yes",
    "weekly_availability": "full_time",
    "start_date": "now",
    "setup": "yes",
    "sop": "yes",
    "english_level": "good",
    "age": 28,
    "student_types": "adults"
  },
  "completed_at": "2026-01-15T10:30:00.000Z"
}
```

`reason` is empty on PASS. On FAIL it is one of:
`"not team role"` / `"low"` / `"no stable setup"` / `"not willing to follow SOP"` / `"english_low"` / `"age >= 35"`

---

## Environment Variables & Secrets

### `wrangler.toml` vars (non-sensitive, commit freely)

| Variable | Description | Default |
|----------|-------------|---------|
| `GREENAPI_ID_INSTANCE` | Your Green-API instance ID (numeric string from dashboard) | *(fill in)* |
| `MIN_WEEKLY_HOURS` | Minimum weekly hours for Q2 part-time acceptance | `"15"` |
| `MARIA_WA_ME_LINK` | URL shown to PASS candidates | *(set to your link)* |

### Secrets (set via `wrangler secret put`)

| Secret | Required | Description |
|--------|----------|-------------|
| `GREENAPI_API_TOKEN` | **Yes** | Green-API API token — found in the instance dashboard |
| `MAKE_WEBHOOK_URL` | No | Result webhook URL; omit to skip POSTing results |

---

## KV Namespace Keys

| Key pattern | Purpose | TTL |
|-------------|---------|-----|
| `wa:{phone}` | Per-user session state (e.g. `wa:573001234567`) | 7 days |
| `rl:{phone}` | Rate-limit timestamps (e.g. `rl:573001234567`) | 60 s |

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
wrangler secret put GREENAPI_API_TOKEN
wrangler secret put MAKE_WEBHOOK_URL      # optional
```

### 4. Update `wrangler.toml`

Edit the `[vars]` section:
```toml
GREENAPI_ID_INSTANCE = "1234567890"   # your instance ID
MARIA_WA_ME_LINK     = "https://wa.me/57xxxxxxxxxx?text=Hi%20Maria..."
MIN_WEEKLY_HOURS     = "15"
```

### 5. Deploy

```bash
npm run deploy
# or: wrangler deploy
```

### 6. Configure Green-API webhook

1. Log into [app.green-api.com](https://app.green-api.com) and open your instance.
2. Go to **Settings → Webhook settings** (Настройки → Вебхуки).
3. Set **Webhook URL** to:
   ```
   https://twilio-whatsapp-bot.<your-account>.workers.dev/greenapi/webhook
   ```
4. Enable **"Incoming messages"** (`incomingMessageReceived`) notifications only.
5. Save. Make sure the instance is connected (green status / QR code scanned).

### 7. Verify

```bash
wrangler tail   # stream live logs
```

Send `PING` to your WhatsApp number — you should receive `pong`.
Send `START` to begin the screening flow.

---

## Local Development

```bash
wrangler dev
```

Test with curl while `wrangler dev` is running:

```bash
curl -s -X POST http://localhost:8787/greenapi/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "typeWebhook": "incomingMessageReceived",
    "senderData": {
      "chatId": "573001234567@c.us",
      "chatName": "Test",
      "sender": "573001234567@c.us",
      "senderName": "Test"
    },
    "messageData": {
      "typeMessage": "textMessage",
      "textMessageData": { "textMessage": "START" }
    }
  }'
```

---

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Returns `ok` (health check) |
| `POST` | `/greenapi/webhook` | Green-API webhook — returns `ok` (200) immediately |
