// ─── Types ────────────────────────────────────────────────────────────────────

export interface Env {
  BOT_KV: KVNamespace;
  // Twilio credentials (secrets)
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  // Twilio sender number, e.g. "whatsapp:+57xxxxxxxxxx"
  TWILIO_WHATSAPP_FROM: string;
  // Optional
  MAKE_WEBHOOK_URL?: string;
  MARIA_WA_ME_LINK?: string;
  MIN_WEEKLY_HOURS?: string;
  CONTENT_LANGUAGE?: string;
}

type ScreeningStep = "Q1" | "Q2" | "Q3" | "Q4" | "Q5";

interface Answers {
  q1_team_role?: string;
  q2_availability?: string;
  q3_start_date?: string;
  q4_setup?: string;
  q5_curriculum?: string;
}

interface SessionState {
  step: ScreeningStep;
  answers: Answers;
  startedAt: string;
  lastActivityAt: string;
}

interface RateLimitRecord {
  timestamps: number[];
}

interface ResultPayload {
  whatsapp_from: string;
  result: "pass" | "fail";
  reason: string;
  answers: Answers;
  completed_at: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const SESSION_TTL_SECONDS = 604_800;   // 7 days
const CONTENT_SID_KV_TTL = 31_536_000; // 1 year — Content templates don't expire
const RATE_LIMIT_WINDOW_MS = 10_000;   // 10 seconds
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_KV_TTL = 60;          // 60 seconds (KV minimum)

// Button definitions for each question.
// WhatsApp via Twilio supports a maximum of 3 quick-reply buttons per message.
const QUESTION_CONTENT: Record<
  ScreeningStep,
  { body: string; actions: { title: string; id: string }[] }
> = {
  Q1: {
    body: "Q1/5 - Are you looking for a TEAM role (not marketplace/freelance like italki or Preply)?",
    actions: [
      { title: "Yes", id: "Q1_YES" },
      { title: "No", id: "Q1_NO" },
    ],
  },
  Q2: {
    body: "Q2/5 - What is your weekly availability?",
    actions: [
      { title: "Full-time (30+ hrs/wk)", id: "Q2_FT" },
      { title: "Part-time (15-29 hrs/wk)", id: "Q2_PT" },
      { title: "Less than 15 hrs/wk", id: "Q2_LOW" },
    ],
  },
  Q3: {
    body: "Q3/5 - When can you start?",
    actions: [
      { title: "Immediately", id: "Q3_NOW" },
      { title: "1-2 weeks", id: "Q3_2W" },
      { title: "1 month+", id: "Q3_1M" },
    ],
  },
  Q4: {
    body: "Q4/5 - Do you have a stable internet connection and a quiet teaching setup?",
    actions: [
      { title: "Yes", id: "Q4_YES" },
      { title: "No", id: "Q4_NO" },
    ],
  },
  Q5: {
    body: "Q5/5 - Are you willing to follow a set curriculum and SOPs?",
    actions: [
      { title: "Yes", id: "Q5_YES" },
      { title: "No", id: "Q5_NO" },
    ],
  },
};

// Plain-text fallback messages sent when the ContentSid quick-reply fails.
// Keywords listed here are also recognised as valid typed inputs in handleStep.
const QUESTION_FALLBACK: Record<ScreeningStep, string> = {
  Q1: "Q1/5: Looking for a TEAM role (not marketplace/freelance)? Reply YES or NO",
  Q2: "Q2/5: Weekly availability? Reply FULLTIME, PARTTIME, or LOW",
  Q3: "Q3/5: When can you start? Reply NOW, 2WEEKS, or 1MONTH",
  Q4: "Q4/5: Stable internet and quiet teaching setup? Reply YES or NO",
  Q5: "Q5/5: Willing to follow a set curriculum and SOPs? Reply YES or NO",
};

// ─── Text Sanitization ────────────────────────────────────────────────────────

// Replaces Unicode characters that can cause Twilio 63013 rendering failures:
//   em dash (U+2014) → hyphen
//   curly single quotes (U+2018/U+2019) → straight apostrophe
//   curly double quotes (U+201C/U+201D) → straight double quote
function sanitize(text: string): string {
  return text
    .replace(/\u2014/g, "-")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"');
}

// ─── KV Helpers ───────────────────────────────────────────────────────────────

async function safeKvGet(kv: KVNamespace, key: string): Promise<string | null> {
  try {
    return await kv.get(key);
  } catch (err) {
    console.error(`KV get failed for key "${key}":`, err);
    return null;
  }
}

async function safeKvPut(
  kv: KVNamespace,
  key: string,
  value: string,
  options?: KVNamespacePutOptions
): Promise<void> {
  try {
    await kv.put(key, value, options);
  } catch (err) {
    console.error(`KV put failed for key "${key}":`, err);
  }
}

async function safeKvDelete(kv: KVNamespace, key: string): Promise<void> {
  try {
    await kv.delete(key);
  } catch (err) {
    console.error(`KV delete failed for key "${key}":`, err);
  }
}

// ─── Session Helpers ──────────────────────────────────────────────────────────

function createSession(): SessionState {
  const now = new Date().toISOString();
  return { step: "Q1", answers: {}, startedAt: now, lastActivityAt: now };
}

async function loadSession(
  from: string,
  env: Env
): Promise<SessionState | null> {
  const raw = await safeKvGet(env.BOT_KV, `session:${from}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SessionState;
  } catch {
    return null;
  }
}

async function saveSession(
  from: string,
  session: SessionState,
  env: Env
): Promise<void> {
  session.lastActivityAt = new Date().toISOString();
  await safeKvPut(env.BOT_KV, `session:${from}`, JSON.stringify(session), {
    expirationTtl: SESSION_TTL_SECONDS,
  });
}

// ─── Rate Limiting ────────────────────────────────────────────────────────────

async function checkRateLimit(from: string, env: Env): Promise<boolean> {
  const key = `ratelimit:${from}`;
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;

  const raw = await safeKvGet(env.BOT_KV, key);
  const record: RateLimitRecord = raw
    ? (() => {
        try {
          return JSON.parse(raw) as RateLimitRecord;
        } catch {
          return { timestamps: [] };
        }
      })()
    : { timestamps: [] };

  record.timestamps = record.timestamps.filter((ts) => ts > windowStart);

  if (record.timestamps.length >= RATE_LIMIT_MAX) {
    return false;
  }

  record.timestamps.push(now);
  await safeKvPut(env.BOT_KV, key, JSON.stringify(record), {
    expirationTtl: RATE_LIMIT_KV_TTL,
  });
  return true;
}

// ─── TwiML Ack ────────────────────────────────────────────────────────────────

// Returns an empty TwiML <Response/> to acknowledge the webhook immediately.
// All outbound messages are sent via the Twilio REST API (see sendTwilioText /
// sendQuestion below) so Twilio does not wait for us to compose a reply.
function twimlAck(): Response {
  return new Response('<?xml version="1.0" encoding="UTF-8"?>\n<Response/>', {
    status: 200,
    headers: { "Content-Type": "text/xml; charset=utf-8" },
  });
}

// ─── Twilio REST API Helpers ──────────────────────────────────────────────────

function twilioBasicAuth(env: Env): string {
  return "Basic " + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`);
}

// Creates a twilio/quick-reply Content template and returns its ContentSid.
async function createContentTemplate(
  step: ScreeningStep,
  env: Env
): Promise<string> {
  const q = QUESTION_CONTENT[step];
  const language = env.CONTENT_LANGUAGE ?? "en";
  console.log(`[createContentTemplate] step=${step} language=${language}`);
  const body = JSON.stringify({
    friendly_name: `bot_${step.toLowerCase()}`,
    language,
    types: {
      "twilio/quick-reply": {
        body: sanitize(q.body),
        actions: q.actions.map((a) => ({ ...a, title: sanitize(a.title) })),
      },
    },
  });

  const res = await fetch("https://content.twilio.com/v1/Content", {
    method: "POST",
    headers: {
      Authorization: twilioBasicAuth(env),
      "Content-Type": "application/json",
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Content API error ${res.status} for step ${step}: ${text}`
    );
  }

  const data = (await res.json()) as { sid: string };
  console.log(`[createContentTemplate] step=${step} ContentSid=${data.sid}`);
  return data.sid;
}

// Returns the ContentSid for a question step, creating and caching it lazily.
// Always returns a valid SID — either from KV cache or freshly created via the
// Twilio Content API. Callers must always proceed to send after this returns.
async function getOrCreateContentSid(
  step: ScreeningStep,
  env: Env
): Promise<string> {
  const kvKey = `content_sid:${step}`;
  const cached = await safeKvGet(env.BOT_KV, kvKey);
  if (cached) {
    console.log(`[getOrCreateContentSid] step=${step} cache_hit sid=${cached}`);
    return cached;
  }

  const sid = await createContentTemplate(step, env);
  await safeKvPut(env.BOT_KV, kvKey, sid, {
    expirationTtl: CONTENT_SID_KV_TTL,
  });
  console.log(`[getOrCreateContentSid] step=${step} created sid=${sid}`);
  return sid;
}

// Sends a plain text WhatsApp message via the Twilio Messages REST API.
// Text is sanitized before sending to avoid 63013 rendering failures.
// Returns true on success, false on failure.
async function sendTwilioText(
  to: string,
  body: string,
  env: Env
): Promise<boolean> {
  const sanitized = sanitize(body);
  const url = `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`;
  const params = new URLSearchParams({
    To: to,
    From: env.TWILIO_WHATSAPP_FROM,
    Body: sanitized,
  });

  console.log(
    `[sendTwilioText] to=${to} from=${env.TWILIO_WHATSAPP_FROM} type=plain`
  );

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: twilioBasicAuth(env),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  if (res.ok) {
    const data = (await res.json()) as { sid: string };
    console.log(`[sendTwilioText] success MessageSid=${data.sid}`);
    return true;
  } else {
    const text = await res.text().catch(() => "");
    console.error(`[sendTwilioText] error status=${res.status} body=${text}`);
    return false;
  }
}

// Sends a WhatsApp message using a Twilio Content template (quick-reply buttons).
// Returns true on success, false on failure (caller may then send a plain fallback).
async function sendMessageWithContent(
  to: string,
  step: ScreeningStep,
  contentSid: string,
  env: Env
): Promise<boolean> {
  console.log(
    `[sendMessageWithContent] step=${step} type=content contentSid=${contentSid} to=${to} from=${env.TWILIO_WHATSAPP_FROM}`
  );

  const url = `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`;
  const params = new URLSearchParams({
    To: to,
    From: env.TWILIO_WHATSAPP_FROM,
    ContentSid: contentSid,
  });

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: twilioBasicAuth(env),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  if (res.ok) {
    const data = (await res.json()) as { sid: string };
    console.log(
      `[sendMessageWithContent] step=${step} success MessageSid=${data.sid}`
    );
    return true;
  } else {
    const text = await res.text().catch(() => "");
    console.error(
      `[sendMessageWithContent] step=${step} error status=${res.status} body=${text}`
    );
    return false;
  }
}

// Sends a question with quick-reply buttons.
// On non-2xx from the Messages API, immediately falls back to a plain-text
// message with typed-option instructions so the flow is never silently broken.
async function sendQuestion(
  to: string,
  step: ScreeningStep,
  env: Env
): Promise<void> {
  const contentSid = await getOrCreateContentSid(step, env);
  const ok = await sendMessageWithContent(to, step, contentSid, env);
  if (!ok) {
    console.warn(
      `[sendQuestion] step=${step} content send failed — sending plain-text fallback to=${to}`
    );
    await sendTwilioText(to, QUESTION_FALLBACK[step], env);
  }
}

// ─── Result Webhook ───────────────────────────────────────────────────────────

async function postResultWebhook(
  payload: ResultPayload,
  env: Env
): Promise<void> {
  if (!env.MAKE_WEBHOOK_URL) return;
  try {
    await fetch(env.MAKE_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error("Result webhook POST failed:", err);
  }
}

// ─── Bot Logic ────────────────────────────────────────────────────────────────

async function passSession(
  from: string,
  session: SessionState,
  env: Env
): Promise<void> {
  const payload: ResultPayload = {
    whatsapp_from: from,
    result: "pass",
    reason: "",
    answers: session.answers,
    completed_at: new Date().toISOString(),
  };

  await Promise.all([
    safeKvDelete(env.BOT_KV, `session:${from}`),
    postResultWebhook(payload, env),
  ]);

  const link = env.MARIA_WA_ME_LINK ?? "Please await further instructions.";
  await sendTwilioText(
    from,
    `You passed screening! Next step: ${link}`,
    env
  );
}

async function failSession(
  from: string,
  session: SessionState,
  reason: string,
  env: Env
): Promise<void> {
  const payload: ResultPayload = {
    whatsapp_from: from,
    result: "fail",
    reason,
    answers: session.answers,
    completed_at: new Date().toISOString(),
  };

  await Promise.all([
    safeKvDelete(env.BOT_KV, `session:${from}`),
    postResultWebhook(payload, env),
  ]);

  await sendTwilioText(
    from,
    `Thanks for your time - not the best fit right now. Reason: ${reason}`,
    env
  );
}

// Normalises the input to match known button payload IDs and text fallbacks.
// Returns a canonical string (payload ID or lowercase trimmed input) for switch matching.
function resolveInput(raw: string): string {
  // Already a known payload ID pattern (e.g. Q1_YES) — return as-is
  if (/^Q[1-5]_[A-Z0-9]+$/.test(raw)) return raw;
  return raw.toLowerCase();
}

async function handleStep(
  session: SessionState,
  rawInput: string,
  inputSource: "payload" | "buttonText" | "body",
  from: string,
  env: Env
): Promise<void> {
  const stepBefore = session.step;
  const minHours = parseInt(env.MIN_WEEKLY_HOURS ?? "15", 10);
  const input = resolveInput(rawInput);

  console.log(
    `[handleStep] from=${from} step.before=${stepBefore} inputSource=${inputSource} rawInput="${rawInput}"`
  );

  switch (session.step) {
    case "Q1": {
      // Accept: Q1_YES | yes | y | 1  /  Q1_NO | no | n | 2
      if (input === "Q1_YES" || input === "yes" || input === "y" || input === "1") {
        session.answers.q1_team_role = "yes";
        session.step = "Q2";
        console.log(`[handleStep] from=${from} step.after=${session.step}`);
        await saveSession(from, session, env);
        await sendQuestion(from, "Q2", env);
      } else if (input === "Q1_NO" || input === "no" || input === "n" || input === "2") {
        session.answers.q1_team_role = "no";
        await failSession(from, session, "Looking for marketplace/freelance work", env);
      } else {
        console.log(`[handleStep] from=${from} step=${stepBefore} unrecognised input — re-prompting`);
        await sendTwilioText(from, QUESTION_FALLBACK["Q1"], env);
      }
      return;
    }

    case "Q2": {
      // Accept: Q2_FT | fulltime | ft | 1 | starts-with "full"
      //         Q2_PT | parttime | pt | 2 | starts-with "part"
      //         Q2_LOW | low | <15 | 3 | starts-with "less"
      if (
        input === "Q2_FT" ||
        input === "fulltime" ||
        input === "ft" ||
        input === "1" ||
        input.startsWith("full")
      ) {
        session.answers.q2_availability = "full_time";
        session.step = "Q3";
        console.log(`[handleStep] from=${from} step.after=${session.step}`);
        await saveSession(from, session, env);
        await sendQuestion(from, "Q3", env);
      } else if (
        input === "Q2_PT" ||
        input === "parttime" ||
        input === "pt" ||
        input === "2" ||
        input.startsWith("part")
      ) {
        session.answers.q2_availability = "part_time";
        if (minHours >= 30) {
          await failSession(from, session, "Insufficient weekly hours", env);
        } else {
          session.step = "Q3";
          console.log(`[handleStep] from=${from} step.after=${session.step}`);
          await saveSession(from, session, env);
          await sendQuestion(from, "Q3", env);
        }
      } else if (
        input === "Q2_LOW" ||
        input === "low" ||
        input === "<15" ||
        input === "3" ||
        input.startsWith("less")
      ) {
        session.answers.q2_availability = "low";
        await failSession(from, session, "Insufficient weekly hours", env);
      } else {
        console.log(`[handleStep] from=${from} step=${stepBefore} unrecognised input — re-prompting`);
        await sendTwilioText(from, QUESTION_FALLBACK["Q2"], env);
      }
      return;
    }

    case "Q3": {
      // Accept: Q3_NOW | now | immediately | starts-with "imm" | 1
      //         Q3_2W  | 2weeks | soon | starts-with "1-2" | starts-with "1–2" | 2
      //         Q3_1M  | 1month | later | starts-with "1 month" | 3
      if (
        input === "Q3_NOW" ||
        input === "now" ||
        input === "immediately" ||
        input === "1" ||
        input.startsWith("imm")
      ) {
        session.answers.q3_start_date = "immediately";
        session.step = "Q4";
        console.log(`[handleStep] from=${from} step.after=${session.step}`);
        await saveSession(from, session, env);
        await sendQuestion(from, "Q4", env);
      } else if (
        input === "Q3_2W" ||
        input === "2weeks" ||
        input === "soon" ||
        input === "2" ||
        input.startsWith("1\u20132") ||
        input.startsWith("1-2")
      ) {
        session.answers.q3_start_date = "1_2_weeks";
        session.step = "Q4";
        console.log(`[handleStep] from=${from} step.after=${session.step}`);
        await saveSession(from, session, env);
        await sendQuestion(from, "Q4", env);
      } else if (
        input === "Q3_1M" ||
        input === "1month" ||
        input === "later" ||
        input === "3" ||
        input.startsWith("1 month")
      ) {
        session.answers.q3_start_date = "1_month_plus";
        session.step = "Q4";
        console.log(`[handleStep] from=${from} step.after=${session.step}`);
        await saveSession(from, session, env);
        await sendQuestion(from, "Q4", env);
      } else {
        console.log(`[handleStep] from=${from} step=${stepBefore} unrecognised input — re-prompting`);
        await sendTwilioText(from, QUESTION_FALLBACK["Q3"], env);
      }
      return;
    }

    case "Q4": {
      // Accept: Q4_YES | yes | y | 1  /  Q4_NO | no | n | 2
      if (input === "Q4_YES" || input === "yes" || input === "y" || input === "1") {
        session.answers.q4_setup = "yes";
        session.step = "Q5";
        console.log(`[handleStep] from=${from} step.after=${session.step}`);
        await saveSession(from, session, env);
        await sendQuestion(from, "Q5", env);
      } else if (input === "Q4_NO" || input === "no" || input === "n" || input === "2") {
        session.answers.q4_setup = "no";
        await failSession(from, session, "No suitable teaching setup", env);
      } else {
        console.log(`[handleStep] from=${from} step=${stepBefore} unrecognised input — re-prompting`);
        await sendTwilioText(from, QUESTION_FALLBACK["Q4"], env);
      }
      return;
    }

    case "Q5": {
      // Accept: Q5_YES | yes | y | 1  /  Q5_NO | no | n | 2
      if (input === "Q5_YES" || input === "yes" || input === "y" || input === "1") {
        session.answers.q5_curriculum = "yes";
        await passSession(from, session, env);
      } else if (input === "Q5_NO" || input === "no" || input === "n" || input === "2") {
        session.answers.q5_curriculum = "no";
        await failSession(from, session, "Unwilling to follow curriculum", env);
      } else {
        console.log(`[handleStep] from=${from} step=${stepBefore} unrecognised input — re-prompting`);
        await sendTwilioText(from, QUESTION_FALLBACK["Q5"], env);
      }
      return;
    }
  }
}

// processAndSend runs entirely inside ctx.waitUntil() — the webhook has already
// returned <Response/> before this executes. All user-facing output goes via
// sendTwilioText() or sendQuestion().
async function processAndSend(
  from: string,
  buttonPayload: string | null,
  buttonText: string | null,
  rawBody: string,
  env: Env
): Promise<void> {
  try {
    // Rate limit
    const allowed = await checkRateLimit(from, env);
    if (!allowed) {
      await sendTwilioText(
        from,
        "You're sending messages too quickly. Please wait a moment and try again.",
        env
      );
      return;
    }

    // Determine input source for logging and routing.
    // Priority: ButtonPayload > ButtonText > Body
    const inputSource: "payload" | "buttonText" | "body" = buttonPayload
      ? "payload"
      : buttonText
      ? "buttonText"
      : "body";
    const input = (buttonPayload || buttonText || rawBody).trim();
    const upper = input.toUpperCase();

    console.log(
      `[processAndSend] from=${from} inputSource=${inputSource} rawInput="${input}"`
    );

    // PING debug command — sends plain "pong" and logs the result
    if (upper === "PING") {
      console.log(`[PING] from=${from}`);
      await sendTwilioText(from, "pong", env);
      return;
    }

    // START and RESTART both clear the session and begin at Q1.
    // Handling them before loadSession ensures START always resets even when
    // a session is already in progress (fixes mid-flow resume bug).
    if (upper === "START" || upper === "RESTART") {
      console.log(`[processAndSend] from=${from} command=${upper} — resetting session`);
      await safeKvDelete(env.BOT_KV, `session:${from}`);
      const newSession = createSession();
      await saveSession(from, newSession, env);
      if (upper === "RESTART") {
        await sendTwilioText(from, "Session restarted. Here's Q1:", env);
      }
      await sendQuestion(from, "Q1", env);
      return;
    }

    // Load existing session
    const session = await loadSession(from, env);

    if (!session) {
      await sendTwilioText(
        from,
        "Hi! Reply START to begin the 2-minute screening.",
        env
      );
      return;
    }

    await handleStep(session, input, inputSource, from, env);
  } catch (err) {
    console.error("processAndSend error:", err);
    try {
      await sendTwilioText(
        from,
        "Something went wrong on our end. Reply RESTART to begin again.",
        env
      );
    } catch {
      // swallow — nothing more we can do
    }
  }
}

// ─── Request Handlers ─────────────────────────────────────────────────────────

async function handleWhatsApp(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const bodyText = await request.text();
  const params = new URLSearchParams(bodyText);

  const from = params.get("From") ?? "";
  // Twilio button reply params (see Twilio docs — ButtonPayload is preferred)
  const buttonPayload = params.get("ButtonPayload");
  const buttonText = params.get("ButtonText");
  const rawBody = params.get("Body") ?? "";

  if (!from) {
    // No sender — ack and log; we can't send an outbound message without a To
    console.error("Webhook received without From param");
    return twimlAck();
  }

  // Kick off all processing and outbound messaging asynchronously so Twilio
  // receives the HTTP 200 ack immediately without waiting for our logic.
  ctx.waitUntil(processAndSend(from, buttonPayload, buttonText, rawBody, env));

  return twimlAck();
}

async function handleRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const url = new URL(request.url);
  const { method } = request;
  const { pathname } = url;

  if (method === "GET" && pathname === "/health") {
    return new Response("ok", { status: 200 });
  }

  if (method === "POST" && pathname === "/whatsapp") {
    return handleWhatsApp(request, env, ctx);
  }

  return new Response("Not Found", { status: 404 });
}

// ─── Worker Export ────────────────────────────────────────────────────────────

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    try {
      return await handleRequest(request, env, ctx);
    } catch (err) {
      console.error("Unhandled error:", err);
      return twimlAck();
    }
  },
};
