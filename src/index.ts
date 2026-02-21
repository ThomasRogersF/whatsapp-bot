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
}

type ScreeningStep = "Q1" | "Q2" | "Q3" | "Q4" | "Q5" | "Q6" | "Q7" | "Q8";

interface Answers {
  team_role?: "yes" | "no";
  weekly_availability?: "full_time" | "part_time" | "low";
  start_date?: "now" | "soon" | "later";
  setup?: "yes" | "no";
  sop?: "yes" | "no";
  english_level?: "good" | "ok" | "low";
  age?: number;
  student_types?: "kids" | "teens" | "adults" | "all";
}

interface SessionState {
  step: ScreeningStep;
  answers: Answers;
  startedAt: string;
  lastActivityAt: string;
  completed?: boolean;
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
const RATE_LIMIT_WINDOW_MS = 10_000;   // 10 seconds
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_KV_TTL = 60;          // 60 seconds (KV minimum)

const QUESTION_TEXT: Record<ScreeningStep, string> = {
  Q1: "*Q1/8* \uD83E\uDDE9\nEn SpanishVIP buscamos un rol de *equipo* (no estilo marketplace).\n\u00BFBuscas un rol fijo y comprometido con el equipo?\n1) \u2705 S\u00ED\n2) \u274C No",
  Q2: "*Q2/8* \uD83D\uDDD3\uFE0F\n\u00BFCu\u00E1ntas horas por semana puedes comprometerte de forma constante?\n1) \uD83D\uDCAA Tiempo completo (30+ hrs/sem)\n2) \uD83D\uDE42 Medio tiempo (15\u201329 hrs/sem)\n3) \uD83E\uDD72 Menos de 15 hrs/sem",
  Q3: "*Q3/8* \u23F1\uFE0F\n\u00BFCu\u00E1ndo podr\u00EDas empezar?\n1) \uD83D\uDE80 Inmediatamente\n2) \uD83D\uDCC6 En 1\u20132 semanas\n3) \uD83D\uDDD3\uFE0F En 1 mes o m\u00E1s",
  Q4: "*Q4/8* \uD83D\uDCBB\uD83C\uDFA7\n\u00BFTienes internet estable + un lugar tranquilo para ense\u00F1ar?\n1) \u2705 S\u00ED\n2) \u274C No",
  Q5: "*Q5/8* \uD83D\uDCDA\u2728\n\u00BFEst\u00E1s de acuerdo en seguir el curr\u00EDculum y los SOPs del equipo?\n1) \u2705 S\u00ED\n2) \u274C No",
  Q6: "*Q6/8* \uD83C\uDDFA\uD83C\uDDF8\uD83D\uDDE3\uFE0F\n\u00BFCu\u00E1l es tu nivel de ingl\u00E9s?\n1) \u2705 Bueno\n2) \uD83D\uDE42 Me defiendo\n3) \u274C No s\u00E9 mucho",
  Q7: "*Q7/8* \uD83C\uDF82\n\u00BFCu\u00E1l es tu edad?\n(Escribe solo el n\u00FAmero, por ejemplo: 24)",
  Q8: "*Q8/8* \uD83D\uDC69\u200D\uD83C\uDFEB\n\u00BFA qu\u00E9 tipo de estudiantes has ense\u00F1ado?\n1) Ni\u00F1os \uD83D\uDC67\uD83E\uDDD2\n2) J\u00F3venes \uD83C\uDF93\n3) Adultos \uD83D\uDCBC\n4) Todos los anteriores \uD83C\uDF1F",
};

// Short per-question invalid-input hints (sent together with the question resend).
const INVALID_HINT: Record<ScreeningStep, string> = {
  Q1: "\uD83D\uDE0A Responde solo con 1 o 2.",
  Q2: "\uD83D\uDE0A Responde solo con 1, 2 o 3.",
  Q3: "\uD83D\uDE0A Responde solo con 1, 2 o 3.",
  Q4: "\uD83D\uDE0A Responde solo con 1 o 2.",
  Q5: "\uD83D\uDE0A Responde solo con 1 o 2.",
  Q6: "\uD83D\uDE0A Responde solo con 1, 2 o 3.",
  Q7: "\uD83D\uDE0A Por favor escribe tu edad en n\u00FAmeros (ej: 24).",
  Q8: "\uD83D\uDE0A Responde solo con 1, 2, 3 o 4.",
};

const FAIL_MESSAGES = {
  Q1: "\uD83D\uDCDB Gracias por tu sinceridad.\nEn este momento estamos buscando *miembros de equipo* con compromiso y disponibilidad constante.\n\n\uD83D\uDE4F Te deseamos lo mejor y gracias por postularte.",
  Q2: "\uD83D\uDCDB \u00A1Gracias!\nPor ahora necesitamos m\u00EDnimo *15 horas/semana* de disponibilidad constante.\n\n\uD83D\uDE4F Te agradecemos tu tiempo y tu inter\u00E9s en SpanishVIP.",
  Q4: "\uD83D\uDCDB Gracias por tu respuesta.\nPara poder dar clases con calidad, necesitamos *internet estable* y un *espacio tranquilo*.\n\n\uD83D\uDE4F Te agradecemos tu tiempo.",
  Q5: "\uD83D\uDCDB Gracias por tu sinceridad.\nPara este rol es importante seguir nuestro sistema y procesos.\n\n\uD83D\uDE4F Te deseamos lo mejor y gracias por postularte.",
  Q6: "\uD83D\uDCDB \u00A1Gracias!\nPor ahora necesitamos al menos un nivel de ingl\u00E9s para comunicarnos en el equipo (aunque sea _\"me defiendo\"_).\n\n\uD83D\uDE4F Te agradecemos tu tiempo y tu inter\u00E9s en SpanishVIP.",
  Q7: "\uD83D\uDCDB \u00A1Gracias!\nEn este momento estamos buscando candidatos *menores de 35 a\u00F1os* para este rol.\n\n\uD83D\uDE4F Te agradecemos tu tiempo y tu inter\u00E9s en SpanishVIP.",
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
// All outbound messages are sent via the Twilio REST API (see sendTwilioText
// below) so Twilio does not wait for us to compose a reply.
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
  session.completed = true;
  const payload: ResultPayload = {
    whatsapp_from: from,
    result: "pass",
    reason: "",
    answers: session.answers,
    completed_at: new Date().toISOString(),
  };

  await Promise.all([
    saveSession(from, session, env),
    postResultWebhook(payload, env),
  ]);

  const link = env.MARIA_WA_ME_LINK ?? "https://wa.me/57xxxxxxxxxx";
  const passMsg =
    "\uD83C\uDF89 *\u00A1Excelente! Has pasado el pre-filtro* \u2705\n\n" +
    "\uD83E\uDDD1\u200D\uD83D\uDCBC Siguiente paso: hablar con una persona del equipo para coordinar tu *primera entrevista*.\n\n" +
    "\uD83D\uDC49 Escribe aqu\u00ED a *Maria Camila* para continuar:\n" +
    link + "\n\n" +
    "\uD83D\uDCAC _Mensaje sugerido:_\n" +
    '"Hola Maria, pas\u00E9 el pre-filtro de SpanishVIP. Mi nombre es ___ y mi correo es ___."';

  await sendTwilioText(from, passMsg, env);
}

async function failSession(
  from: string,
  session: SessionState,
  stepKey: keyof typeof FAIL_MESSAGES,
  reason: string,
  env: Env
): Promise<void> {
  session.completed = true;
  const payload: ResultPayload = {
    whatsapp_from: from,
    result: "fail",
    reason,
    answers: session.answers,
    completed_at: new Date().toISOString(),
  };

  await Promise.all([
    saveSession(from, session, env),
    postResultWebhook(payload, env),
  ]);

  const failMsg = FAIL_MESSAGES[stepKey];
  await sendTwilioText(from, failMsg, env);
}

// Sends a short step-specific invalid-input hint followed by the question again,
// combined into one message to minimise outbound message cost.
async function sendInvalidInput(
  from: string,
  step: ScreeningStep,
  env: Env
): Promise<void> {
  const hint = INVALID_HINT[step];
  const question = QUESTION_TEXT[step];
  await sendTwilioText(from, `${hint}\n\n${question}`, env);
}

// Normalises the input to match known keywords and numeric options.
// Returns a trimmed, uppercase string.
function resolveInput(raw: string): string {
  return raw.trim().toUpperCase();
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
      const isYes = ["1", "YES", "SI", "S\u00CD", "Y"].includes(input);
      const isNo = ["2", "NO", "N"].includes(input);

      if (isYes) {
        session.answers.team_role = "yes";
        session.step = "Q2";
        await saveSession(from, session, env);
        await sendTwilioText(from, QUESTION_TEXT["Q2"], env);
      } else if (isNo) {
        session.answers.team_role = "no";
        await failSession(from, session, "Q1", "not team role", env);
      } else {
        await sendInvalidInput(from, "Q1", env);
      }
      return;
    }

    case "Q2": {
      const isFT = ["1", "FT", "FULLTIME", "FULL-TIME"].includes(input);
      const isPT = ["2", "PT", "PARTTIME", "PART-TIME"].includes(input);
      const isLow = ["3", "LOW", "<15", "LESS", "MENOS"].includes(input);

      if (isFT) {
        session.answers.weekly_availability = "full_time";
        session.step = "Q3";
        await saveSession(from, session, env);
        await sendTwilioText(from, QUESTION_TEXT["Q3"], env);
      } else if (isPT) {
        session.answers.weekly_availability = "part_time";
        // If MIN_WEEKLY_HOURS is 30 or more, PT (15-29) fails.
        if (minHours > 29) {
          await failSession(from, session, "Q2", "low", env);
        } else {
          session.step = "Q3";
          await saveSession(from, session, env);
          await sendTwilioText(from, QUESTION_TEXT["Q3"], env);
        }
      } else if (isLow) {
        session.answers.weekly_availability = "low";
        // Threshold check: "low" is < 15. If minHours is 1 or more, "low" fails.
        if (minHours >= 1) {
          await failSession(from, session, "Q2", "low", env);
        } else {
          session.step = "Q3";
          await saveSession(from, session, env);
          await sendTwilioText(from, QUESTION_TEXT["Q3"], env);
        }
      } else {
        await sendInvalidInput(from, "Q2", env);
      }
      return;
    }

    case "Q3": {
      const isNow = ["1", "NOW", "INMEDIATO", "INMEDIATAMENTE"].includes(input);
      const isSoon = ["2", "2WEEKS", "SOON", "PRONTO", "1-2"].includes(input);
      const isLater = ["3", "1MONTH", "LATER", "MAS", "M\u00C1S", "1 MES"].includes(input);

      if (isNow) {
        session.answers.start_date = "now";
        session.step = "Q4";
        await saveSession(from, session, env);
        await sendTwilioText(from, QUESTION_TEXT["Q4"], env);
      } else if (isSoon) {
        session.answers.start_date = "soon";
        session.step = "Q4";
        await saveSession(from, session, env);
        await sendTwilioText(from, QUESTION_TEXT["Q4"], env);
      } else if (isLater) {
        session.answers.start_date = "later";
        session.step = "Q4";
        await saveSession(from, session, env);
        await sendTwilioText(from, QUESTION_TEXT["Q4"], env);
      } else {
        await sendInvalidInput(from, "Q3", env);
      }
      return;
    }

    case "Q4": {
      const isYes = ["1", "YES", "SI", "S\u00CD"].includes(input);
      const isNo = ["2", "NO"].includes(input);

      if (isYes) {
        session.answers.setup = "yes";
        session.step = "Q5";
        await saveSession(from, session, env);
        await sendTwilioText(from, QUESTION_TEXT["Q5"], env);
      } else if (isNo) {
        session.answers.setup = "no";
        await failSession(from, session, "Q4", "no stable setup", env);
      } else {
        await sendInvalidInput(from, "Q4", env);
      }
      return;
    }

    case "Q5": {
      const isYes = ["1", "YES", "SI", "S\u00CD"].includes(input);
      const isNo = ["2", "NO"].includes(input);

      if (isYes) {
        session.answers.sop = "yes";
        session.step = "Q6";
        await saveSession(from, session, env);
        await sendTwilioText(from, QUESTION_TEXT["Q6"], env);
      } else if (isNo) {
        session.answers.sop = "no";
        await failSession(from, session, "Q5", "not willing to follow SOP", env);
      } else {
        await sendInvalidInput(from, "Q5", env);
      }
      return;
    }

    case "Q6": {
      const isGood = ["1", "GOOD", "BUENO", "B1", "B2", "C1", "C2"].includes(input);
      const isOk = ["2", "DEFENDERME", "ME DEFIENDO", "BASIC", "BASICO", "B\u00C1SICO"].includes(input);
      const isLow = ["3", "POCO", "NO MUCHO", "NO SE", "NO", "NADA"].includes(input);

      if (isGood) {
        session.answers.english_level = "good";
        session.step = "Q7";
        await saveSession(from, session, env);
        await sendTwilioText(from, QUESTION_TEXT["Q7"], env);
      } else if (isOk) {
        session.answers.english_level = "ok";
        session.step = "Q7";
        await saveSession(from, session, env);
        await sendTwilioText(from, QUESTION_TEXT["Q7"], env);
      } else if (isLow) {
        session.answers.english_level = "low";
        await failSession(from, session, "Q6", "english_low", env);
      } else {
        await sendInvalidInput(from, "Q6", env);
      }
      return;
    }

    case "Q7": {
      const ageNum = parseInt(rawInput.trim(), 10);
      if (isNaN(ageNum) || ageNum <= 0 || ageNum > 120) {
        await sendInvalidInput(from, "Q7", env);
        return;
      }
      session.answers.age = ageNum;
      if (ageNum >= 35) {
        await failSession(from, session, "Q7", "age >= 35", env);
      } else {
        session.step = "Q8";
        await saveSession(from, session, env);
        await sendTwilioText(from, QUESTION_TEXT["Q8"], env);
      }
      return;
    }

    case "Q8": {
      const studentTypeMap: Record<string, "kids" | "teens" | "adults" | "all"> = {
        "1": "kids",
        "2": "teens",
        "3": "adults",
        "4": "all",
      };
      const studentType = studentTypeMap[input];
      if (!studentType) {
        await sendInvalidInput(from, "Q8", env);
        return;
      }
      session.answers.student_types = studentType;
      await passSession(from, session, env);
      return;
    }
  }
}

// processAndSend runs entirely inside ctx.waitUntil() — the webhook has already
// returned <Response/> before this executes. All user-facing output goes via
// sendTwilioText().
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
        "Est\u00E1s enviando mensajes demasiado r\u00E1pido. Por favor, espera un momento.",
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

    // START and RESTART both clear the session and jump straight to Q1.
    if (upper === "START" || upper === "RESTART") {
      console.log(`[processAndSend] from=${from} command=${upper} — resetting session`);
      await safeKvDelete(env.BOT_KV, `session:${from}`);
      const newSession = createSession();
      await saveSession(from, newSession, env);
      await sendTwilioText(from, QUESTION_TEXT["Q1"], env);
      return;
    }

    // Load existing session
    const session = await loadSession(from, env);

    if (!session) {
      // No active session — short prompt only.
      await sendTwilioText(from, "Escribe START para comenzar \uD83D\uDE0A", env);
      return;
    }

    // If session is already completed, ignore further input unless it's START/RESTART
    if (session.completed) {
      console.log(`[processAndSend] from=${from} session is completed — ignoring input`);
      return;
    }

    await handleStep(session, input, inputSource, from, env);
  } catch (err) {
    console.error("processAndSend error:", err);
    try {
      await sendTwilioText(
        from,
        "Lo sentimos, algo sali\u00F3 mal. Por favor, escribe *RESTART* para empezar de nuevo.",
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
