// ─── Types ────────────────────────────────────────────────────────────────────

export interface Env {
  BOT_KV: KVNamespace;
  MAKE_WEBHOOK_URL?: string;
  MARIA_WHATSAPP_HANDOFF_TEXT?: string;
  MIN_WEEKLY_HOURS?: string;
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
  applicant_token: "";
  whatsapp_from: string;
  result: "pass" | "fail";
  reason: string;
  answers: Answers;
  completed_at: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const SESSION_TTL_SECONDS = 604800; // 7 days
const RATE_LIMIT_WINDOW_MS = 10_000; // 10 seconds
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_KV_TTL = 60; // 60 seconds (KV minimum)

const QUESTION_PROMPTS: Record<ScreeningStep, string> = {
  Q1: "Q1/5 — Are you looking for a TEAM role (not marketplace/freelance like italki or Preply)?\n1) Yes\n2) No",
  Q2: "Q2/5 — What is your weekly availability?\n1) Full-time (30+ hrs/wk)\n2) Part-time (15–29 hrs/wk)\n3) Less than 15 hrs/wk",
  Q3: "Q3/5 — When can you start?\n1) Immediately\n2) 1–2 weeks\n3) 1 month+",
  Q4: "Q4/5 — Do you have a stable internet connection and a quiet teaching setup?\n1) Yes\n2) No",
  Q5: "Q5/5 — Are you willing to follow a set curriculum and SOPs?\n1) Yes\n2) No",
};

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
  return {
    step: "Q1",
    answers: {},
    startedAt: now,
    lastActivityAt: now,
  };
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

  // Prune timestamps outside the sliding window
  record.timestamps = record.timestamps.filter((ts) => ts > windowStart);

  if (record.timestamps.length >= RATE_LIMIT_MAX) {
    // Rate limited — do not record this attempt
    return false;
  }

  record.timestamps.push(now);
  await safeKvPut(env.BOT_KV, key, JSON.stringify(record), {
    expirationTtl: RATE_LIMIT_KV_TTL,
  });
  return true;
}

// ─── TwiML ────────────────────────────────────────────────────────────────────

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function twimlResponse(message: string): Response {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${escapeXml(message)}</Message>\n</Response>`;
  return new Response(xml, {
    status: 200,
    headers: { "Content-Type": "text/xml; charset=utf-8" },
  });
}

// ─── Result Webhook ───────────────────────────────────────────────────────────

function postResultWebhook(payload: ResultPayload, env: Env): Promise<void> {
  if (!env.MAKE_WEBHOOK_URL) return Promise.resolve();
  return fetch(env.MAKE_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  })
    .then(() => undefined)
    .catch((err) => {
      console.error("Result webhook POST failed:", err);
    });
}

// ─── Bot Logic ────────────────────────────────────────────────────────────────

async function passSession(
  from: string,
  session: SessionState,
  env: Env,
  ctx: ExecutionContext
): Promise<string> {
  const payload: ResultPayload = {
    applicant_token: "",
    whatsapp_from: from,
    result: "pass",
    reason: "",
    answers: session.answers,
    completed_at: new Date().toISOString(),
  };

  await safeKvDelete(env.BOT_KV, `session:${from}`);
  ctx.waitUntil(postResultWebhook(payload, env));

  const handoff =
    env.MARIA_WHATSAPP_HANDOFF_TEXT ?? "Please await further instructions.";
  return `\u2705 You passed screening. Next step: ${handoff}`;
}

async function failSession(
  from: string,
  session: SessionState,
  reason: string,
  env: Env,
  ctx: ExecutionContext
): Promise<string> {
  const payload: ResultPayload = {
    applicant_token: "",
    whatsapp_from: from,
    result: "fail",
    reason,
    answers: session.answers,
    completed_at: new Date().toISOString(),
  };

  await safeKvDelete(env.BOT_KV, `session:${from}`);
  ctx.waitUntil(postResultWebhook(payload, env));

  return `Thanks for your time \u2014 not the best fit right now. Reason: ${reason}`;
}

async function handleStep(
  session: SessionState,
  input: string,
  from: string,
  env: Env,
  ctx: ExecutionContext
): Promise<string> {
  const minHours = parseInt(env.MIN_WEEKLY_HOURS ?? "15", 10);

  switch (session.step) {
    case "Q1": {
      if (input === "1") {
        session.answers.q1_team_role = "Yes";
        session.step = "Q2";
        await saveSession(from, session, env);
        return QUESTION_PROMPTS.Q2;
      }
      if (input === "2") {
        session.answers.q1_team_role = "No";
        return failSession(
          from,
          session,
          "Looking for marketplace/freelance work",
          env,
          ctx
        );
      }
      return `Please reply with 1 or 2.\n\n${QUESTION_PROMPTS.Q1}`;
    }

    case "Q2": {
      if (input === "1") {
        session.answers.q2_availability = "Full-time (30+ hrs/wk)";
        session.step = "Q3";
        await saveSession(from, session, env);
        return QUESTION_PROMPTS.Q3;
      }
      if (input === "2") {
        session.answers.q2_availability = "Part-time (15\u201329 hrs/wk)";
        if (minHours >= 30) {
          return failSession(
            from,
            session,
            "Insufficient weekly hours",
            env,
            ctx
          );
        }
        session.step = "Q3";
        await saveSession(from, session, env);
        return QUESTION_PROMPTS.Q3;
      }
      if (input === "3") {
        session.answers.q2_availability = "Less than 15 hrs/wk";
        return failSession(
          from,
          session,
          "Insufficient weekly hours",
          env,
          ctx
        );
      }
      return `Please reply with 1, 2, or 3.\n\n${QUESTION_PROMPTS.Q2}`;
    }

    case "Q3": {
      const q3Map: Record<string, string> = {
        "1": "Immediately",
        "2": "1\u20132 weeks",
        "3": "1 month+",
      };
      const q3Answer = q3Map[input];
      if (q3Answer) {
        session.answers.q3_start_date = q3Answer;
        session.step = "Q4";
        await saveSession(from, session, env);
        return QUESTION_PROMPTS.Q4;
      }
      return `Please reply with 1, 2, or 3.\n\n${QUESTION_PROMPTS.Q3}`;
    }

    case "Q4": {
      if (input === "1") {
        session.answers.q4_setup = "Yes";
        session.step = "Q5";
        await saveSession(from, session, env);
        return QUESTION_PROMPTS.Q5;
      }
      if (input === "2") {
        session.answers.q4_setup = "No";
        return failSession(
          from,
          session,
          "No suitable teaching setup",
          env,
          ctx
        );
      }
      return `Please reply with 1 or 2.\n\n${QUESTION_PROMPTS.Q4}`;
    }

    case "Q5": {
      if (input === "1") {
        session.answers.q5_curriculum = "Yes";
        return passSession(from, session, env, ctx);
      }
      if (input === "2") {
        session.answers.q5_curriculum = "No";
        return failSession(
          from,
          session,
          "Unwilling to follow curriculum",
          env,
          ctx
        );
      }
      return `Please reply with 1 or 2.\n\n${QUESTION_PROMPTS.Q5}`;
    }

    default:
      return "Hi! Reply START to begin the 2-minute screening.";
  }
}

async function processMessage(
  from: string,
  body: string,
  env: Env,
  ctx: ExecutionContext
): Promise<string> {
  const trimmed = body.trim();
  const upper = trimmed.toUpperCase();

  // RESTART is always available regardless of session state
  if (upper === "RESTART") {
    await safeKvDelete(env.BOT_KV, `session:${from}`);
    const session = createSession();
    await saveSession(from, session, env);
    return `Session restarted.\n\n${QUESTION_PROMPTS.Q1}`;
  }

  // Load existing session
  const session = await loadSession(from, env);

  if (!session) {
    if (upper.includes("START")) {
      const newSession = createSession();
      await saveSession(from, newSession, env);
      return QUESTION_PROMPTS.Q1;
    }
    return "Hi! Reply START to begin the 2-minute screening.";
  }

  return handleStep(session, trimmed, from, env, ctx);
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
  const rawBody = params.get("Body") ?? "";

  if (!from) {
    return twimlResponse(
      "Sorry, something went wrong. Please try again."
    );
  }

  // Rate limit check
  const allowed = await checkRateLimit(from, env);
  if (!allowed) {
    return twimlResponse(
      "You\u2019re sending messages too quickly. Please wait a moment and try again."
    );
  }

  const reply = await processMessage(from, rawBody, env, ctx);
  return twimlResponse(reply);
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
      return twimlResponse(
        "Sorry, something went wrong. Reply RESTART to begin again, or try again later."
      );
    }
  },
};
