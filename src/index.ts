// ─── Types ────────────────────────────────────────────────────────────────────

export interface Env {
  BOT_KV: KVNamespace;
  // Green-API credentials
  GREENAPI_ID_INSTANCE: string;   // Instance ID (numeric string), set in wrangler.toml [vars]
  GREENAPI_API_TOKEN: string;     // API token (secret)
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
const OPTOUT_TTL_SECONDS      = 2_592_000;  // 30 days
const START_DEDUP_TTL_SECONDS = 60;         // 60 seconds
const MSGID_TTL_SECONDS       = 300;        // 5 minutes (webhook dedup)

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

// ─── Utilities ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Text Sanitization ────────────────────────────────────────────────────────

// Replaces Unicode characters that can cause WhatsApp rendering failures:
//   em dash (U+2014) → hyphen
//   curly single quotes (U+2018/U+2019) → straight apostrophe
//   curly double quotes (U+201C/U+201D) → straight double quote
function sanitize(text: string): string {
  return text
    .replace(/\u2014/g, "-")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"');
}

// ─── KV Key Helpers ───────────────────────────────────────────────────────────

// Extracts the numeric phone digits from a Green-API chatId.
// "573001234567@c.us" → "573001234567"
// Strips everything from the first "@" onwards.
function chatIdToDigits(chatId: string): string {
  return chatId.replace(/@.*/, "");
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

// KV key for session storage: "wa:<digits>" e.g. "wa:573001234567"
async function loadSession(
  chatId: string,
  env: Env
): Promise<SessionState | null> {
  const raw = await safeKvGet(env.BOT_KV, `wa:${chatIdToDigits(chatId)}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SessionState;
  } catch {
    return null;
  }
}

async function saveSession(
  chatId: string,
  session: SessionState,
  env: Env
): Promise<void> {
  session.lastActivityAt = new Date().toISOString();
  await safeKvPut(
    env.BOT_KV,
    `wa:${chatIdToDigits(chatId)}`,
    JSON.stringify(session),
    { expirationTtl: SESSION_TTL_SECONDS }
  );
}

// ─── Rate Limiting ────────────────────────────────────────────────────────────

// KV key for rate-limit records: "rl:<digits>" e.g. "rl:573001234567"
async function checkRateLimit(chatId: string, env: Env): Promise<boolean> {
  const key = `rl:${chatIdToDigits(chatId)}`;
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

// ─── Opt-Out Helpers ──────────────────────────────────────────────────────────

// KV key for opt-out: "optout:<digits>", TTL 30 days.
async function isOptedOut(chatId: string, env: Env): Promise<boolean> {
  return (await safeKvGet(env.BOT_KV, `optout:${chatIdToDigits(chatId)}`)) === "true";
}

async function setOptOut(chatId: string, env: Env): Promise<void> {
  await safeKvPut(env.BOT_KV, `optout:${chatIdToDigits(chatId)}`, "true", {
    expirationTtl: OPTOUT_TTL_SECONDS,
  });
}

async function clearOptOut(chatId: string, env: Env): Promise<void> {
  await safeKvDelete(env.BOT_KV, `optout:${chatIdToDigits(chatId)}`);
}

// ─── START Dedup Helper ───────────────────────────────────────────────────────

// KV key: "start_dedup:<digits>", TTL 60 s.
// Returns true if a START was already processed within the last 60 seconds
// (duplicate), and false otherwise (sets the key on first call).
async function checkAndSetStartDedup(chatId: string, env: Env): Promise<boolean> {
  const key = `start_dedup:${chatIdToDigits(chatId)}`;
  if (await safeKvGet(env.BOT_KV, key)) return true;
  await safeKvPut(env.BOT_KV, key, "1", { expirationTtl: START_DEDUP_TTL_SECONDS });
  return false;
}

// ─── Green-API REST Helper ────────────────────────────────────────────────────

// Sends a plain text WhatsApp message via the Green-API sendMessage endpoint.
// toChatId must be in Green-API chatId format: "<digits>@c.us".
// Text is sanitized before sending to avoid rendering failures.
// Returns true on success, false on failure.
async function sendText(
  toChatId: string,
  body: string,
  env: Env
): Promise<boolean> {
  // Randomized delay before every send to reduce WhatsApp ban risk.
  await sleep(2000 + Math.random() * 2000);

  const sanitized = sanitize(body);
  const url = `https://api.green-api.com/waInstance${env.GREENAPI_ID_INSTANCE}/sendMessage/${env.GREENAPI_API_TOKEN}`;

  console.log(`[sendText] to=${toChatId} type=plain`);

  // Up to 4 attempts total; retries only on HTTP 429 with exponential backoff.
  for (let attempt = 0; attempt <= 3; attempt++) {
    if (attempt > 0) {
      const backoff = Math.pow(2, attempt) * 1000; // 2 s, 4 s, 8 s
      console.warn(`[sendText] 429 rate-limited — retry attempt=${attempt} backoff=${backoff}ms`);
      await sleep(backoff);
    }

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId: toChatId, message: sanitized }),
    });

    const responseBody = await res.text().catch(() => "");

    if (res.ok) {
      console.log(`[sendText] success response=${responseBody}`);
      return true;
    }

    if (res.status === 429 && attempt < 3) {
      continue; // Will sleep at top of loop on next iteration.
    }

    if (res.status === 401 || res.status === 403) {
      console.error(
        `[sendText] auth error ${res.status} — check GREENAPI_ID_INSTANCE and GREENAPI_API_TOKEN (instance may be disconnected). body=${responseBody}`
      );
    } else {
      console.error(`[sendText] error status=${res.status} body=${responseBody}`);
    }
    return false;
  }

  return false; // Unreachable; satisfies TypeScript exhaustive-return check.
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
  chatId: string,
  session: SessionState,
  env: Env
): Promise<void> {
  session.completed = true;
  const payload: ResultPayload = {
    whatsapp_from: chatId,
    result: "pass",
    reason: "",
    answers: session.answers,
    completed_at: new Date().toISOString(),
  };

  await Promise.all([
    saveSession(chatId, session, env),
    postResultWebhook(payload, env),
  ]);

  const link =
    env.MARIA_WA_ME_LINK ??
    "https://wa.me/573022379539?text=Hi%20Maria%2C%20I%20passed%20screening%20and%20would%20like%20to%20schedule%20my%20interview.";
  const passMsg =
    "\uD83C\uDF89 *\u00A1Excelente! Has pasado el pre-filtro* \u2705\n\n" +
    "\uD83E\uDDD1\u200D\uD83D\uDCBC Siguiente paso: hablar con una persona del equipo para coordinar tu *primera entrevista*.\n\n" +
    "\uD83D\uDC49 Escribe aqu\u00ED a *Maria Camila* para continuar:\n" +
    link +
    "\n\n" +
    "\uD83D\uDCAC _Mensaje sugerido:_\n" +
    '"Hola Maria, pas\u00E9 el pre-filtro de SpanishVIP. Mi nombre es ___ y mi correo es ___.\"';

  await sendText(chatId, passMsg, env);
}

async function failSession(
  chatId: string,
  session: SessionState,
  stepKey: keyof typeof FAIL_MESSAGES,
  reason: string,
  env: Env
): Promise<void> {
  session.completed = true;
  const payload: ResultPayload = {
    whatsapp_from: chatId,
    result: "fail",
    reason,
    answers: session.answers,
    completed_at: new Date().toISOString(),
  };

  await Promise.all([
    saveSession(chatId, session, env),
    postResultWebhook(payload, env),
  ]);

  const failMsg = FAIL_MESSAGES[stepKey];
  await sendText(chatId, failMsg, env);
}

// Sends a short step-specific invalid-input hint followed by the question again,
// combined into one message to minimise outbound message cost.
async function sendInvalidInput(
  chatId: string,
  step: ScreeningStep,
  env: Env
): Promise<void> {
  const hint = INVALID_HINT[step];
  const question = QUESTION_TEXT[step];
  await sendText(chatId, `${hint}\n\n${question}`, env);
}

// Normalises the input to match known keywords and numeric options.
// Returns a trimmed, uppercase string.
function resolveInput(raw: string): string {
  return raw.trim().toUpperCase();
}

async function handleStep(
  session: SessionState,
  rawInput: string,
  chatId: string,
  env: Env
): Promise<void> {
  const stepBefore = session.step;
  const minHours = parseInt(env.MIN_WEEKLY_HOURS ?? "15", 10);
  const input = resolveInput(rawInput);

  console.log(
    `[handleStep] chatId=${chatId} step.before=${stepBefore} rawInput="${rawInput}"`
  );

  switch (session.step) {
    case "Q1": {
      const isYes = ["1", "YES", "SI", "S\u00CD", "Y"].includes(input);
      const isNo = ["2", "NO", "N"].includes(input);

      if (isYes) {
        session.answers.team_role = "yes";
        session.step = "Q2";
        await saveSession(chatId, session, env);
        await sendText(chatId, QUESTION_TEXT["Q2"], env);
      } else if (isNo) {
        session.answers.team_role = "no";
        await failSession(chatId, session, "Q1", "not team role", env);
      } else {
        await sendInvalidInput(chatId, "Q1", env);
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
        await saveSession(chatId, session, env);
        await sendText(chatId, QUESTION_TEXT["Q3"], env);
      } else if (isPT) {
        session.answers.weekly_availability = "part_time";
        // If MIN_WEEKLY_HOURS is 30 or more, PT (15-29) fails.
        if (minHours > 29) {
          await failSession(chatId, session, "Q2", "low", env);
        } else {
          session.step = "Q3";
          await saveSession(chatId, session, env);
          await sendText(chatId, QUESTION_TEXT["Q3"], env);
        }
      } else if (isLow) {
        session.answers.weekly_availability = "low";
        // Threshold check: "low" is < 15. If minHours is 1 or more, "low" fails.
        if (minHours >= 1) {
          await failSession(chatId, session, "Q2", "low", env);
        } else {
          session.step = "Q3";
          await saveSession(chatId, session, env);
          await sendText(chatId, QUESTION_TEXT["Q3"], env);
        }
      } else {
        await sendInvalidInput(chatId, "Q2", env);
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
        await saveSession(chatId, session, env);
        await sendText(chatId, QUESTION_TEXT["Q4"], env);
      } else if (isSoon) {
        session.answers.start_date = "soon";
        session.step = "Q4";
        await saveSession(chatId, session, env);
        await sendText(chatId, QUESTION_TEXT["Q4"], env);
      } else if (isLater) {
        session.answers.start_date = "later";
        session.step = "Q4";
        await saveSession(chatId, session, env);
        await sendText(chatId, QUESTION_TEXT["Q4"], env);
      } else {
        await sendInvalidInput(chatId, "Q3", env);
      }
      return;
    }

    case "Q4": {
      const isYes = ["1", "YES", "SI", "S\u00CD"].includes(input);
      const isNo = ["2", "NO"].includes(input);

      if (isYes) {
        session.answers.setup = "yes";
        session.step = "Q5";
        await saveSession(chatId, session, env);
        await sendText(chatId, QUESTION_TEXT["Q5"], env);
      } else if (isNo) {
        session.answers.setup = "no";
        await failSession(chatId, session, "Q4", "no stable setup", env);
      } else {
        await sendInvalidInput(chatId, "Q4", env);
      }
      return;
    }

    case "Q5": {
      const isYes = ["1", "YES", "SI", "S\u00CD"].includes(input);
      const isNo = ["2", "NO"].includes(input);

      if (isYes) {
        session.answers.sop = "yes";
        session.step = "Q6";
        await saveSession(chatId, session, env);
        await sendText(chatId, QUESTION_TEXT["Q6"], env);
      } else if (isNo) {
        session.answers.sop = "no";
        await failSession(chatId, session, "Q5", "not willing to follow SOP", env);
      } else {
        await sendInvalidInput(chatId, "Q5", env);
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
        await saveSession(chatId, session, env);
        await sendText(chatId, QUESTION_TEXT["Q7"], env);
      } else if (isOk) {
        session.answers.english_level = "ok";
        session.step = "Q7";
        await saveSession(chatId, session, env);
        await sendText(chatId, QUESTION_TEXT["Q7"], env);
      } else if (isLow) {
        session.answers.english_level = "low";
        await failSession(chatId, session, "Q6", "english_low", env);
      } else {
        await sendInvalidInput(chatId, "Q6", env);
      }
      return;
    }

    case "Q7": {
      const ageNum = parseInt(rawInput.trim(), 10);
      if (isNaN(ageNum) || ageNum <= 0 || ageNum > 120) {
        await sendInvalidInput(chatId, "Q7", env);
        return;
      }
      session.answers.age = ageNum;
      if (ageNum >= 35) {
        await failSession(chatId, session, "Q7", "age >= 35", env);
      } else {
        session.step = "Q8";
        await saveSession(chatId, session, env);
        await sendText(chatId, QUESTION_TEXT["Q8"], env);
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
        await sendInvalidInput(chatId, "Q8", env);
        return;
      }
      session.answers.student_types = studentType;
      await passSession(chatId, session, env);
      return;
    }
  }
}

// processAndSend runs entirely inside ctx.waitUntil() — the webhook has already
// returned 200 before this executes. All user-facing output goes via sendText().
async function processAndSend(
  chatId: string,
  text: string,
  env: Env
): Promise<void> {
  try {
    const input = text.trim();
    const upper = input.toUpperCase();

    console.log(`[processAndSend] chatId=${chatId} text="${input}"`);

    // PING — debug command, always reply regardless of session state or rate-limit.
    if (upper === "PING") {
      await sendText(chatId, "pong", env);
      return;
    }

    // STOP — opt out: persist flag and send one-time confirmation.
    if (upper === "STOP") {
      await setOptOut(chatId, env);
      await sendText(
        chatId,
        "Listo \u2705 No te escribiremos m\u00E1s por aqu\u00ED. Si quieres volver, escribe START.",
        env
      );
      return;
    }

    // START and RESTART both clear the session and jump straight to Q1.
    if (upper === "START" || upper === "RESTART") {
      const optedOut = await isOptedOut(chatId, env);
      if (optedOut) {
        // Re-opting in: clear flags so the user gets a clean start (bypass dedup).
        await clearOptOut(chatId, env);
        await safeKvDelete(env.BOT_KV, `start_dedup:${chatIdToDigits(chatId)}`);
      } else if (upper === "START") {
        // Dedup: if the user sent START less than 60 s ago, remind them instead.
        const isDupe = await checkAndSetStartDedup(chatId, env);
        if (isDupe) {
          await sendText(
            chatId,
            "Ya iniciamos \u2705 Responde con 1/2 seg\u00FAn la pregunta.",
            env
          );
          return;
        }
      }
      console.log(`[processAndSend] chatId=${chatId} command=${upper} — resetting session`);
      await safeKvDelete(env.BOT_KV, `wa:${chatIdToDigits(chatId)}`);
      const newSession = createSession();
      await saveSession(chatId, newSession, env);
      await sendText(chatId, QUESTION_TEXT["Q1"], env);
      return;
    }

    // Opt-out guard — silently ignore all other messages from opted-out users.
    const optedOut = await isOptedOut(chatId, env);
    if (optedOut) {
      console.log(`[processAndSend] chatId=${chatId} opted out — ignoring`);
      return;
    }

    // Rate limit
    const allowed = await checkRateLimit(chatId, env);
    if (!allowed) {
      await sendText(
        chatId,
        "Est\u00E1s enviando mensajes demasiado r\u00E1pido. Por favor, espera un momento.",
        env
      );
      return;
    }

    // Load existing session
    const session = await loadSession(chatId, env);

    if (!session) {
      // No active session — short prompt only.
      await sendText(chatId, "Escribe START para comenzar \uD83D\uDE0A", env);
      return;
    }

    // If session is already completed, ignore further input unless it's START/RESTART
    if (session.completed) {
      console.log(`[processAndSend] chatId=${chatId} session is completed — ignoring input`);
      return;
    }

    await handleStep(session, input, chatId, env);
  } catch (err) {
    console.error("processAndSend error:", err);
    try {
      await sendText(
        chatId,
        "Lo sentimos, algo sali\u00F3 mal. Por favor, escribe *RESTART* para empezar de nuevo.",
        env
      );
    } catch {
      // swallow — nothing more we can do
    }
  }
}

// ─── Green-API Webhook Types ──────────────────────────────────────────────────

interface GreenApiSenderData {
  chatId: string;
  chatName: string;
  sender: string;
  senderName: string;
}

interface GreenApiTextMessageData {
  textMessage: string;
}

interface GreenApiExtendedTextMessageData {
  text: string;
}

interface GreenApiMessageData {
  typeMessage: string;
  textMessageData?: GreenApiTextMessageData;
  extendedTextMessageData?: GreenApiExtendedTextMessageData;
}

interface GreenApiWebhookPayload {
  typeWebhook?: string;
  idMessage?: string;
  senderData?: GreenApiSenderData;
  messageData?: GreenApiMessageData;
}

// ─── Request Handlers ─────────────────────────────────────────────────────────

// Handles inbound Green-API webhook notifications.
//
// Green-API can send various notification types (stateInstanceChanged, etc.).
// Rather than allowlisting specific typeWebhook values (which vary across API
// versions), we inspect the payload directly: if senderData.chatId and a
// supported messageData.typeMessage are present, we process it; otherwise we
// ack and discard.
async function handleGreenApiWebhook(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  let payload: GreenApiWebhookPayload;
  try {
    payload = (await request.json()) as GreenApiWebhookPayload;
  } catch {
    // Malformed JSON — ack immediately
    return new Response("ok", { status: 200 });
  }

  const chatId = payload.senderData?.chatId ?? "";
  const typeMessage = payload.messageData?.typeMessage ?? "";

  if (!chatId) {
    console.log(
      `[webhook] no chatId (typeWebhook=${payload.typeWebhook ?? "?"}) — ignoring`
    );
    return new Response("ok", { status: 200 });
  }

  // Ignore group chats (chatId ends with @g.us for groups)
  if (chatId.endsWith("@g.us")) {
    console.log(`[webhook] ignoring group chat chatId=${chatId}`);
    return new Response("ok", { status: 200 });
  }

  // Extract text from supported message types; ignore everything else
  let text = "";
  if (typeMessage === "textMessage") {
    text = payload.messageData?.textMessageData?.textMessage?.trim() ?? "";
  } else if (typeMessage === "extendedTextMessage") {
    // Quoted/forwarded messages carry text in extendedTextMessageData.text
    text = payload.messageData?.extendedTextMessageData?.text?.trim() ?? "";
  } else {
    console.log(
      `[webhook] ignoring typeMessage=${typeMessage} chatId=${chatId}`
    );
    return new Response("ok", { status: 200 });
  }

  if (!text) {
    return new Response("ok", { status: 200 });
  }

  console.log(
    `[webhook] chatId=${chatId} typeMessage=${typeMessage} text="${text}"`
  );

  // Deduplicate on idMessage to guard against Green-API webhook retries.
  const msgId = payload.idMessage;
  if (msgId) {
    const dedupKey = `msgid:${msgId}`;
    const seen = await safeKvGet(env.BOT_KV, dedupKey);
    if (seen) {
      console.log(`[webhook] duplicate msgId=${msgId} — ignoring`);
      return new Response("ok", { status: 200 });
    }
    await safeKvPut(env.BOT_KV, dedupKey, "1", { expirationTtl: MSGID_TTL_SECONDS });
  }

  // Return 200 immediately; process asynchronously so Green-API doesn't retry.
  ctx.waitUntil(processAndSend(chatId, text, env));
  return new Response("ok", { status: 200 });
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

  if (method === "POST" && pathname === "/greenapi/webhook") {
    return handleGreenApiWebhook(request, env, ctx);
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
      return new Response("ok", { status: 200 });
    }
  },
};
