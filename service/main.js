// service/main.ts
import { resolve as resolve3 } from "node:path";
import { fileURLToPath } from "node:url";

// service/env.ts
var PORT_VARIABLE = "OPENCHAMBER_SERVICE_PORT";
var TOKEN_VARIABLE = "OPENCHAMBER_SERVICE_TOKEN";
var MAX_PORT = 65535;
var MIN_TOKEN_LENGTH = 32;

class ServiceEnvError extends Error {
  name = "ServiceEnvError";
}
function readPort(value) {
  if (value === undefined || !/^\d+$/.test(value)) {
    throw new ServiceEnvError(`${PORT_VARIABLE} must be an integer between 0 and ${MAX_PORT}`);
  }
  const port = Number(value);
  if (port > MAX_PORT) {
    throw new ServiceEnvError(`${PORT_VARIABLE} must be an integer between 0 and ${MAX_PORT}`);
  }
  return port;
}
function readToken(value) {
  if (value === undefined || value.length < MIN_TOKEN_LENGTH) {
    throw new ServiceEnvError(`${TOKEN_VARIABLE} must be at least ${MIN_TOKEN_LENGTH} characters`);
  }
  return value;
}
function readServiceEnv(env) {
  return { port: readPort(env[PORT_VARIABLE]), token: readToken(env[TOKEN_VARIABLE]) };
}

// src/redaction.ts
var SECRET_PATTERNS = [
  { label: "github-token-classic", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/g },
  { label: "github-token-fine-grained", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  { label: "authorization-header", pattern: /\bAuthorization\s*[:=]\s*["']?\S+/g },
  { label: "bearer-credential", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g }
];
function findSecretLeak(text) {
  for (const { label, pattern } of SECRET_PATTERNS) {
    if (text.match(pattern) !== null) {
      return label;
    }
  }
  return null;
}
function redact(text) {
  let result = text;
  for (const { label, pattern } of SECRET_PATTERNS) {
    result = result.replaceAll(pattern, () => `[redacted:${label}]`);
  }
  return result;
}

// service/log.ts
var SEVERITY = { debug: 10, info: 20, warn: 30, error: 40 };
function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}
function serialize(entry) {
  const raw = JSON.stringify({
    ts: new Date().toISOString(),
    level: entry.level,
    message: entry.message,
    ...entry.fields
  });
  return `${redact(raw)}
`;
}
function createLogger(options) {
  const sink = options.sink ?? ((line) => {
    process.stdout.write(line);
  });
  let threshold = SEVERITY[options.level];
  const emit = (entry) => {
    if (SEVERITY[entry.level] < threshold) {
      return;
    }
    sink(serialize(entry));
  };
  return {
    setLevel: (level) => {
      threshold = SEVERITY[level];
    },
    debug: (message, fields = {}) => emit({ level: "debug", message, fields }),
    info: (message, fields = {}) => emit({ level: "info", message, fields }),
    warn: (message, fields = {}) => emit({ level: "warn", message, fields }),
    error: (message, fields = {}) => emit({ level: "error", message, fields })
  };
}

// service/server.ts
import { createServer } from "node:http";

// src/ids.ts
function newCorrelationId() {
  if (typeof crypto === "undefined" || typeof crypto.randomUUID !== "function") {
    throw new Error("crypto.randomUUID is unavailable; refusing to record an observation without a correlation id");
  }
  return crypto.randomUUID();
}
function nowIso() {
  return new Date().toISOString();
}

// service/json.ts
function parseJsonText(text) {
  try {
    const value = JSON.parse(text);
    return { ok: true, value };
  } catch {
    return { ok: false };
  }
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function readText(value) {
  return typeof value === "string" && value !== "" ? value : null;
}
function readString(value) {
  return typeof value === "string" ? value : null;
}
function readStamp(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;
}
function readCount(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function readPositiveInt(value) {
  const parsed = readCount(value);
  return parsed !== null && parsed >= 1 ? parsed : null;
}
function readFlag(value) {
  return typeof value === "boolean" ? value : null;
}

// service/audit.ts
var AUDIT_FILE = "audit.ndjson";
var CONFIGURATION_ENTITY_ID = "configuration";
var AUDIT_ENTITY_KINDS = new Set([
  "service",
  "account",
  "binding",
  "run",
  "delivery"
]);
function isAuditEntityKind(value) {
  return typeof value === "string" && AUDIT_ENTITY_KINDS.has(value);
}
function redactDeep(input) {
  const { value, path, fields } = input;
  if (typeof value === "string") {
    const cleaned = redact(value);
    if (cleaned !== value) {
      fields.push(path);
    }
    return cleaned;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => redactDeep({ value: item, path: `${path}[${index}]`, fields }));
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      key,
      redactDeep({ value: child, path: path === "" ? key : `${path}.${key}`, fields })
    ]));
  }
  return value;
}
function redactInput(input) {
  const fields = [];
  const details = redactDeep({ value: input.details ?? {}, path: "details", fields });
  const reason = typeof input.reason === "string" ? redactDeep({ value: input.reason, path: "reason", fields }) : null;
  return {
    details: isRecord(details) ? details : {},
    reason,
    redaction: { redacted: fields.length > 0, fields }
  };
}
function isAuditHeader(raw) {
  return typeof raw.seq === "number" && typeof raw.timestamp === "string" && typeof raw.correlationId === "string" && typeof raw.eventType === "string" && typeof raw.actorSource === "string";
}
function isAuditEntity(raw) {
  return isRecord(raw) && isAuditEntityKind(raw.kind) && typeof raw.id === "string";
}
function readRedaction(raw) {
  if (!isRecord(raw)) {
    return { redacted: false, fields: [] };
  }
  const fields = Array.isArray(raw.fields) ? raw.fields.filter((entry) => typeof entry === "string") : [];
  return { redacted: raw.redacted === true, fields };
}
function parseAuditEntry(raw) {
  if (!isRecord(raw) || !isAuditHeader(raw) || !isAuditEntity(raw.entity) || !isRecord(raw.details)) {
    return null;
  }
  return {
    seq: raw.seq,
    timestamp: raw.timestamp,
    correlationId: raw.correlationId,
    eventType: raw.eventType,
    actorSource: raw.actorSource,
    entity: raw.entity,
    decision: typeof raw.decision === "string" ? raw.decision : null,
    reason: typeof raw.reason === "string" ? raw.reason : null,
    redaction: readRedaction(raw.redaction),
    details: raw.details
  };
}
async function readAuditTrail(store) {
  const result = await store.readLines(AUDIT_FILE, parseAuditEntry);
  return { entries: result.entries, malformed: result.malformed };
}
async function readAuditEntries(store) {
  const trail = await readAuditTrail(store);
  return trail.entries;
}
var auditCaches = new WeakMap;
async function seedAuditCache(store) {
  const entries = await readAuditEntries(store);
  let nextSeq = 1;
  for (const entry of entries) {
    nextSeq = Math.max(nextSeq, entry.seq + 1);
  }
  return { nextSeq, writeChain: Promise.resolve() };
}
function auditCacheFor(store) {
  let cached = auditCaches.get(store);
  if (cached === undefined) {
    cached = seedAuditCache(store).catch((error) => {
      auditCaches.delete(store);
      throw error;
    });
    auditCaches.set(store, cached);
  }
  return cached;
}
function inWriteChain(cache, task) {
  const run = cache.writeChain.then(task, task);
  cache.writeChain = run;
  return run;
}
function serializeAudit(store, task) {
  return auditCacheFor(store).then((cache) => inWriteChain(cache, task));
}
async function composeAudit(store, input) {
  const cache = await auditCacheFor(store);
  const { details, reason, redaction } = redactInput(input);
  const entry = {
    seq: cache.nextSeq,
    timestamp: nowIso(),
    correlationId: input.correlationId ?? newCorrelationId(),
    eventType: input.eventType,
    actorSource: input.actorSource,
    entity: input.entity,
    decision: input.decision ?? null,
    reason,
    redaction,
    details
  };
  cache.nextSeq += 1;
  return entry;
}
async function appendAudit(store, input) {
  const cache = await auditCacheFor(store);
  const { details, reason, redaction } = redactInput(input);
  return await inWriteChain(cache, async () => {
    const entry = {
      seq: cache.nextSeq,
      timestamp: nowIso(),
      correlationId: input.correlationId ?? newCorrelationId(),
      eventType: input.eventType,
      actorSource: input.actorSource,
      entity: input.entity,
      decision: input.decision ?? null,
      reason,
      redaction,
      details
    };
    await store.appendLine(AUDIT_FILE, entry);
    cache.nextSeq += 1;
    return entry;
  });
}

// service/prompt.ts
import { createHash } from "node:crypto";

// src/prompt.ts
var RESERVED_MARKER_PREFIXES = ["--- BEGIN ", "--- END "];
var NEWLINE = `
`;
var PROMPT_FINGERPRINT_PATTERN = /^mtp-[0-9a-f]{32}$/;
var PROMPT_SOURCE_ORDER = ["global", "account", "binding"];
function isPromptSource(value) {
  if (typeof value !== "string") {
    return false;
  }
  const order = PROMPT_SOURCE_ORDER;
  return order.includes(value);
}
function isPromptSourceList(value) {
  if (!Array.isArray(value)) {
    return false;
  }
  let previous = -1;
  for (const element of value) {
    if (!isPromptSource(element)) {
      return false;
    }
    const index = PROMPT_SOURCE_ORDER.indexOf(element);
    if (index <= previous) {
      return false;
    }
    previous = index;
  }
  return true;
}
var LAST_FORBIDDEN_LOW_CODE_POINT = 8;
var TAB_CODE_POINT = 9;
var LINE_FEED_CODE_POINT = 10;
var FORBIDDEN_MIDDLE_START = 11;
var FORBIDDEN_MIDDLE_END = 31;
var FORBIDDEN_UPPER_START = 127;
var FORBIDDEN_UPPER_END = 159;
function trimPrompt(text) {
  return text.trim();
}
function normaliseLineEndings(text) {
  let folded = "";
  for (let index = 0;index < text.length; index += 1) {
    if (text[index] !== "\r") {
      folded += text[index] ?? "";
      continue;
    }
    folded += NEWLINE;
    if (text[index + 1] === `
`) {
      index += 1;
    }
  }
  return folded;
}
function countCodePoints(text) {
  return [...text].length;
}
function hasReservedMarkerLine(text) {
  const prefixes = RESERVED_MARKER_PREFIXES;
  return text.split(NEWLINE).some((line) => prefixes.some((prefix) => line.startsWith(prefix)));
}
function isForbiddenControl(codePoint) {
  if (codePoint <= LAST_FORBIDDEN_LOW_CODE_POINT) {
    return true;
  }
  if (codePoint === TAB_CODE_POINT || codePoint === LINE_FEED_CODE_POINT) {
    return false;
  }
  if (codePoint >= FORBIDDEN_MIDDLE_START && codePoint <= FORBIDDEN_MIDDLE_END) {
    return true;
  }
  return codePoint >= FORBIDDEN_UPPER_START && codePoint <= FORBIDDEN_UPPER_END;
}
function hasIllegalControlChar(text) {
  for (const character of text) {
    if (isForbiddenControl(character.codePointAt(0) ?? 0)) {
      return true;
    }
  }
  return false;
}

// service/prompt.ts
var STARTING_PROMPT_MAX_CODE_POINTS = 2000;
var PROMPT_FINGERPRINT_PREFIX = "mtp-";
var FINGERPRINT_HEX_CHARS = 32;
var REMEDIATION_TYPE = "startingPrompt must be text; send it absent or null to leave the starting prompt unset";
var REMEDIATION_CAP = `startingPrompt must be at most ${STARTING_PROMPT_MAX_CODE_POINTS}` + " characters (Unicode code points) after trimming";
var REMEDIATION_CONTROL = "startingPrompt must not contain null or control characters other than newline and tab";
var REMEDIATION_MARKER = "startingPrompt must not contain a line beginning with" + ' "--- BEGIN " or "--- END " (reserved composition markers)';
function credentialRemediation(label) {
  return `startingPrompt must not contain credential-shaped material (matched shape: ${label})`;
}
function refuse(remediation) {
  return { ok: false, issue: { field: "startingPrompt", remediation } };
}
function validateStartingPrompt(raw) {
  if (raw === undefined || raw === null) {
    return { ok: true, prompt: null };
  }
  if (typeof raw !== "string") {
    return refuse(REMEDIATION_TYPE);
  }
  const trimmed = trimPrompt(raw);
  if (trimmed === "") {
    return { ok: true, prompt: null };
  }
  const text = normaliseLineEndings(trimmed);
  if (countCodePoints(text) > STARTING_PROMPT_MAX_CODE_POINTS) {
    return refuse(REMEDIATION_CAP);
  }
  if (hasIllegalControlChar(text)) {
    return refuse(REMEDIATION_CONTROL);
  }
  if (hasReservedMarkerLine(text)) {
    return refuse(REMEDIATION_MARKER);
  }
  const label = findSecretLeak(text);
  if (label !== null) {
    return refuse(credentialRemediation(label));
  }
  return { ok: true, prompt: text };
}
function promptFingerprint(text) {
  const digest = createHash("sha256").update(text, "utf8").digest("hex");
  return `${PROMPT_FINGERPRINT_PREFIX}${digest.slice(0, FINGERPRINT_HEX_CHARS)}`;
}
function promptTierOf(record) {
  const verdict = validateStartingPrompt(record.startingPrompt);
  if (!verdict.ok || verdict.prompt === null) {
    return null;
  }
  const text = verdict.prompt;
  return { text, fingerprint: promptFingerprint(text), length: countCodePoints(text) };
}
var TIER_GAP = `

`;
function composePromptBody(tiers) {
  const set = [];
  for (const tier of [tiers.global, tiers.account, tiers.binding]) {
    if (tier !== null && tier !== "") {
      set.push(tier);
    }
  }
  return set.join(TIER_GAP);
}
function resolveTier(record) {
  if (record === undefined || record === null) {
    return { state: "unset" };
  }
  if (typeof record !== "object" || Array.isArray(record)) {
    return { state: "refused" };
  }
  const verdict = validateStartingPrompt(record.startingPrompt);
  if (!verdict.ok) {
    return { state: "refused" };
  }
  return verdict.prompt === null ? { state: "unset" } : { state: "set", text: verdict.prompt };
}
function resolvePromptSnapshot(tiers) {
  const resolved = {
    global: resolveTier(tiers.global),
    account: resolveTier(tiers.account),
    binding: resolveTier(tiers.binding)
  };
  if (PROMPT_SOURCE_ORDER.some((source) => resolved[source].state === "refused")) {
    return null;
  }
  const text = composePromptBody({
    global: resolved.global.state === "set" ? resolved.global.text : null,
    account: resolved.account.state === "set" ? resolved.account.text : null,
    binding: resolved.binding.state === "set" ? resolved.binding.text : null
  });
  if (text === "") {
    return null;
  }
  const sources = PROMPT_SOURCE_ORDER.filter((source) => resolved[source].state === "set");
  return { text, fingerprint: promptFingerprint(text), length: countCodePoints(text), sources };
}
function promptStackMaxCodePoints(sourceCount) {
  return sourceCount * STARTING_PROMPT_MAX_CODE_POINTS + 2 * (sourceCount - 1);
}
function storedText(candidate) {
  const { text } = candidate;
  return typeof text === "string" && text !== "" ? text : null;
}
function storedFingerprint(candidate) {
  const { fingerprint } = candidate;
  return typeof fingerprint === "string" && PROMPT_FINGERPRINT_PATTERN.test(fingerprint) ? fingerprint : null;
}
function storedLength(candidate) {
  const { length } = candidate;
  return typeof length === "number" && Number.isSafeInteger(length) && length > 0 ? length : null;
}
function storedSources(candidate) {
  const { sources } = candidate;
  if (!Array.isArray(sources) || sources.length === 0 || !isPromptSourceList(sources)) {
    return null;
  }
  return sources;
}
function readStoredSnapshot(candidate) {
  const text = storedText(candidate);
  const fingerprint = storedFingerprint(candidate);
  const length = storedLength(candidate);
  const sources = storedSources(candidate);
  if (text === null || fingerprint === null || length === null || sources === null || countCodePoints(text) !== length) {
    return null;
  }
  if (length > promptStackMaxCodePoints(sources.length)) {
    return null;
  }
  if (findSecretLeak(text) !== null) {
    return null;
  }
  return { text, fingerprint, length, sources };
}
function parseStoredPromptSnapshot(raw) {
  if (raw === undefined || raw === null) {
    return { status: "unset" };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const snapshot = readStoredSnapshot(raw);
  return snapshot === null ? null : { status: "set", snapshot };
}

// service/account-prompt-audit.ts
var ACCOUNT_PROMPT_UPDATED_EVENT = "account.prompt-updated";
var observationStates = new WeakMap;
function stateFor(store) {
  let state = observationStates.get(store);
  if (state === undefined) {
    state = { baseline: new Map, seeded: false, chain: Promise.resolve() };
    observationStates.set(store, state);
  }
  return state;
}
async function seedBaseline(store, baseline) {
  const trail = await store.readLines(AUDIT_FILE, parseAuditEntry);
  const highest = new Map;
  for (const entry of trail.entries) {
    if (entry.eventType !== ACCOUNT_PROMPT_UPDATED_EVENT || entry.entity.kind !== "account") {
      continue;
    }
    const { id: numericUserId } = entry.entity;
    const recorded = entry.details.promptFingerprint;
    const fingerprint = typeof recorded === "string" && entry.details.promptPresent === true && PROMPT_FINGERPRINT_PATTERN.test(recorded) ? recorded : null;
    const prior = highest.get(numericUserId);
    if (prior === undefined || entry.seq > prior.seq) {
      highest.set(numericUserId, { seq: entry.seq, fingerprint });
    }
  }
  for (const [numericUserId, value] of highest) {
    baseline.set(numericUserId, value.fingerprint);
  }
}
async function runAccountPromptChain(store, task) {
  const state = stateFor(store);
  const start = async () => {
    if (!state.seeded) {
      await seedBaseline(store, state.baseline);
      state.seeded = true;
    }
    return await task();
  };
  const run = state.chain.then(start, start);
  state.chain = run;
  return await run;
}
async function appendAccountPromptChange(input) {
  const isPresent = input.current !== null;
  let decision;
  if (input.current === null) {
    decision = "cleared";
  } else {
    decision = input.previousFingerprint === null ? "set" : "changed";
  }
  await appendAudit(input.store, {
    eventType: ACCOUNT_PROMPT_UPDATED_EVENT,
    actorSource: input.actor,
    entity: { kind: "account", id: input.numericUserId },
    correlationId: newCorrelationId(),
    decision,
    reason: null,
    details: {
      promptPresent: isPresent,
      promptFingerprint: input.current?.fingerprint ?? null,
      promptLength: input.current?.length ?? 0,
      previousFingerprint: input.previousFingerprint
    }
  });
}
async function recordOneChange(context) {
  const { input, account, snapshot, current, previous } = context;
  try {
    await appendAccountPromptChange({
      store: input.store,
      numericUserId: account.numericUserId,
      current: snapshot,
      previousFingerprint: previous,
      actor: input.actor
    });
    return 1;
  } catch (cause) {
    input.log.warn("account prompt change audit row could not be appended", {
      numericUserId: account.numericUserId,
      promptFingerprint: current,
      errorKind: cause instanceof Error ? cause.name : typeof cause
    });
    return 0;
  }
}
async function recordAccountPromptChanges(input) {
  const state = stateFor(input.store);
  const observed = new Set;
  let rows = 0;
  for (const account of input.accounts) {
    observed.add(account.numericUserId);
    const snapshot = promptTierOf(account);
    const current = snapshot === null ? null : snapshot.fingerprint;
    const previous = state.baseline.get(account.numericUserId) ?? null;
    state.baseline.set(account.numericUserId, current);
    if (previous === current) {
      continue;
    }
    rows += await recordOneChange({ input, account, snapshot, current, previous });
  }
  const absent = input.absent ?? [];
  for (const numericUserId of absent) {
    state.baseline.delete(numericUserId);
  }
  if (input.complete === true) {
    for (const numericUserId of state.baseline.keys()) {
      if (!observed.has(numericUserId)) {
        state.baseline.delete(numericUserId);
      }
    }
  }
  return rows;
}
async function observeAccountPromptChanges(input) {
  return await runAccountPromptChain(input.store, async () => await recordAccountPromptChanges(input));
}

// service/accounts/model.ts
var ACCOUNT_STATES = new Set([
  "pending_handoff",
  "verifying",
  "active",
  "rejected",
  "revoked",
  "error"
]);
var CONNECTION_STATES = new Set([
  "connected",
  "auth-failed",
  "rate-limited",
  "offline"
]);
var CREDENTIAL_KINDS = new Set(["fine-grained", "classic", "unknown"]);
var NUMERIC_ID_MAX_CHARS = 20;
function isNumericUserId(value) {
  return typeof value === "string" && /^\d+$/.test(value) && value.length <= NUMERIC_ID_MAX_CHARS;
}
function isAccountState(value) {
  return typeof value === "string" && ACCOUNT_STATES.has(value);
}
function isConnectionState(value) {
  return typeof value === "string" && CONNECTION_STATES.has(value);
}
function isCredentialKind(value) {
  return typeof value === "string" && CREDENTIAL_KINDS.has(value);
}
function isScopeCheck(raw) {
  if (!isRecord(raw) || typeof raw.checkedAt !== "string" || !isRecord(raw.results)) {
    return false;
  }
  const { results } = raw;
  return ["metadata", "issues", "pull-requests", "contents"].every((capability) => {
    const value = results[capability];
    return typeof value === "string" && ["ok", "missing", "unknown"].includes(value);
  });
}
function isCredentialRecord(raw) {
  return isRecord(raw) && typeof raw.token === "string" && raw.token !== "" && isCredentialKind(raw.kind) && typeof raw.verifiedAt === "string";
}
function isNullableString(value) {
  return value === null || typeof value === "string";
}
function isOptionalNullableString(value) {
  return value === undefined || value === null || typeof value === "string";
}
function readAccountStrings(raw) {
  const { login, expectedLogin, displayName, verifiedAt, errorReason, createdAt, updatedAt } = raw;
  if (typeof login !== "string" || login === "" || typeof verifiedAt !== "string" || typeof createdAt !== "string" || typeof updatedAt !== "string" || !isNullableString(expectedLogin) || !isNullableString(errorReason) || !isOptionalNullableString(displayName)) {
    return null;
  }
  return {
    login,
    expectedLogin,
    displayName: displayName ?? null,
    verifiedAt,
    errorReason,
    createdAt,
    updatedAt
  };
}
function parseStoredAccount(raw, note) {
  if (!isRecord(raw) || !isNumericUserId(raw.numericUserId)) {
    return null;
  }
  const prompt = validateStartingPrompt(raw.startingPrompt);
  if (!prompt.ok) {
    note.reason ??= `${prompt.issue.field}: ${prompt.issue.remediation}`;
    return null;
  }
  const strings = readAccountStrings(raw);
  if (strings === null || !isCredentialRecord(raw.credential) || !isScopeCheck(raw.scopeCheck) || !isAccountState(raw.state) || !isConnectionState(raw.connectionState)) {
    return null;
  }
  return {
    numericUserId: raw.numericUserId,
    ...strings,
    startingPrompt: prompt.prompt,
    credential: raw.credential,
    scopeCheck: raw.scopeCheck,
    state: raw.state,
    connectionState: raw.connectionState
  };
}
function toAccountDto(account) {
  return {
    numericUserId: account.numericUserId,
    login: account.login,
    expectedLogin: account.expectedLogin,
    displayName: account.displayName,
    startingPrompt: account.startingPrompt,
    state: account.state,
    connectionState: account.connectionState,
    verifiedAt: account.verifiedAt,
    scopeCheck: account.scopeCheck,
    errorReason: account.errorReason,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt
  };
}
var DISPLAY_NAME_MAX_CODE_POINTS = 80;
var DISPLAY_NAME_TYPE = "displayName must be text, or null to clear it";
var DISPLAY_NAME_CAP = `displayName must be at most ${DISPLAY_NAME_MAX_CODE_POINTS} characters` + " (Unicode code points) after trimming";
var DISPLAY_NAME_CONTROL = "displayName must not contain control characters";
var LAST_C0 = 31;
var FIRST_C1 = 127;
var LAST_C1 = 159;
function hasControlCharacter(value) {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= LAST_C0 || code >= FIRST_C1 && code <= LAST_C1) {
      return true;
    }
  }
  return false;
}
function validateDisplayName(raw) {
  if (raw !== null && typeof raw !== "string") {
    return { ok: false, issue: { field: "displayName", remediation: DISPLAY_NAME_TYPE } };
  }
  if (raw === null) {
    return { ok: true, displayName: null };
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { ok: true, displayName: null };
  }
  if ([...trimmed].length > DISPLAY_NAME_MAX_CODE_POINTS) {
    return { ok: false, issue: { field: "displayName", remediation: DISPLAY_NAME_CAP } };
  }
  const label = findSecretLeak(trimmed);
  if (label !== null) {
    return {
      ok: false,
      issue: {
        field: "displayName",
        remediation: `displayName must not contain credential-shaped material (matched shape: ${label})`
      }
    };
  }
  if (hasControlCharacter(trimmed)) {
    return { ok: false, issue: { field: "displayName", remediation: DISPLAY_NAME_CONTROL } };
  }
  return { ok: true, displayName: trimmed };
}

// service/accounts/store.ts
var ACCOUNTS_DIR = "accounts";
var BINDINGS_FILE = "bindings.json";
var ACCOUNT_FILE_SUFFIX = ".json";
function accountPath(numericUserId) {
  if (!isNumericUserId(numericUserId)) {
    throw new Error("account paths key on a numeric GitHub user id only");
  }
  return `${ACCOUNTS_DIR}/${numericUserId}${ACCOUNT_FILE_SUFFIX}`;
}
function reportQuarantine(input) {
  const { result, subject, log, note } = input;
  if (result.status === "quarantined") {
    log.warn("stored record was unusable and has been set aside", {
      subject,
      quarantinePath: result.quarantinePath,
      ...note.reason !== null && { reason: note.reason }
    });
  }
}
async function readAccountUnobserved(input) {
  const { store, numericUserId, log } = input;
  const note = { reason: null };
  const result = await store.readJson(accountPath(numericUserId), (raw) => parseStoredAccount(raw, note));
  reportQuarantine({ result, subject: `account ${numericUserId}`, log, note });
  return result.status === "ok" ? result.value : null;
}
async function readAccount(input) {
  const account = await readAccountUnobserved(input);
  await observeAccountPromptChanges({
    store: input.store,
    log: input.log,
    accounts: account === null ? [] : [account],
    ...account === null && { absent: [input.numericUserId] },
    actor: "service"
  });
  return account;
}
async function listAccountsUnobserved(store, log) {
  const names = await store.listDir(ACCOUNTS_DIR);
  const accounts = [];
  for (const name of names) {
    if (!name.endsWith(ACCOUNT_FILE_SUFFIX)) {
      continue;
    }
    const id = name.slice(0, -ACCOUNT_FILE_SUFFIX.length);
    if (!isNumericUserId(id)) {
      continue;
    }
    const account = await readAccountUnobserved({ store, numericUserId: id, log });
    if (account !== null) {
      accounts.push(account);
    }
  }
  return accounts.toSorted((left, right) => left.numericUserId.localeCompare(right.numericUserId));
}
async function listAccounts(store, log) {
  const accounts = await listAccountsUnobserved(store, log);
  await observeAccountPromptChanges({ store, log, accounts, complete: true, actor: "service" });
  return accounts;
}
async function writeAccount(store, account) {
  await store.writeJson(accountPath(account.numericUserId), account);
}
async function removeAccount(store, numericUserId) {
  await store.removeFile(accountPath(numericUserId));
}
async function bindingsReferencing(store, numericUserId) {
  const result = await store.readJson(BINDINGS_FILE, (raw) => Array.isArray(raw) ? raw : null);
  if (result.status !== "ok") {
    return [];
  }
  const matches = [];
  for (const entry of result.value) {
    if (!isRecord(entry) || entry.accountNumericUserId !== numericUserId) {
      continue;
    }
    if (typeof entry.bindingId === "string") {
      matches.push({ bindingId: entry.bindingId, raw: entry });
    }
  }
  return matches;
}
async function disableBindings(store, bindings) {
  const disabled = bindings.map((binding) => ({
    bindingId: binding.bindingId,
    raw: { ...binding.raw, state: "disabled" }
  }));
  const result = await store.readJson(BINDINGS_FILE, (raw) => Array.isArray(raw) ? raw : null);
  const entries = result.status === "ok" ? result.value.map((entry) => {
    const replaced = disabled.find((binding) => isRecord(entry) && entry.bindingId === binding.bindingId);
    return replaced?.raw ?? entry;
  }) : disabled.map((binding) => binding.raw);
  await store.writeJson(BINDINGS_FILE, entries);
  return disabled;
}

// service/accounts/reconcile.ts
var INTERRUPTED_HANDOFF_REASON = "interrupted-handoff";
var TRANSIENT_STATES = new Set(["pending_handoff", "verifying"]);
async function markInterrupted(input) {
  const { store, account, correlationId } = input;
  const marked = {
    ...account,
    state: "error",
    errorReason: INTERRUPTED_HANDOFF_REASON,
    updatedAt: nowIso()
  };
  await writeAccount(store, marked);
  await appendAudit(store, {
    eventType: "account.error",
    actorSource: "service",
    entity: { kind: "account", id: account.numericUserId },
    decision: "error",
    reason: INTERRUPTED_HANDOFF_REASON,
    correlationId,
    details: { previousState: account.state, operation: "startup-reconciliation" }
  });
  return marked;
}
async function restoreAccount(input) {
  const { store, marked, outcome, correlationId } = input;
  const at = nowIso();
  const restored = {
    ...marked,
    login: outcome.identity.login,
    credential: { ...marked.credential, kind: outcome.credentialKind, verifiedAt: at },
    scopeCheck: outcome.scopeCheck,
    state: "active",
    connectionState: "connected",
    verifiedAt: at,
    errorReason: null,
    updatedAt: at
  };
  await writeAccount(store, restored);
  await appendAudit(store, {
    eventType: "account.verified",
    actorSource: "service",
    entity: { kind: "account", id: restored.numericUserId },
    decision: "accept",
    reason: "interrupted handoff re-verified at startup",
    correlationId,
    details: { login: restored.login, operation: "startup-reconciliation" }
  });
  return restored;
}
async function reconcileAccount(deps, account) {
  const { store } = deps;
  if (store === null) {
    return { marked: false, restored: false };
  }
  const correlationId = newCorrelationId();
  const marked = await markInterrupted({ store, account, correlationId });
  deps.log.info("interrupted handoff found at startup", {
    numericUserId: account.numericUserId,
    previousState: account.state
  });
  let outcome;
  try {
    outcome = await deps.github.verify(account.credential.token);
  } catch (error) {
    deps.log.warn("startup re-verification failed to run", {
      numericUserId: account.numericUserId,
      errorKind: error instanceof Error ? error.name : typeof error
    });
    return { marked: true, restored: false };
  }
  if (outcome.kind !== "ok" || outcome.identity.numericUserId !== account.numericUserId) {
    deps.log.info("startup re-verification did not restore the account", {
      numericUserId: account.numericUserId,
      outcome: outcome.kind
    });
    return { marked: true, restored: false };
  }
  await restoreAccount({ store, marked, outcome, correlationId });
  deps.log.info("interrupted handoff restored at startup", {
    numericUserId: account.numericUserId
  });
  return { marked: true, restored: true };
}
async function reconcileInterruptedAccounts(deps) {
  if (deps.store === null) {
    return { examined: 0, marked: 0, restored: 0 };
  }
  const accounts = await listAccounts(deps.store, deps.log);
  const stranded = accounts.filter((account) => TRANSIENT_STATES.has(account.state));
  let marked = 0;
  let restored = 0;
  for (const account of stranded) {
    const outcome = await reconcileAccount(deps, account);
    marked += outcome.marked ? 1 : 0;
    restored += outcome.restored ? 1 : 0;
  }
  return { examined: stranded.length, marked, restored };
}

// service/config.ts
import { join } from "node:path";

// service/config-agent.ts
var EXPECTED_AGENT_RULE = {
  maxLength: 80,
  format: "letters, digits, and . _ - @ : / (a single token, no spaces); empty means no baseline",
  pattern: /^[A-Za-z0-9.@/_:-]+$/
};
function expectedAgentIssue(value) {
  if (typeof value !== "string") {
    return [
      {
        field: "expectedAgent",
        remediation: "set expectedAgent to a string; leave it empty for no baseline"
      }
    ];
  }
  const text = value.trim();
  if (text.length > EXPECTED_AGENT_RULE.maxLength) {
    return [
      {
        field: "expectedAgent",
        remediation: `set expectedAgent to at most ${EXPECTED_AGENT_RULE.maxLength} characters`
      }
    ];
  }
  if (text === "") {
    return [];
  }
  if (!EXPECTED_AGENT_RULE.pattern.test(text)) {
    return [
      {
        field: "expectedAgent",
        remediation: "set expectedAgent to letters, digits, and . _ - @ : / with no spaces"
      }
    ];
  }
  if (findSecretLeak(text) !== null) {
    return [{ field: "expectedAgent", remediation: "set expectedAgent to an agent name, not a credential" }];
  }
  return [];
}

// service/config-prompt.ts
function startingPromptIssue(value) {
  if (typeof value !== "string") {
    return [
      {
        field: "startingPrompt",
        remediation: "set startingPrompt to a string; leave it empty for an unset global tier"
      }
    ];
  }
  const verdict = validateStartingPrompt(value);
  return verdict.ok ? [] : [verdict.issue];
}

// service/http.ts
var LOOPBACK_HOST = "127.0.0.1";
var MAX_TARGET_CHARS = 2000;
var REQUEST_BODY_MAX_CHARS = 60000;
var RESPONSE_BODY_MAX_CHARS = 256000;
var JSON_CONTENT_TYPE = "application/json; charset=utf-8";
var MAX_ECHOED_FIELD_CHARS = 64;
function truncatedFieldName(name) {
  return name.length > MAX_ECHOED_FIELD_CHARS ? `${name.slice(0, MAX_ECHOED_FIELD_CHARS)}…` : name;
}
var STATUS = {
  ok: 200,
  created: 201,
  badRequest: 400,
  unauthorized: 401,
  notFound: 404,
  methodNotAllowed: 405,
  conflict: 409,
  payloadTooLarge: 413,
  validation: 422,
  tooManyRequests: 429,
  internal: 500,
  badGateway: 502,
  storageUnavailable: 503
};
function errorBody(details) {
  return {
    error: {
      code: details.code,
      message: details.message,
      ...details.correlationId !== undefined && { correlationId: details.correlationId },
      ...details.issues !== undefined && { issues: details.issues },
      ...details.reasonClass !== undefined && { reasonClass: details.reasonClass }
    }
  };
}
function errorResponse(status, details) {
  return { status, body: errorBody(details) };
}
function validationResponse(issues) {
  return errorResponse(STATUS.validation, {
    code: "validation",
    message: issues.map((issue) => `${issue.field}: ${issue.remediation}`).join("; "),
    issues
  });
}
var RETRY_AFTER_HEADER = "retry-after";
function throttleResponse(options) {
  const headers = { [RETRY_AFTER_HEADER]: String(options.retryAfterSeconds) };
  return {
    status: options.status,
    body: errorBody({ code: options.code, message: options.message }),
    headers
  };
}
function unauthorizedResponse() {
  return errorResponse(STATUS.unauthorized, {
    code: "unauthorized",
    message: "service authentication failed"
  });
}
function storageUnavailableResponse() {
  return errorResponse(STATUS.storageUnavailable, {
    code: "storage-unavailable",
    message: "the data directory is not writable; setup cannot continue until it is"
  });
}
function parseRequestTarget(raw) {
  if (raw === undefined || !raw.startsWith("/") || raw.length > MAX_TARGET_CHARS) {
    return null;
  }
  try {
    const url = new URL(raw, `http://${LOOPBACK_HOST}`);
    return url.host === LOOPBACK_HOST ? url : null;
  } catch {
    return null;
  }
}
function serializeBody(body) {
  try {
    const text = JSON.stringify(body);
    if (text.length > RESPONSE_BODY_MAX_CHARS) {
      return {
        ok: false,
        fallback: errorResponse(STATUS.internal, {
          code: "response-too-large",
          message: "response exceeded the documented size cap; paginate instead"
        })
      };
    }
    return { ok: true, text };
  } catch {
    return {
      ok: false,
      fallback: errorResponse(STATUS.internal, {
        code: "internal",
        message: "response could not be serialized"
      })
    };
  }
}

// service/config.ts
var CONFIG_FILE = "config.json";
var LOG_LEVEL_VALUES = ["debug", "info", "warn", "error"];
var LOG_LEVELS = new Set(LOG_LEVEL_VALUES);
var NUMERIC_BOUNDS = {
  intervalMs: { min: 15000, max: 300000, unit: "milliseconds" },
  overlapMs: { min: 60000, max: 7200000, unit: "milliseconds" },
  perPage: { min: 1, max: 30, unit: "items per page" },
  retryMaxAttempts: { min: 1, max: 10, unit: "attempts" },
  retryBaseMs: { min: 1000, max: 60000, unit: "milliseconds" },
  retryMaxMs: { min: 5000, max: 300000, unit: "milliseconds" },
  auditRetentionDays: { min: 7, max: 3650, unit: "days" },
  auditMaxEntries: { min: 1000, max: 1e6, unit: "entries" },
  excerptRetentionDays: { min: 1, max: 365, unit: "days" },
  leaseMs: { min: 30000, max: 600000, unit: "milliseconds" },
  resultDeadlineMs: { min: 30000, max: 600000, unit: "milliseconds" }
};
var NUMERIC_FIELDS = Object.keys(NUMERIC_BOUNDS);
var DEFAULT_CONFIG = {
  startingPrompt: "",
  intervalMs: 60000,
  overlapMs: 600000,
  perPage: 30,
  retryMaxAttempts: 5,
  retryBaseMs: 5000,
  retryMaxMs: 60000,
  auditRetentionDays: 180,
  auditMaxEntries: 50000,
  excerptRetentionDays: 30,
  leaseMs: 120000,
  resultDeadlineMs: 120000,
  logLevel: "info",
  expectedAgent: ""
};
function isLogLevel(value) {
  return typeof value === "string" && LOG_LEVELS.has(value);
}
function numericIssue(raw, field) {
  const bounds = NUMERIC_BOUNDS[field];
  const value = raw[field];
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= bounds.min && value <= bounds.max) {
    return [];
  }
  return [
    {
      field,
      remediation: `set ${field} to an integer between ${bounds.min} and ${bounds.max} ${bounds.unit}`
    }
  ];
}
function retryOrderIssue(raw) {
  const base = raw.retryBaseMs;
  const ceiling = raw.retryMaxMs;
  if (typeof base === "number" && typeof ceiling === "number" && base > ceiling) {
    return [
      {
        field: "retryMaxMs",
        remediation: "set retryMaxMs to a value greater than or equal to retryBaseMs"
      }
    ];
  }
  return [];
}
function unknownFieldIssue(key) {
  if (findSecretLeak(key) !== null) {
    return {
      field: "<withheld>",
      remediation: "remove this key; only the documented ServiceConfig fields are accepted"
    };
  }
  return {
    field: truncatedFieldName(key),
    remediation: "remove this key; only the documented ServiceConfig fields are accepted"
  };
}
function isKnownField(key) {
  return Object.hasOwn(DEFAULT_CONFIG, key);
}
function collectIssues(raw) {
  const issues = [...startingPromptIssue(raw.startingPrompt)];
  for (const field of NUMERIC_FIELDS) {
    issues.push(...numericIssue(raw, field));
  }
  if (!isLogLevel(raw.logLevel)) {
    issues.push({
      field: "logLevel",
      remediation: "set logLevel to one of debug, info, warn, error"
    });
  }
  issues.push(...expectedAgentIssue(raw.expectedAgent), ...retryOrderIssue(raw));
  for (const key of Object.keys(raw)) {
    if (!isKnownField(key)) {
      issues.push(unknownFieldIssue(key));
    }
  }
  return issues;
}
function readNumber(raw, field) {
  const value = raw[field];
  if (typeof value !== "number") {
    throw new TypeError(`validated configuration is missing ${field}`);
  }
  return value;
}
function readLogLevel(raw) {
  const value = raw.logLevel;
  if (!isLogLevel(value)) {
    throw new Error("validated configuration is missing logLevel");
  }
  return value;
}
function readExpectedAgent(raw) {
  const value = raw.expectedAgent;
  if (typeof value !== "string") {
    throw new TypeError("validated configuration is missing expectedAgent");
  }
  return value.trim();
}
function readStartingPrompt(raw) {
  const verdict = validateStartingPrompt(raw.startingPrompt);
  if (!verdict.ok) {
    throw new Error("validated configuration is missing startingPrompt");
  }
  return verdict.prompt ?? "";
}
function buildConfig(raw) {
  return {
    intervalMs: readNumber(raw, "intervalMs"),
    overlapMs: readNumber(raw, "overlapMs"),
    perPage: readNumber(raw, "perPage"),
    retryMaxAttempts: readNumber(raw, "retryMaxAttempts"),
    retryBaseMs: readNumber(raw, "retryBaseMs"),
    retryMaxMs: readNumber(raw, "retryMaxMs"),
    auditRetentionDays: readNumber(raw, "auditRetentionDays"),
    auditMaxEntries: readNumber(raw, "auditMaxEntries"),
    excerptRetentionDays: readNumber(raw, "excerptRetentionDays"),
    leaseMs: readNumber(raw, "leaseMs"),
    resultDeadlineMs: readNumber(raw, "resultDeadlineMs"),
    logLevel: readLogLevel(raw),
    expectedAgent: readExpectedAgent(raw),
    startingPrompt: readStartingPrompt(raw)
  };
}
function validateConfig(raw) {
  if (!isRecord(raw)) {
    return {
      ok: false,
      issues: [{ field: "body", remediation: "send a JSON object holding the full ServiceConfig" }]
    };
  }
  const issues = collectIssues(raw);
  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return { ok: true, config: buildConfig(raw) };
}
function parseStoredConfig(raw) {
  if (!isRecord(raw)) {
    return null;
  }
  const filled = { ...raw };
  const defaultsApplied = [];
  for (const field of Object.keys(DEFAULT_CONFIG)) {
    if (Object.hasOwn(filled, field)) {
      continue;
    }
    filled[field] = DEFAULT_CONFIG[field];
    defaultsApplied.push(field);
  }
  const validation = validateConfig(filled);
  return validation.ok ? { config: validation.config, defaultsApplied } : null;
}
function configFromStore(result, log) {
  if (result.status === "ok") {
    return {
      config: result.value.config,
      source: "stored",
      defaultsApplied: result.value.defaultsApplied
    };
  }
  if (result.status === "quarantined") {
    log.warn("stored configuration was unusable and has been set aside", {
      quarantinePath: result.quarantinePath
    });
    return { config: DEFAULT_CONFIG, source: "quarantined", defaultsApplied: [] };
  }
  return { config: DEFAULT_CONFIG, source: "default", defaultsApplied: [] };
}
var QUARANTINE_EVIDENCE_PREFIX = `${CONFIG_FILE}.corrupt-`;
async function latestQuarantineEvidence(store) {
  const entries = await store.listDir(".");
  const quarantined = entries.filter((entry) => entry.startsWith(QUARANTINE_EVIDENCE_PREFIX)).toSorted((left, right) => left.localeCompare(right));
  const newest = quarantined.at(-1);
  return newest === undefined ? null : join(store.dataDir, newest);
}
async function readStoredConfig(input) {
  const result = await input.store.readJson(CONFIG_FILE, parseStoredConfig);
  if (result.status !== "absent") {
    return configFromStore(result, input.log);
  }
  const evidence = await latestQuarantineEvidence(input.store);
  return configFromStore(evidence === null ? result : { status: "quarantined", quarantinePath: evidence }, input.log);
}

// service/github.ts
var API_ORIGIN = "https://api.github.com";
var USER_PATH = "/user";
var RATE_LIMIT_PATH = "/rate_limit";
var GITHUB_TIMEOUT_MS = 15000;
var API_VERSION = "2022-11-28";
var USER_AGENT = "mecha-turk-extension";
var DEFAULT_RETRY_AFTER_SECONDS = 60;
var TIMEOUT_ERROR_NAME = "TimeoutError";
var SCOPE_CAPABILITIES = ["metadata", "issues", "pull-requests", "contents"];
var CLASSIC_READ_SCOPES = ["repo", "public_repo"];
var MS_PER_SECOND = 1000;
var STATUS_UNAUTHORIZED = 401;
var STATUS_FORBIDDEN = 403;
var STATUS_NOT_FOUND = 404;
var STATUS_TOO_MANY_REQUESTS = 429;
var RATE_REMAINING_HEADER = "x-ratelimit-remaining";
var RETRY_AFTER_HEADER2 = "retry-after";
var SSO_HEADER = "x-github-sso";
var OAUTH_SCOPES_HEADER = "x-oauth-scopes";
function credentialKindOf(token) {
  if (token.startsWith("github_pat_")) {
    return "fine-grained";
  }
  return /^gh[pousr]_/.test(token) ? "classic" : "unknown";
}
function requestHeaders(token) {
  const entries = [
    ["authorization", `Bearer ${token}`],
    ["accept", "application/vnd.github+json"],
    ["x-github-api-version", API_VERSION],
    ["user-agent", USER_AGENT]
  ];
  return Object.fromEntries(entries);
}
function readIdentity(text) {
  const parsed = parseJsonText(text);
  if (!parsed.ok || !isRecord(parsed.value)) {
    return null;
  }
  const { id, login } = parsed.value;
  if (login === "" || typeof login !== "string" || typeof id !== "number" || !Number.isSafeInteger(id)) {
    return null;
  }
  return { numericUserId: String(id), login };
}
function scopeVerdict(granted) {
  if (granted.length === 0) {
    return "unknown";
  }
  return CLASSIC_READ_SCOPES.some((scope) => granted.includes(scope)) ? "ok" : "missing";
}
function scopeResults(granted) {
  const verdict = scopeVerdict(granted);
  const entries = SCOPE_CAPABILITIES.map((capability) => [capability, verdict]);
  return Object.fromEntries(entries);
}
function buildScopeCheck(header) {
  const granted = (header ?? "").split(",").map((scope) => scope.trim()).filter((scope) => scope !== "");
  return { checkedAt: nowIso(), results: scopeResults(granted) };
}
function retryAfterOf(response) {
  const header = response.headers.get(RETRY_AFTER_HEADER2);
  if (header === null || !/^\d+$/.test(header)) {
    return DEFAULT_RETRY_AFTER_SECONDS;
  }
  return Number(header);
}
async function readRateBaseline(response) {
  const parsed = parseJsonText(await response.text());
  if (!parsed.ok || !isRecord(parsed.value) || !isRecord(parsed.value.core)) {
    return null;
  }
  const { limit, remaining, reset } = parsed.value.core;
  if (typeof limit !== "number" || typeof remaining !== "number" || typeof reset !== "number" || !Number.isFinite(reset)) {
    return null;
  }
  const resetDate = new Date(reset * MS_PER_SECOND);
  if (Number.isNaN(resetDate.getTime())) {
    return null;
  }
  return { limit, remaining, resetAt: resetDate.toISOString() };
}
function isRateLimited(response) {
  return response.status === STATUS_TOO_MANY_REQUESTS || response.headers.get(RATE_REMAINING_HEADER) === "0" || response.headers.has(RETRY_AFTER_HEADER2);
}
function isSsoRefusal(response) {
  const sso = response.headers.get(SSO_HEADER);
  return response.status === STATUS_FORBIDDEN && sso?.includes("required") === true;
}
function missingScopeReason(scopeCheck) {
  const missing = SCOPE_CAPABILITIES.find((capability) => scopeCheck.results[capability] === "missing");
  return `scope-missing:${missing ?? "metadata"}`;
}
function classifyRejection(response, scopeCheck) {
  const { status } = response;
  if (isRateLimited(response)) {
    return { kind: "rate-limited", retryAfterSeconds: retryAfterOf(response) };
  }
  if (status === STATUS_UNAUTHORIZED || status === STATUS_NOT_FOUND) {
    return { kind: "rejected", reason: "auth-failed" };
  }
  if (isSsoRefusal(response)) {
    return { kind: "rejected", reason: "sso-required" };
  }
  if (status === STATUS_FORBIDDEN) {
    return { kind: "rejected", reason: missingScopeReason(scopeCheck) };
  }
  return { kind: "unavailable", detail: "upstream" };
}
async function readRateBaselineQuietly(fetchImpl, token) {
  try {
    const response = await fetchImpl(`${API_ORIGIN}${RATE_LIMIT_PATH}`, {
      method: "GET",
      headers: requestHeaders(token),
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS)
    });
    return response.ok ? await readRateBaseline(response) : null;
  } catch {
    return null;
  }
}
function transportDetail(error) {
  return error instanceof Error && error.name === TIMEOUT_ERROR_NAME ? "timeout" : "offline";
}
function createGitHubVerifier(fetchImpl = (url, init) => globalThis.fetch(url, init)) {
  return {
    verify: async (token) => {
      let response;
      try {
        response = await fetchImpl(`${API_ORIGIN}${USER_PATH}`, {
          method: "GET",
          headers: requestHeaders(token),
          signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS)
        });
      } catch (error) {
        return { kind: "unavailable", detail: transportDetail(error) };
      }
      const scopeCheck = buildScopeCheck(response.headers.get(OAUTH_SCOPES_HEADER));
      if (!response.ok) {
        return classifyRejection(response, scopeCheck);
      }
      const identity = readIdentity(await response.text());
      if (identity === null) {
        return { kind: "rejected", reason: "auth-failed" };
      }
      return {
        kind: "ok",
        identity,
        scopeCheck,
        credentialKind: credentialKindOf(token),
        rateBaseline: await readRateBaselineQuietly(fetchImpl, token)
      };
    }
  };
}

// service/audit-protect.ts
var DECISION_EVENTS = new Set(["policy.decision", "config.changed"]);
var RUN_SCOPED_PREFIXES = ["run.", "dispatch.", "agent."];
var RUN_CREATED_EVENT = "run.created";
var STATE_TRANSITION_EVENTS = new Set([
  RUN_CREATED_EVENT,
  "run.migrated",
  "dispatch.claimed",
  "dispatch.reserved",
  "dispatch.result",
  "dispatch.abandoned",
  "dispatch.lease-expired",
  "dispatch.unconfirmed",
  "dispatch.retry",
  "dispatch.resolved",
  "run.blocked",
  "run.dead_lettered"
]);
function isRunScoped(entry) {
  if (entry.entity.kind === "run") {
    return true;
  }
  return RUN_SCOPED_PREFIXES.some((prefix) => entry.eventType.startsWith(prefix));
}
function isDecisionEvent(entry) {
  return DECISION_EVENTS.has(entry.eventType);
}
function isStateTransition(entry) {
  return STATE_TRANSITION_EVENTS.has(entry.eventType);
}
function openersOf(entries) {
  const openers = new Map;
  for (const entry of entries) {
    const seen = openers.get(entry.correlationId);
    if (seen === undefined || entry.seq < seen.seq) {
      openers.set(entry.correlationId, entry);
    }
  }
  return openers;
}
function latestOf(entries, isAccepted) {
  const latest = new Map;
  for (const entry of entries) {
    if (!isAccepted(entry)) {
      continue;
    }
    const seen = latest.get(entry.correlationId);
    if (seen === undefined || entry.seq > seen.seq) {
      latest.set(entry.correlationId, entry);
    }
  }
  return latest;
}
function chainSeqs(entries, openers) {
  const outcomes = latestOf(entries, isRunScoped);
  const hops = latestOf(entries, isStateTransition);
  const protectedSeqs = [];
  for (const [correlationId, outcome] of outcomes) {
    const opener = openers.get(correlationId);
    if (opener !== undefined) {
      protectedSeqs.push(opener.seq);
    }
    protectedSeqs.push(outcome.seq);
    const hop = hops.get(correlationId);
    if (hop !== undefined) {
      protectedSeqs.push(hop.seq);
    }
  }
  return protectedSeqs;
}
function creationSeqs(entries, openers) {
  const protectedSeqs = [];
  for (const entry of entries) {
    if (entry.eventType !== RUN_CREATED_EVENT) {
      continue;
    }
    const opener = openers.get(entry.correlationId);
    if (opener !== undefined && opener.seq !== entry.seq) {
      protectedSeqs.push(entry.seq);
    }
  }
  return protectedSeqs;
}
function chainAndDecisionSeqs(entries) {
  const openers = openersOf(entries);
  const protectedSeqs = [];
  for (const entry of entries) {
    if (isDecisionEvent(entry)) {
      protectedSeqs.push(entry.seq);
    }
  }
  protectedSeqs.push(...chainSeqs(entries, openers), ...creationSeqs(entries, openers));
  return protectedSeqs;
}

// service/audit-trim.ts
var DAY_MS = 86400000;
var TRIM_EVENT = "audit.trimmed";
function bindingIdsOf(probe) {
  if (probe.status === "absent") {
    return new Set;
  }
  if (probe.status === "quarantined" || !Array.isArray(probe.value)) {
    return null;
  }
  const ids = new Set;
  for (const entry of probe.value) {
    if (isRecord(entry) && typeof entry.bindingId === "string") {
      ids.add(entry.bindingId);
    }
  }
  return ids;
}
async function existingAccountIds(input) {
  try {
    const accounts = await listAccountsUnobserved(input.store, input.log);
    return new Set(accounts.map((account) => account.numericUserId));
  } catch (cause) {
    input.log.warn("audit trim could not list accounts", {
      errorKind: cause instanceof Error ? cause.name : typeof cause
    });
    return null;
  }
}
async function existingBindingIds(input) {
  let probe;
  try {
    probe = await input.store.readJson(BINDINGS_FILE, (raw) => raw);
  } catch (cause) {
    input.log.warn("audit trim could not read the bindings document", {
      errorKind: cause instanceof Error ? cause.name : typeof cause
    });
    return null;
  }
  return bindingIdsOf(probe);
}
async function subjectSeqs(input) {
  const accounts = await existingAccountIds(input);
  const bindings = await existingBindingIds(input);
  const protectedSeqs = [];
  for (const entry of input.entries) {
    const { kind, id } = entry.entity;
    if (kind === "account" && (accounts === null || accounts.has(id))) {
      protectedSeqs.push(entry.seq);
    }
    if (kind === "binding" && (bindings === null || bindings.has(id))) {
      protectedSeqs.push(entry.seq);
    }
  }
  return protectedSeqs;
}
async function protectedSeqsOf(input) {
  const protectedSeqs = new Set(chainAndDecisionSeqs(input.entries));
  const subjects = await subjectSeqs(input);
  for (const seq of subjects) {
    protectedSeqs.add(seq);
  }
  return protectedSeqs;
}
function planRemoval(input) {
  const { ordered, protectedSeqs, cutoff, maxEntries } = input;
  const isOverCap = ordered.length > maxEntries;
  const neededForCap = isOverCap ? ordered.length + 1 - maxEntries : 0;
  const survivors = [];
  const removed = [];
  let limitReached = null;
  for (const entry of ordered) {
    if (protectedSeqs.has(entry.seq)) {
      survivors.push(entry);
      continue;
    }
    const stamped = Date.parse(entry.timestamp);
    const isTooOld = Number.isFinite(stamped) && stamped < cutoff;
    const isForCap = removed.length < neededForCap && entry.eventType !== TRIM_EVENT;
    if (!isTooOld && !isForCap) {
      survivors.push(entry);
      continue;
    }
    limitReached ??= isTooOld ? "day-window" : "entry-cap";
    removed.push(entry);
  }
  return { survivors, removed, limitReached };
}
async function composeTrimRow(input) {
  const { plan, limitReached, minimalReferencesPreserved, malformedLinesDropped, store } = input;
  const oldestSeq = Math.min(...plan.removed.map((entry) => entry.seq));
  const newestSeq = Math.max(...plan.removed.map((entry) => entry.seq));
  return await composeAudit(store, {
    eventType: TRIM_EVENT,
    actorSource: "service",
    entity: { kind: "service", id: CONFIGURATION_ENTITY_ID },
    decision: "trimmed",
    reason: `audit trail trimmed; limit reached: ${limitReached}`,
    details: {
      entriesRemoved: plan.removed.length,
      oldestSeq,
      newestSeq,
      limitReached,
      minimalReferencesPreserved,
      malformedLinesDropped
    }
  });
}
async function readOrderedTrail(store) {
  const trail = await readAuditTrail(store);
  return { entries: [...trail.entries].toSorted((left, right) => left.seq - right.seq), malformed: trail.malformed };
}
async function readForPass(input) {
  const trail = await readOrderedTrail(input.store);
  if (trail.malformed > 0) {
    input.log.warn("audit trail holds unreadable lines; a rewrite this pass makes erases them", {
      malformedLinesDropped: trail.malformed
    });
  }
  return trail;
}
async function trimAudit(input) {
  const now = input.now ?? Date.now();
  const cutoff = now - input.config.auditRetentionDays * DAY_MS;
  return await serializeAudit(input.store, async () => {
    const trail = await readForPass(input);
    const ordered = trail.entries;
    const protectedSeqs = await protectedSeqsOf({
      store: input.store,
      log: input.log,
      entries: ordered
    });
    const plan = planRemoval({
      ordered,
      protectedSeqs,
      cutoff,
      maxEntries: input.config.auditMaxEntries
    });
    const minimalReferencesPreserved = protectedSeqs.size;
    const outcome = {
      removed: plan.removed.length,
      limitReached: plan.limitReached,
      minimalReferencesPreserved
    };
    if (plan.removed.length === 0 || plan.limitReached === null) {
      return outcome;
    }
    const trimRow = await composeTrimRow({
      plan,
      limitReached: plan.limitReached,
      minimalReferencesPreserved,
      malformedLinesDropped: trail.malformed,
      store: input.store
    });
    await input.store.writeLines(AUDIT_FILE, [...plan.survivors, trimRow]);
    input.log.info("audit trail trimmed", {
      entriesRemoved: plan.removed.length,
      limitReached: plan.limitReached,
      minimalReferencesPreserved,
      entriesAfter: plan.survivors.length + 1
    });
    return outcome;
  });
}

// service/poll/events.ts
import { basename, join as join2 } from "node:path";

// service/poll/attribution.ts
var AUTHOR_LOGIN_MAX_CHARS = 60;
function isBotAuthor(authorLogin, authorType) {
  return authorLogin.toLowerCase().endsWith("[bot]") || authorType.toLowerCase() === "bot";
}
function isAttributableAuthor(authorLogin, authorType) {
  return authorLogin !== "" && !isBotAuthor(authorLogin, authorType);
}
function actorLoginOf(authorLogin) {
  return authorLogin.slice(0, AUTHOR_LOGIN_MAX_CHARS);
}
var ACTOR_ATTRIBUTIONS = new Set(["direct", "subject-author"]);
function readActorLoginField(record) {
  const value = record.actorLogin;
  if (value === undefined) {
    return;
  }
  return typeof value === "string" && value !== "" ? value : null;
}
function readActorAttributionField(record) {
  const value = record.actorAttribution;
  if (value === undefined) {
    return;
  }
  return typeof value === "string" && ACTOR_ATTRIBUTIONS.has(value) ? value : null;
}
function actorFieldsOf(record) {
  const actorLogin = readActorLoginField(record);
  const actorAttribution = readActorAttributionField(record);
  return {
    ...!(actorLogin === undefined || actorLogin === null) && { actorLogin },
    ...!(actorAttribution === undefined || actorAttribution === null) && { actorAttribution }
  };
}

// service/poll/events-parse.ts
var EVENTS_FILE = "events.json";
var REQUIRED_FIELDS = [
  "id",
  "bindingId",
  "kind",
  "repository",
  "accountNumericUserId",
  "accountLogin",
  "projectId",
  "worktreeOption",
  "issueTitle",
  "issueUrl",
  "triggerNote",
  "detectedAt"
];
var ABSENTABLE_FIELDS = ["headSha", "baseRef", "claimedAt", "dispatchedAt", "dispatchResult"];
var KNOWN_STATES = new Set(["pending", "in-flight", "dispatched"]);
var KNOWN_KINDS = new Set(["assignment", "mention", "review"]);
var SUBJECT_TYPES = new Set(["issue", "pull_request"]);
var RUN_CORRELATION_ID = /^mt-run-[0-9a-f]{24}$/;
function isUsableTextFieldSet(record, fields) {
  return fields.every((field) => {
    const value = record[field];
    return typeof value === "string" && value !== "";
  });
}
function isAbsentableTextFieldSet(record, fields) {
  return fields.every((field) => {
    const value = record[field];
    return value === undefined || value === null || typeof value === "string";
  });
}
function positiveIntOf(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}
function knownStateOf(value) {
  if (typeof value !== "string" || !KNOWN_STATES.has(value)) {
    return null;
  }
  return value;
}
function readStateField(record) {
  if (record.state === undefined) {
    return;
  }
  return knownStateOf(record.state);
}
function readSubjectTypeField(record) {
  const value = record.subjectType;
  if (value === undefined) {
    return;
  }
  return typeof value === "string" && SUBJECT_TYPES.has(value) ? value : null;
}
function readRunLinkField(record) {
  const value = record.runCorrelationId;
  if (value === undefined) {
    return;
  }
  return typeof value === "string" && RUN_CORRELATION_ID.test(value) ? value : null;
}
function readTrimMarkerField(record) {
  const value = record.excerptTrimmedAt;
  if (value === undefined || value === null) {
    return;
  }
  if (typeof value !== "string") {
    return null;
  }
  return Number.isNaN(Date.parse(value)) ? null : value;
}
function fieldsHold(record) {
  return isUsableTextFieldSet(record, REQUIRED_FIELDS) && isAbsentableTextFieldSet(record, ABSENTABLE_FIELDS) && typeof record.kind === "string" && KNOWN_KINDS.has(record.kind) && readStateField(record) !== null && readSubjectTypeField(record) !== null && readRunLinkField(record) !== null && readTrimMarkerField(record) !== null && readActorAttributionField(record) !== null && readActorLoginField(record) !== null;
}
function lifecycleOf(record, state) {
  const fields = {};
  if (state !== undefined) {
    fields.state = state;
  }
  if (record.claimedAt !== undefined) {
    fields.claimedAt = record.claimedAt;
  }
  if (record.dispatchedAt !== undefined) {
    fields.dispatchedAt = record.dispatchedAt;
  }
  if (record.dispatchResult !== undefined) {
    fields.dispatchResult = record.dispatchResult;
  }
  return fields;
}
function runLinkOf(record, subjectType) {
  const runCorrelationId = readRunLinkField(record);
  return {
    ...!(runCorrelationId === undefined || runCorrelationId === null) && { runCorrelationId },
    ...subjectType !== undefined && { subjectType }
  };
}
function trimMarkerOf(record) {
  const marker = readTrimMarkerField(record);
  return marker === undefined || marker === null ? {} : { excerptTrimmedAt: marker };
}
function coordinatesOf(record) {
  return {
    headSha: typeof record.headSha === "string" ? record.headSha : null,
    baseRef: typeof record.baseRef === "string" ? record.baseRef : null
  };
}
function parseStoredEvent(raw) {
  const record = isRecord(raw) ? raw : null;
  if (record === null || !fieldsHold(record)) {
    return null;
  }
  const state = readStateField(record);
  const subjectType = readSubjectTypeField(record);
  const issueNumber = positiveIntOf(record.issueNumber);
  if (state === null || subjectType === null || issueNumber === null || typeof record.issueBodyExcerpt !== "string") {
    return null;
  }
  const detectedAt = record.detectedAt;
  if (Number.isNaN(Date.parse(detectedAt))) {
    return null;
  }
  return {
    id: record.id,
    bindingId: record.bindingId,
    kind: record.kind,
    repository: record.repository,
    accountNumericUserId: record.accountNumericUserId,
    accountLogin: record.accountLogin,
    projectId: record.projectId,
    worktreeOption: record.worktreeOption,
    issueNumber,
    issueTitle: record.issueTitle,
    issueUrl: record.issueUrl,
    issueBodyExcerpt: record.issueBodyExcerpt,
    ...coordinatesOf(record),
    triggerNote: record.triggerNote,
    detectedAt,
    ...lifecycleOf(record, state),
    ...runLinkOf(record, subjectType),
    ...trimMarkerOf(record),
    ...actorFieldsOf(record)
  };
}
function subjectTypeOf(delivery) {
  return delivery.subjectType ?? (delivery.kind === "review" ? "pull_request" : "issue");
}
function parseStoredEvents(raw) {
  if (!Array.isArray(raw)) {
    return null;
  }
  const events = [];
  for (const entry of raw) {
    const event = parseStoredEvent(entry);
    if (event === null) {
      return null;
    }
    events.push(event);
  }
  return events;
}

// service/poll/events-enqueue-audit.ts
async function appendEnqueueAudit(input, row) {
  try {
    await appendAudit(input.store, row);
  } catch (cause) {
    input.log.warn("enqueue audit row could not be appended", {
      eventType: row.eventType,
      errorKind: cause instanceof Error ? cause.name : typeof cause
    });
  }
}
async function recordJoinedDeliveries(input) {
  for (const joined of input.outcome.joins) {
    await appendEnqueueAudit(input, {
      eventType: "run.coalesced",
      actorSource: "service",
      entity: { kind: "run", id: joined.run.correlationId },
      correlationId: joined.run.correlationId,
      decision: "coalesced",
      reason: joined.retained ? "delivery joined an open run" : "delivery joined an open run whose reference list was full; counted, not retained",
      details: {
        deliveryId: joined.reference.deliveryId,
        kind: joined.reference.kind,
        origin: joined.reference.origin,
        presentAtAuthorization: joined.reference.presentAtAuthorization,
        retained: joined.retained,
        referencesNotRetained: joined.run.referencesNotRetained
      }
    });
  }
}
async function recordDetectedDeliveries(input) {
  for (const event of input.appended) {
    await appendEnqueueAudit(input, {
      eventType: "delivery.detected",
      actorSource: "service",
      entity: { kind: "delivery", id: event.id },
      ...event.runCorrelationId !== undefined && { correlationId: event.runCorrelationId },
      reason: `${event.kind} trigger matched a binding`,
      details: {
        bindingId: event.bindingId,
        repository: event.repository,
        kind: event.kind,
        ...event.runCorrelationId !== undefined && { runCorrelationId: event.runCorrelationId }
      }
    });
  }
}
async function recordEnqueueAudits(input) {
  await recordJoinedDeliveries(input);
  await recordDetectedDeliveries(input);
}

// service/store/errors.ts
var STORAGE_UNAVAILABLE_CODE = "storage-unavailable";

class StorageUnavailableError extends Error {
  name = "StorageUnavailableError";
  code = STORAGE_UNAVAILABLE_CODE;
  constructor(message, cause) {
    super(message, cause === undefined ? undefined : { cause });
  }
}

// service/poll/run-key.ts
import { createHash as createHash2 } from "node:crypto";
var RUN_PROVIDER = "github";
var ATTACHMENT_ID_MAX = 128;
var CORRELATION_HEX_CHARS = 24;
var TOKEN_HEX_CHARS = 32;
var FINGERPRINT_HEX_CHARS2 = 16;
var FINGERPRINT_PREFIX = "tokfp-";
var KEY_SEPARATOR = "|";
function keySegments(input) {
  if (!Number.isSafeInteger(input.subjectNumber) || input.subjectNumber < 1) {
    throw new Error("refusing to derive a run key without a positive subject number");
  }
  if (!Number.isSafeInteger(input.ordinal) || input.ordinal < 0) {
    throw new Error("refusing to derive a run key without a non-negative ordinal");
  }
  const segments = [
    RUN_PROVIDER,
    input.accountNumericUserId,
    input.repository,
    input.subjectType,
    String(input.subjectNumber),
    String(input.ordinal)
  ];
  if (segments.some((segment) => segment === "" || segment.includes(KEY_SEPARATOR))) {
    throw new Error("refusing to derive a run key from a segment that carries the key separator");
  }
  return segments;
}
function buildRunKey(input) {
  return keySegments(input).join(KEY_SEPARATOR);
}
function buildSubjectKey(input) {
  return keySegments(input).slice(0, -1).join(KEY_SEPARATOR);
}
function digestHex(text, hexChars) {
  return createHash2("sha256").update(text, "utf8").digest("hex").slice(0, hexChars);
}
function buildCorrelationId(runKey) {
  return `mt-run-${digestHex(runKey, CORRELATION_HEX_CHARS)}`;
}
function buildAttachmentId(correlationId) {
  if (correlationId.length > ATTACHMENT_ID_MAX || !/^[A-Za-z0-9._~-]+$/.test(correlationId)) {
    throw new Error("refusing an attachment id that is not one path-safe segment within the host bound");
  }
  return correlationId;
}
function buildDispatchToken(runKey, attempt) {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new Error("refusing to mint a dispatch token for an attempt that is not a positive integer");
  }
  return `dtk-${digestHex(`${runKey}${KEY_SEPARATOR}${attempt}`, TOKEN_HEX_CHARS)}`;
}
function buildDispatchTokenFingerprint(dispatchToken) {
  return `${FINGERPRINT_PREFIX}${digestHex(dispatchToken, FINGERPRINT_HEX_CHARS2)}`;
}

// service/poll/runs-audit-parse.ts
var SWEEP_DECISIONS = new Map([
  ["dispatch.lease-expired", "requeued"],
  ["run.dead_lettered", "dead-lettered"],
  ["dispatch.unconfirmed", "unconfirmed"]
]);
function isSweepEventType(value) {
  return SWEEP_DECISIONS.has(value);
}
var STATES = new Set([
  "pending",
  "claimed",
  "starting",
  "dispatched",
  "failed",
  "unconfirmed",
  "dead-lettered"
]);
function parseTextList(raw) {
  if (!Array.isArray(raw)) {
    return null;
  }
  const values = [];
  for (const value of raw) {
    const text = readText(value);
    if (text === null) {
      return null;
    }
    values.push(text);
  }
  return values;
}
function isRunState(value) {
  if (typeof value !== "string") {
    return false;
  }
  if (STATES.has(value)) {
    return true;
  }
  const blockedReason = value.startsWith("blocked:") ? value.slice("blocked:".length) : "";
  return blockedReason !== "" && blockedReason.split("-").every((part) => /^[a-z0-9]+$/.test(part));
}
function parseIntentBase(value) {
  const correlationId = readText(value.correlationId);
  const deliveryIds = parseTextList(value.deliveryIds);
  if (correlationId === null || deliveryIds === null || deliveryIds.length === 0 || !/^mt-run-[0-9a-f]{24}$/.test(correlationId)) {
    return null;
  }
  return { correlationId, deliveryIds };
}
function parseMigrationDetails(value) {
  const stateBranches = parseTextList(value.stateBranches);
  if (stateBranches === null || stateBranches.length === 0 || !isRunState(value.state)) {
    return null;
  }
  return { stateBranches, state: value.state };
}
function parseIntent(value) {
  if (!isRecord(value)) {
    return null;
  }
  const base = parseIntentBase(value);
  if (base === null) {
    return null;
  }
  if (value.eventType === "run.created") {
    return { eventType: "run.created", ...base };
  }
  if (value.eventType !== "run.migrated") {
    return null;
  }
  const migration = parseMigrationDetails(value);
  if (migration === null) {
    return null;
  }
  return { eventType: "run.migrated", ...base, ...migration };
}
function parseSweepDetails(raw) {
  if (!isRecord(raw)) {
    return null;
  }
  const details = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") {
      if (value.includes("dtk-")) {
        return null;
      }
      details[key] = value;
    } else if (typeof value === "boolean" || value === null || typeof value === "number" && Number.isFinite(value)) {
      details[key] = value;
    } else {
      return null;
    }
  }
  return details;
}
function parseSweepIntent(value) {
  const { eventType: rawEventType } = value;
  if (typeof rawEventType !== "string" || !isSweepEventType(rawEventType)) {
    return null;
  }
  const eventType = rawEventType;
  const { correlationId: rawId, reason: rawReason, sequence: rawSequence, decision: rawDecision } = value;
  const correlationId = readText(rawId);
  const reason = readText(rawReason);
  const sequence = readText(rawSequence);
  const details = parseSweepDetails(value.details);
  const decision = readText(rawDecision);
  if (correlationId === null || reason === null || sequence === null || details === null || decision !== SWEEP_DECISIONS.get(eventType) || !/^mt-run-[0-9a-f]{24}$/.test(correlationId)) {
    return null;
  }
  return { eventType, correlationId, decision, reason, details, sequence };
}
function parseEntry(value) {
  const creation = parseIntent(value);
  return creation ?? (isRecord(value) ? parseSweepIntent(value) : null);
}
function parseRunAuditIntents(raw) {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    return null;
  }
  const intents = [];
  for (const value of raw) {
    const intent = parseEntry(value);
    if (intent === null) {
      return null;
    }
    intents.push(intent);
  }
  return intents;
}

// service/poll/runs-parts-parse.ts
var EVENT_KINDS = new Set(["assignment", "mention", "review"]);
var ATTEMPT_OUTCOMES = new Set([
  "dispatched",
  "failed",
  "abandoned",
  "expired",
  "blocked",
  "unconfirmed"
]);
function isEventKind(value) {
  return typeof value === "string" && EVENT_KINDS.has(value);
}
function isValidOrigin(origin) {
  return origin === "assignment" || origin === "body" || origin === "review" || /^comment:[1-9][0-9]*$/.test(origin);
}
function isOutcome(value) {
  return value === null || typeof value === "string" && ATTEMPT_OUTCOMES.has(value);
}
function parseReference(raw) {
  if (!isRecord(raw)) {
    return null;
  }
  const deliveryId = readText(raw.deliveryId);
  const sourceUrl = readText(raw.sourceUrl);
  const detectedAt = readStamp(raw.detectedAt);
  const { kind, origin } = raw;
  const present = readFlag(raw.presentAtAuthorization);
  const isUnusable = [
    deliveryId,
    sourceUrl,
    detectedAt,
    present,
    readActorLoginField(raw),
    readActorAttributionField(raw)
  ].includes(null) || !isEventKind(kind) || typeof origin !== "string" || !isValidOrigin(origin);
  if (isUnusable || deliveryId === null || sourceUrl === null || detectedAt === null || present === null) {
    return null;
  }
  return {
    deliveryId,
    kind,
    origin,
    sourceUrl,
    detectedAt,
    presentAtAuthorization: present,
    ...actorFieldsOf(raw)
  };
}
function parseAttempt(raw) {
  if (!isRecord(raw)) {
    return null;
  }
  const attempt = readPositiveInt(raw.attempt);
  const { outcome, reservedAt, sessionId, reason } = raw;
  const token = raw.dispatchToken;
  const reportedAt = raw.resultReportedAt;
  const nullable = [token, reservedAt, sessionId, reason, reportedAt];
  if (attempt === null || nullable.some((value) => value !== null && typeof value !== "string") || !isOutcome(outcome)) {
    return null;
  }
  return {
    attempt,
    dispatchToken: token,
    reservedAt,
    outcome,
    sessionId,
    reason,
    resultReportedAt: reportedAt
  };
}
function readLeaseId(leaseId) {
  const value = readText(leaseId);
  if (value === null) {
    return null;
  }
  return /^lse-[0-9a-f]{24}$/.test(value) || /^migration-mt-run-[0-9a-f]{24}$/.test(value) ? value : null;
}
function parseLease(raw) {
  if (!isRecord(raw)) {
    return null;
  }
  const { leaseId, holder, attempt, issuedAt, expiresAt, provenance } = raw;
  const values = [
    readLeaseId(leaseId),
    readText(holder),
    readPositiveInt(attempt),
    readStamp(issuedAt),
    readStamp(expiresAt)
  ];
  const source = provenance === "panel" || provenance === "migration" ? provenance : null;
  if (source === null || values.includes(null)) {
    return null;
  }
  return {
    leaseId: values[0],
    holder,
    attempt,
    issuedAt,
    expiresAt,
    provenance: source
  };
}
function parseReservation(raw) {
  if (!isRecord(raw)) {
    return null;
  }
  const { dispatchToken, attempt, reservedAt, consumed } = raw;
  const deadline = raw.resultDeadlineAt;
  const values = [readText(dispatchToken), readPositiveInt(attempt), readStamp(reservedAt), readStamp(deadline)];
  const flag = readFlag(consumed);
  if (flag === null || values.includes(null)) {
    return null;
  }
  return {
    dispatchToken,
    attempt,
    reservedAt,
    resultDeadlineAt: deadline,
    consumed: flag
  };
}
function parseWorktree(raw) {
  if (!isRecord(raw)) {
    return null;
  }
  const directory = readText(raw.directory);
  const branch = readText(raw.branch);
  return directory === null || branch === null ? null : { directory, branch };
}
function parseSession(raw) {
  if (!isRecord(raw)) {
    return null;
  }
  const { sessionId, attachmentId, dispatchedAt, title, sourceUrl } = raw;
  const id = readText(sessionId);
  const attachment = readText(attachmentId);
  const stamped = readStamp(dispatchedAt);
  const heading = readString(title);
  const link = readString(sourceUrl);
  if (id === null || attachment === null || stamped === null || heading === null || link === null) {
    return null;
  }
  if (raw.worktree === null) {
    return {
      sessionId: id,
      attachmentId: attachment,
      dispatchedAt: stamped,
      title: heading,
      sourceUrl: link,
      worktree: null
    };
  }
  const worktree = parseWorktree(raw.worktree);
  return worktree === null ? null : { sessionId: id, attachmentId: attachment, dispatchedAt: stamped, title: heading, sourceUrl: link, worktree };
}
function parseVerification(raw) {
  if (!isRecord(raw)) {
    return null;
  }
  const { expectedAgent, ok, at, observedAgent, note } = raw;
  const agent = readString(expectedAgent);
  const matched = readFlag(ok);
  const stamped = readStamp(at);
  if (agent === null || matched === null || stamped === null || observedAgent !== null && typeof observedAgent !== "string" || note !== null && typeof note !== "string") {
    return null;
  }
  return { observedAgent, expectedAgent: agent, ok: matched, note, at: stamped };
}

// service/poll/runs-scalars-parse.ts
var SIMPLE_STATES = new Set([
  "pending",
  "claimed",
  "starting",
  "dispatched",
  "failed",
  "unconfirmed",
  "dead-lettered"
]);
var RUN_TEXT_FIELDS = [
  "runKey",
  "correlationId",
  "attachmentId",
  "repository",
  "accountNumericUserId",
  "bindingId",
  "projectId",
  "worktreeOption"
];
function isBlockedReason(reason) {
  if (reason === "") {
    return false;
  }
  return reason.split("-").every((part) => part !== "" && /^[a-z0-9]+$/.test(part));
}
function runStateOf(value) {
  if (typeof value !== "string") {
    return null;
  }
  if (SIMPLE_STATES.has(value)) {
    return value;
  }
  const prefix = "blocked:";
  if (!value.startsWith(prefix) || !isBlockedReason(value.slice(prefix.length))) {
    return null;
  }
  return value;
}
function readStateLine(raw) {
  const state = runStateOf(raw.state);
  const { stateReason } = raw;
  if (state === null || stateReason !== null && typeof stateReason !== "string") {
    return null;
  }
  if (state !== "pending" && (stateReason === null || stateReason === "")) {
    return null;
  }
  return { state, reason: stateReason };
}
function readActorPolicy(raw) {
  const value = raw.actorPolicy;
  if (value === undefined || value === null) {
    return null;
  }
  return value === "open" || value === "restricted" ? value : undefined;
}
function parseRunScalars(raw) {
  const line = readStateLine(raw);
  const actorPolicy = readActorPolicy(raw);
  const { subjectType } = raw;
  if (line === null || actorPolicy === undefined || subjectType !== "issue" && subjectType !== "pull_request") {
    return null;
  }
  const ordinal = readCount(raw.ordinal);
  const subjectNumber = readPositiveInt(raw.subjectNumber);
  const attempt = readPositiveInt(raw.attempt);
  const requeuesUsed = readCount(raw.requeuesUsed);
  const referenceCount = readCount(raw.referenceCount);
  const notRetained = readCount(raw.referencesNotRetained);
  const truncated = readFlag(raw.referencesTruncated);
  const createdAt = readStamp(raw.createdAt);
  const updatedAt = readStamp(raw.updatedAt);
  const values = [ordinal, subjectNumber, attempt, requeuesUsed, referenceCount, notRetained, createdAt, updatedAt];
  if (truncated === null || values.includes(null)) {
    return null;
  }
  return {
    state: line.state,
    stateReason: line.reason,
    subjectType,
    ordinal,
    subjectNumber,
    attempt,
    requeuesUsed,
    referenceCount,
    referencesNotRetained: notRetained,
    referencesTruncated: truncated,
    actorPolicy,
    createdAt,
    updatedAt
  };
}
function runTextFieldsHold(raw) {
  return RUN_TEXT_FIELDS.every((field) => readText(raw[field]) !== null);
}

// service/poll/runs-parse.ts
var RUNS_SCHEMA_VERSION = 1;
var MAX_SOURCE_REFERENCES = 200;
var MAX_ATTEMPT_RECORDS = 50;
function runIdentityMatches(raw, scalars) {
  try {
    const runKey = buildRunKey({
      accountNumericUserId: raw.accountNumericUserId,
      repository: raw.repository,
      subjectType: scalars.subjectType,
      subjectNumber: scalars.subjectNumber,
      ordinal: scalars.ordinal
    });
    const correlationId = buildCorrelationId(runKey);
    return raw.runKey === runKey && raw.correlationId === correlationId && raw.attachmentId === correlationId;
  } catch {
    return false;
  }
}
function parsePart(stored, parse) {
  if (stored === undefined || stored === null) {
    return { malformed: false, value: null };
  }
  const value = parse(stored);
  return value === null ? { malformed: true, value: null } : { malformed: false, value };
}
function parseRunObjects(raw) {
  const lease = parsePart(raw.lease, parseLease);
  const reservation = parsePart(raw.reservation, parseReservation);
  const session = parsePart(raw.session, parseSession);
  const verification = parsePart(raw.verification, parseVerification);
  const parts = [lease, reservation, session, verification];
  if (parts.some((part) => part.malformed)) {
    return null;
  }
  return {
    lease: lease.value,
    reservation: reservation.value,
    session: session.value,
    verification: verification.value
  };
}
function parseList(raw, shape) {
  if (!Array.isArray(raw) || raw.length > shape.cap) {
    return null;
  }
  const rows = [];
  for (const candidate of raw) {
    const row = shape.parse(candidate);
    if (row === null) {
      return null;
    }
    rows.push(row);
  }
  return rows;
}
function sessionHistoryHolds(input) {
  const { state, session, attempts } = input;
  const sessionAttempts = attempts.filter((attempt) => attempt.outcome === "dispatched" || attempt.sessionId !== null);
  const knownSessionIds = new Set(sessionAttempts.flatMap((attempt) => attempt.sessionId === null ? [] : [attempt.sessionId]));
  const isInvalidAttemptSession = attempts.some((attempt) => attempt.sessionId !== null && attempt.outcome !== "dispatched");
  const isContradictorySessionHistory = sessionAttempts.length > 0 && state !== "dispatched";
  const isMismatchedSession = session !== null && (state !== "dispatched" || !knownSessionIds.has(session.sessionId));
  return !isInvalidAttemptSession && !isContradictorySessionHistory && !isMismatchedSession && knownSessionIds.size <= 1;
}
function runRelationsHold(input) {
  const { scalars, objects, references, attempts, attachmentId } = input;
  const referenceIds = new Set(references.map((reference) => reference.deliveryId));
  const isReferencesAccounted = scalars.referenceCount === references.length + scalars.referencesNotRetained && scalars.referencesTruncated === scalars.referencesNotRetained > 0;
  const isBasicRelationsHold = isReferencesAccounted && (objects.session === null || objects.session.attachmentId === attachmentId) && (objects.lease === null || objects.lease.attempt === scalars.attempt) && (objects.reservation === null || objects.reservation.attempt === scalars.attempt) && referenceIds.size === references.length;
  return isBasicRelationsHold && sessionHistoryHolds({
    state: scalars.state,
    session: objects.session,
    attempts
  });
}
function parseRunParts(raw) {
  const scalars = parseRunScalars(raw);
  const objects = parseRunObjects(raw);
  const references = parseList(raw.sourceReferences, { parse: parseReference, cap: MAX_SOURCE_REFERENCES });
  const attempts = parseList(raw.attempts, { parse: parseAttempt, cap: MAX_ATTEMPT_RECORDS });
  const prompt = parseStoredPromptSnapshot(raw.prompt);
  if (scalars === null || objects === null || references === null || attempts === null || prompt === null || !runIdentityMatches(raw, scalars) || !runRelationsHold({ scalars, objects, references, attempts, attachmentId: raw.attachmentId })) {
    return null;
  }
  return {
    scalars,
    objects,
    references,
    attempts,
    prompt: prompt.status === "set" ? prompt.snapshot : null
  };
}
function runFromParts(raw, parts) {
  const { scalars, objects, references, attempts, prompt } = parts;
  return {
    runKey: raw.runKey,
    correlationId: raw.correlationId,
    attachmentId: raw.attachmentId,
    ordinal: scalars.ordinal,
    subjectType: scalars.subjectType,
    subjectNumber: scalars.subjectNumber,
    repository: raw.repository,
    accountNumericUserId: raw.accountNumericUserId,
    bindingId: raw.bindingId,
    projectId: raw.projectId,
    worktreeOption: raw.worktreeOption,
    prompt,
    actorPolicy: scalars.actorPolicy,
    state: scalars.state,
    stateReason: scalars.stateReason,
    attempt: scalars.attempt,
    requeuesUsed: scalars.requeuesUsed,
    sourceReferences: references,
    referenceCount: scalars.referenceCount,
    referencesNotRetained: scalars.referencesNotRetained,
    referencesTruncated: scalars.referencesTruncated,
    lease: objects.lease,
    reservation: objects.reservation,
    attempts,
    session: objects.session,
    verification: objects.verification,
    createdAt: scalars.createdAt,
    updatedAt: scalars.updatedAt
  };
}
function parseRun(raw) {
  if (!isRecord(raw) || !runTextFieldsHold(raw)) {
    return null;
  }
  const parts = parseRunParts(raw);
  return parts === null ? null : runFromParts(raw, parts);
}
function parseSubjects(raw) {
  if (!isRecord(raw)) {
    return null;
  }
  const entries = [];
  for (const [key, value] of Object.entries(raw)) {
    const next = readCount(value);
    if (key === "" || next === null) {
      return null;
    }
    entries.push([key, next]);
  }
  return Object.fromEntries(entries);
}
function parseRunRows(raw) {
  const runs = [];
  const seen = new Set;
  const openSubjects = new Set;
  for (const candidate of raw) {
    const run = parseRun(candidate);
    if (run === null || seen.has(run.correlationId)) {
      return null;
    }
    seen.add(run.correlationId);
    if (run.state !== "dispatched" && run.state !== "dead-lettered") {
      const subjectKey = buildSubjectKey({
        accountNumericUserId: run.accountNumericUserId,
        repository: run.repository,
        subjectType: run.subjectType,
        subjectNumber: run.subjectNumber,
        ordinal: run.ordinal
      });
      if (openSubjects.has(subjectKey)) {
        return null;
      }
      openSubjects.add(subjectKey);
    }
    runs.push(run);
  }
  return runs;
}
function parseRunsDocument(raw) {
  if (!isRecord(raw) || raw.schemaVersion !== RUNS_SCHEMA_VERSION || !Array.isArray(raw.runs)) {
    return null;
  }
  const subjects = parseSubjects(raw.subjects);
  const runs = parseRunRows(raw.runs);
  const auditIntents = parseRunAuditIntents(raw.auditIntents);
  if (subjects === null || runs === null || auditIntents === null) {
    return null;
  }
  return { schemaVersion: RUNS_SCHEMA_VERSION, subjects, runs, auditIntents };
}

// service/poll/runs-audit.ts
var RUN_ENTITY_KIND = "run";
var SERVICE_ACTOR = "service";
var WRONG_VARIANT = "intent variant does not match the row builder";
var RUN_CREATED = "run.created";
var RUN_MIGRATED = "run.migrated";
function createdRow(input) {
  const { intent, run } = input;
  if (intent.eventType !== RUN_CREATED) {
    throw new Error(WRONG_VARIANT);
  }
  return {
    eventType: intent.eventType,
    actorSource: SERVICE_ACTOR,
    entity: { kind: RUN_ENTITY_KIND, id: intent.correlationId },
    correlationId: intent.correlationId,
    reason: "run created from a detected delivery",
    details: {
      subject: {
        provider: "github",
        accountNumericUserId: run.accountNumericUserId,
        repository: run.repository,
        subjectType: run.subjectType,
        subjectNumber: run.subjectNumber
      },
      ordinal: run.ordinal,
      deliveryIds: intent.deliveryIds
    }
  };
}
function migratedRow(input) {
  const { intent } = input;
  if (intent.eventType !== RUN_MIGRATED) {
    throw new Error(WRONG_VARIANT);
  }
  return {
    eventType: intent.eventType,
    actorSource: SERVICE_ACTOR,
    entity: { kind: RUN_ENTITY_KIND, id: intent.correlationId },
    correlationId: intent.correlationId,
    decision: "adopted",
    reason: `legacy deliveries adopted: ${intent.stateBranches.join(", ")}`,
    details: {
      deliveryIds: intent.deliveryIds,
      stateBranches: intent.stateBranches,
      state: intent.state
    }
  };
}
function sweepAuditRow(intent) {
  return {
    eventType: intent.eventType,
    actorSource: SERVICE_ACTOR,
    entity: { kind: RUN_ENTITY_KIND, id: intent.correlationId },
    correlationId: intent.correlationId,
    decision: intent.decision,
    reason: intent.reason,
    details: { ...intent.details, sequence: intent.sequence }
  };
}
function auditRowForIntent(input) {
  const { intent } = input;
  if (intent.eventType === RUN_CREATED) {
    return createdRow(input);
  }
  return intent.eventType === RUN_MIGRATED ? migratedRow(input) : sweepAuditRow(intent);
}
function isSweepIntent(intent) {
  return intent.eventType !== RUN_CREATED && intent.eventType !== RUN_MIGRATED;
}
function intentIsWritten(intent, entries) {
  return entries.some((entry) => {
    if (entry.eventType !== intent.eventType || entry.correlationId !== intent.correlationId || entry.entity.kind !== RUN_ENTITY_KIND || entry.entity.id !== intent.correlationId) {
      return false;
    }
    return !isSweepIntent(intent) || entry.details.sequence === intent.sequence;
  });
}
async function persistIntent(input) {
  const { intent, document, entries, store, log } = input;
  if (intentIsWritten(intent, entries)) {
    return true;
  }
  const run = document.runs.find((candidate) => candidate.correlationId === intent.correlationId);
  if (run === undefined) {
    log.warn("run audit intent has no retained run; keeping intent for recovery", {
      eventType: intent.eventType
    });
    return false;
  }
  try {
    entries.push(await appendAudit(store, auditRowForIntent({ intent, run })));
    return true;
  } catch (cause) {
    log.warn("run lifecycle audit row could not be appended", {
      eventType: intent.eventType,
      errorKind: cause instanceof Error ? cause.name : typeof cause
    });
    return false;
  }
}
async function flushRunAuditIntents(input) {
  const intents = input.document.auditIntents ?? [];
  if (intents.length === 0) {
    return input.document;
  }
  let entries;
  try {
    entries = [...await readAuditEntries(input.store)];
  } catch (cause) {
    input.log.warn("run lifecycle audit trail could not be read for recovery", {
      errorKind: cause instanceof Error ? cause.name : typeof cause
    });
    return input.document;
  }
  const remaining = [];
  for (const intent of intents) {
    const isPersisted = await persistIntent({ ...input, intent, entries });
    if (!isPersisted) {
      remaining.push(intent);
    }
  }
  if (remaining.length === intents.length) {
    return input.document;
  }
  const recovered = { ...input.document, auditIntents: remaining };
  try {
    await input.store.writeJson(input.runsFile, recovered);
    return recovered;
  } catch (cause) {
    input.log.warn("completed run lifecycle audit intents could not be retired", {
      errorKind: cause instanceof Error ? cause.name : typeof cause
    });
    return input.document;
  }
}

// service/poll/runs-adopt.ts
var LEGACY_PROBLEMS = new Set([
  "binding-missing-at-dispatch",
  "no-session",
  "bootstrap-failed",
  "session-create-failed",
  'projects snapshot reported state "error"'
]);
var RESULT_DEADLINE_MS = DEFAULT_CONFIG.resultDeadlineMs;
var MIGRATION_LEASE_PREFIX = "migration-";
var MIGRATION_HOLDER = "migration";
function buildMigrationLeaseId(correlationId) {
  return `${MIGRATION_LEASE_PREFIX}${correlationId}`;
}
function recordOf(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}
function hasReservation(value) {
  const record = recordOf(value);
  return record !== null && "reservation" in record && record.reservation !== null;
}
function isLegacyProblem(value) {
  return LEGACY_PROBLEMS.has(value) || value.startsWith('project "') && value.endsWith('" is not registered in OpenChamber') || value.startsWith("listProjects failed: ");
}
function attemptOf(input) {
  return {
    attempt: 1,
    dispatchToken: input.token ?? null,
    reservedAt: input.reservedAt ?? null,
    outcome: input.outcome,
    sessionId: input.sessionId ?? null,
    reason: input.reason ?? null,
    resultReportedAt: input.resultReportedAt ?? null
  };
}
function classifyDispatched(event, now) {
  const result = event.dispatchResult ?? null;
  if (result !== null && isLegacyProblem(result)) {
    return {
      state: "failed",
      branch: "dispatched-problem",
      stateReason: result,
      lease: null,
      reservation: null,
      attempts: [attemptOf({ outcome: "failed", reason: result, resultReportedAt: event.dispatchedAt ?? now })],
      sessionId: null
    };
  }
  const branch = result === null ? "dispatched-unknown-outcome" : "dispatched-session";
  const reason = result === null ? "legacy dispatch was terminal; outcome identifier unavailable" : `session ${result} created`;
  return {
    state: "dispatched",
    branch,
    stateReason: reason,
    lease: null,
    reservation: null,
    attempts: [attemptOf({
      outcome: "dispatched",
      sessionId: result,
      resultReportedAt: event.dispatchedAt ?? now
    })],
    sessionId: result
  };
}
function classifyReserved(input) {
  const reservedAt = input.now;
  const dispatchToken = buildDispatchToken(input.runKey, 1);
  return {
    state: "starting",
    branch: "in-flight-reserved",
    stateReason: "adopted legacy reservation; awaiting its result",
    lease: null,
    reservation: {
      dispatchToken,
      attempt: 1,
      reservedAt,
      resultDeadlineAt: new Date(Date.parse(reservedAt) + RESULT_DEADLINE_MS).toISOString(),
      consumed: false
    },
    attempts: [attemptOf({ outcome: null, token: dispatchToken, reservedAt })],
    sessionId: null
  };
}
function expiredAtMint(input) {
  const mint = Date.parse(input.now) - 1;
  if (!Number.isFinite(mint)) {
    throw new TypeError("migration lease cannot be minted without a service-clock stamp");
  }
  const issued = Date.parse(input.issuedAt);
  return new Date(Number.isFinite(issued) ? Math.min(issued, mint) : mint).toISOString();
}
function classifyInFlight(input) {
  const { event, correlationId, now } = input;
  const issuedAt = event.claimedAt ?? event.detectedAt;
  return {
    state: "claimed",
    branch: "in-flight-no-reservation",
    stateReason: "adopted legacy in-flight delivery; synthetic lease is expired",
    lease: {
      leaseId: buildMigrationLeaseId(correlationId),
      attempt: 1,
      holder: MIGRATION_HOLDER,
      issuedAt,
      expiresAt: expiredAtMint({ issuedAt, now }),
      provenance: "migration"
    },
    reservation: null,
    attempts: [attemptOf({ outcome: null })],
    sessionId: null
  };
}
function classifyLegacy(input) {
  if (input.event.state === "dispatched") {
    return classifyDispatched(input.event, input.now);
  }
  if (input.reserved) {
    return classifyReserved({ runKey: input.runKey, now: input.now });
  }
  if (input.event.state === "in-flight") {
    return classifyInFlight({ event: input.event, correlationId: input.correlationId, now: input.now });
  }
  return {
    state: "pending",
    branch: "pending",
    stateReason: null,
    lease: null,
    reservation: null,
    attempts: [],
    sessionId: null
  };
}
function sessionReference(input) {
  const { event, correlationId, sessionId } = input;
  if (sessionId === null) {
    return null;
  }
  return {
    sessionId,
    attachmentId: correlationId,
    dispatchedAt: event.dispatchedAt ?? event.detectedAt,
    title: event.issueTitle,
    sourceUrl: event.issueUrl,
    worktree: null
  };
}
function retainedReferences(reference) {
  return {
    sourceReferences: reference === null ? [] : [reference],
    referenceCount: reference === null ? 0 : 1,
    referencesNotRetained: 0,
    referencesTruncated: false
  };
}
function migratedRun(input) {
  const { event, ordinal, now, reserved } = input;
  const subjectType = subjectTypeOf(event);
  const runKey = buildRunKey({
    accountNumericUserId: event.accountNumericUserId,
    repository: event.repository,
    subjectType,
    subjectNumber: event.issueNumber,
    ordinal
  });
  const correlationId = buildCorrelationId(runKey);
  const classification = classifyLegacy({ event, runKey, correlationId, now, reserved });
  const reference = referenceOf(event, true);
  return {
    branch: classification.branch,
    run: {
      runKey,
      correlationId,
      attachmentId: buildAttachmentId(correlationId),
      ordinal,
      subjectType,
      subjectNumber: event.issueNumber,
      repository: event.repository,
      accountNumericUserId: event.accountNumericUserId,
      bindingId: event.bindingId,
      projectId: event.projectId,
      worktreeOption: event.worktreeOption,
      prompt: null,
      actorPolicy: null,
      state: classification.state,
      stateReason: classification.stateReason,
      attempt: 1,
      requeuesUsed: 0,
      ...retainedReferences(reference),
      lease: classification.lease,
      reservation: classification.reservation,
      attempts: classification.attempts,
      session: sessionReference({ event, correlationId, sessionId: classification.sessionId }),
      verification: null,
      createdAt: event.detectedAt,
      updatedAt: now
    }
  };
}
async function readLegacyRows(store) {
  const stored = await store.readJson("events.json", (raw) => {
    if (!Array.isArray(raw) || raw.some((row) => parseStoredEvent(row) === null)) {
      return null;
    }
    return raw;
  });
  if (stored.status !== "ok") {
    return [];
  }
  return stored.value.flatMap((raw) => {
    const event = parseStoredEvent(raw);
    return event === null ? [] : [{ event, reserved: hasReservation(raw) }];
  });
}
function subjectKeyOf(event) {
  return buildSubjectKey({
    accountNumericUserId: event.accountNumericUserId,
    repository: event.repository,
    subjectType: subjectTypeOf(event),
    subjectNumber: event.issueNumber,
    ordinal: 0
  });
}
function subjectKeyOfRun(run) {
  return buildSubjectKey({
    accountNumericUserId: run.accountNumericUserId,
    repository: run.repository,
    subjectType: run.subjectType,
    subjectNumber: run.subjectNumber,
    ordinal: run.ordinal
  });
}
function isTerminalLegacyOutcome(event) {
  return event.state === "dispatched" && event.dispatchResult !== null && event.dispatchResult !== undefined && !isLegacyProblem(event.dispatchResult);
}
function addMigratedRun(input) {
  const ordinal = input.subjects[input.key] ?? 0;
  input.subjects[input.key] = ordinal + 1;
  const adopted = migratedRun({ ...input.record, ordinal, now: input.now });
  input.runs.push(adopted.run);
  input.branches.set(adopted.run.correlationId, [adopted.branch]);
}
function promoteLifecycle(run, candidate) {
  const rank = { pending: 0, failed: 1, claimed: 2, starting: 3 };
  if ((rank[candidate.state] ?? 0) <= (rank[run.state] ?? 0)) {
    return run;
  }
  return {
    ...run,
    state: candidate.state,
    stateReason: candidate.stateReason,
    lease: candidate.lease,
    reservation: candidate.reservation,
    attempts: candidate.attempts,
    updatedAt: candidate.updatedAt
  };
}
function mergeLegacyRow(input) {
  const run = input.runs[input.openIndex];
  if (run === undefined) {
    return;
  }
  const reference = referenceOf(input.record.event, run.reservation === null);
  const folded = reference === null ? run : joinReference({ run, reference, now: input.now }).run;
  const migrated = migratedRun({
    event: input.record.event,
    ordinal: run.ordinal,
    now: input.now,
    reserved: input.record.reserved
  });
  const promoted = promoteLifecycle(folded, migrated.run);
  input.runs[input.openIndex] = promoted;
  const recorded = input.branches.get(run.correlationId) ?? [];
  recorded.push(migrated.branch);
  input.branches.set(run.correlationId, recorded);
}
async function planAdoption(input) {
  const now = input.now ?? nowIso();
  const records = await readLegacyRows(input.store);
  const runs = [];
  const branches = new Map;
  const subjects = {};
  for (const record of records) {
    const key = subjectKeyOf(record.event);
    const openIndex = runs.findIndex((run) => run.state !== "dispatched" && run.state !== "dead-lettered" && subjectKeyOfRun(run) === key);
    if (openIndex !== -1 && !isTerminalLegacyOutcome(record.event)) {
      mergeLegacyRow({ runs, openIndex, record, now, branches });
    } else {
      addMigratedRun({ runs, record, now, subjects, branches, key });
    }
  }
  const auditIntents = runs.map((run) => ({
    eventType: "run.migrated",
    correlationId: run.correlationId,
    deliveryIds: run.sourceReferences.map((reference) => reference.deliveryId),
    stateBranches: branches.get(run.correlationId) ?? [],
    state: run.state
  }));
  return { document: { schemaVersion: RUNS_SCHEMA_VERSION, subjects, runs, auditIntents } };
}
async function hasPostRunDeliveries(store) {
  const stored = await store.readJson(EVENTS_FILE, (raw) => raw);
  if (stored.status !== "ok" || !Array.isArray(stored.value)) {
    return false;
  }
  return stored.value.some((raw) => {
    const row = recordOf(raw);
    return row !== null && (row.state === undefined || row.runCorrelationId !== undefined);
  });
}

// service/poll/runs-document.ts
var RUNS_FILE = "runs.json";
var MAX_TERMINAL_RUNS = 500;
var queueChain = { write: Promise.resolve() };
function inQueueChain(task) {
  const run = queueChain.write.then(task, task);
  queueChain.write = run;
  return run;
}
function settled() {}
function whenQueueIdle() {
  return queueChain.write.then(settled, settled);
}
var adoptionPasses = new WeakMap;
function isTerminalRun(run) {
  return run.state === "dispatched" || run.state === "dead-lettered";
}
function runHistoryIndicatesSession(run) {
  return run.session !== null || run.attempts.some((attempt) => attempt.outcome === "dispatched" || attempt.sessionId !== null);
}
async function runAdoption(input) {
  const stored = await input.store.readJson(RUNS_FILE, parseRunsDocument);
  if (stored.status === "ok") {
    return "present";
  }
  if (stored.status === "quarantined") {
    input.log.warn("stored run document was unusable and has been set aside", {
      quarantinePath: stored.quarantinePath
    });
    return "unreadable";
  }
  if (await hasPostRunDeliveries(input.store)) {
    input.log.warn("runs.json is absent while post-run-layer deliveries exist; refusing legacy adoption");
    return "unreadable";
  }
  const plan = await planAdoption({
    store: input.store,
    ...input.now !== undefined && { now: input.now }
  });
  await input.store.writeJson(RUNS_FILE, plan.document);
  return "adopted";
}
function startAdoption(input) {
  const pass = runAdoption(input).catch((cause) => {
    adoptionPasses.delete(input.store);
    throw cause;
  });
  adoptionPasses.set(input.store, pass);
  return pass;
}
async function ensureRunsAdopted(input) {
  return await (adoptionPasses.get(input.store) ?? startAdoption(input));
}
async function readRunsDocument(input) {
  const outcome = await ensureRunsAdopted(input);
  if (outcome === "unreadable") {
    throw new StorageUnavailableError("run document is unreadable; refusing to serve run state from a quarantined runs.json");
  }
  const stored = await input.store.readJson(RUNS_FILE, parseRunsDocument);
  if (stored.status !== "ok") {
    throw new StorageUnavailableError("run document disappeared after adoption; refusing to serve an empty run history");
  }
  return await flushRunAuditIntents({ ...input, document: stored.value, runsFile: RUNS_FILE });
}
async function previewRunsDocument(input) {
  const outcome = await ensureRunsAdopted(input);
  if (outcome === "unreadable") {
    throw new StorageUnavailableError("run document is unreadable; refusing to serve run state from a quarantined runs.json");
  }
  const stored = await input.store.readJson(RUNS_FILE, parseRunsDocument);
  if (stored.status !== "ok") {
    throw new StorageUnavailableError("run document disappeared after adoption; refusing to serve an empty run history");
  }
  return stored.value;
}
async function pruneEvictedRunDeliveries(input) {
  try {
    const stored = await input.store.readJson(EVENTS_FILE, (raw) => raw);
    if (stored.status !== "ok" || !Array.isArray(stored.value)) {
      return;
    }
    const retained = stored.value.filter((row) => {
      if (!isRecord(row) || row.state !== undefined || typeof row.runCorrelationId !== "string") {
        return true;
      }
      return input.retainedRunIds.has(row.runCorrelationId);
    });
    if (retained.length !== stored.value.length) {
      await input.store.writeJson(EVENTS_FILE, retained);
    }
  } catch (cause) {
    input.log.warn("run-linked delivery retention could not be synchronized", {
      errorKind: cause instanceof Error ? cause.name : typeof cause
    });
  }
}
async function writeRunsDocument(input) {
  const terminal = input.document.runs.filter((run) => isTerminalRun(run));
  const evictCount = Math.max(terminal.length - MAX_TERMINAL_RUNS, 0);
  const dropped = new Set(terminal.slice(0, evictCount).map((run) => run.correlationId));
  const runs = input.document.runs.filter((run) => !dropped.has(run.correlationId));
  const persisted = { ...input.document, runs };
  await input.store.writeJson(RUNS_FILE, persisted);
  if (dropped.size > 0) {
    await pruneEvictedRunDeliveries({
      ...input,
      retainedRunIds: new Set(runs.map((run) => run.correlationId))
    });
  }
  return persisted;
}
function openAttempt(attempt) {
  return {
    attempt,
    dispatchToken: null,
    reservedAt: null,
    outcome: null,
    sessionId: null,
    reason: null,
    resultReportedAt: null
  };
}
function currentAttempt(run) {
  let found = openAttempt(run.attempt);
  for (const entry of run.attempts) {
    if (entry.attempt === run.attempt) {
      found = entry;
    }
  }
  return found;
}
function attemptHistory(run, record) {
  const index = run.attempts.map((entry) => entry.attempt).lastIndexOf(record.attempt);
  const updated = index === -1 ? [...run.attempts, record] : run.attempts.map((entry, position) => position === index ? record : entry);
  return updated.slice(-MAX_ATTEMPT_RECORDS);
}
function openedHistory(run) {
  return [...run.attempts, openAttempt(run.attempt)].slice(-MAX_ATTEMPT_RECORDS);
}

// service/poll/runs-join.ts
function subjectShapeOf(delivery) {
  try {
    const subjectType = subjectTypeOf(delivery);
    const subjectKey = buildSubjectKey({
      accountNumericUserId: delivery.accountNumericUserId,
      repository: delivery.repository,
      subjectType,
      subjectNumber: delivery.issueNumber,
      ordinal: 0
    });
    return { subjectKey, subjectType };
  } catch {
    return null;
  }
}
function originOf(delivery) {
  if (delivery.kind === "assignment") {
    return "assignment";
  }
  if (delivery.kind === "review") {
    return "review";
  }
  const marker = "~mention~";
  const at = delivery.id.lastIndexOf(marker);
  if (at === -1) {
    return null;
  }
  const suffix = delivery.id.slice(at + marker.length);
  if (suffix === "body") {
    return "body";
  }
  const commentId = Number(suffix);
  return commentId > 0 && String(commentId) === suffix ? `comment:${commentId}` : null;
}
function referenceOf(delivery, isPresentAtAuthorization) {
  const origin = originOf(delivery);
  if (origin === null) {
    return null;
  }
  return {
    deliveryId: delivery.id,
    kind: delivery.kind,
    origin,
    sourceUrl: delivery.issueUrl,
    detectedAt: delivery.detectedAt,
    presentAtAuthorization: isPresentAtAuthorization,
    ...actorFieldsOf({
      actorLogin: delivery.actorLogin,
      actorAttribution: delivery.actorAttribution
    })
  };
}
function joinReference(input) {
  const { run, reference, now } = input;
  if (run.sourceReferences.some((entry) => entry.deliveryId === reference.deliveryId)) {
    return { run: { ...run, updatedAt: now }, retained: true };
  }
  const counted = run.referenceCount + 1;
  if (run.sourceReferences.length >= MAX_SOURCE_REFERENCES) {
    return {
      run: {
        ...run,
        referenceCount: counted,
        referencesNotRetained: run.referencesNotRetained + 1,
        referencesTruncated: true,
        updatedAt: now
      },
      retained: false
    };
  }
  return {
    run: {
      ...run,
      sourceReferences: [...run.sourceReferences, reference],
      referenceCount: counted,
      updatedAt: now
    },
    retained: true
  };
}
function runForDelivery(input) {
  const { delivery, shape, ordinal, reference, now, prompt } = input;
  const runKey = buildRunKey({
    accountNumericUserId: delivery.accountNumericUserId,
    repository: delivery.repository,
    subjectType: shape.subjectType,
    subjectNumber: delivery.issueNumber,
    ordinal
  });
  const correlationId = buildCorrelationId(runKey);
  return {
    runKey,
    correlationId,
    attachmentId: buildAttachmentId(correlationId),
    ordinal,
    subjectType: shape.subjectType,
    subjectNumber: delivery.issueNumber,
    repository: delivery.repository,
    accountNumericUserId: delivery.accountNumericUserId,
    bindingId: delivery.bindingId,
    projectId: delivery.projectId,
    worktreeOption: delivery.worktreeOption,
    prompt,
    actorPolicy: null,
    state: "pending",
    stateReason: null,
    attempt: 1,
    requeuesUsed: 0,
    sourceReferences: [reference],
    referenceCount: 1,
    referencesNotRetained: 0,
    referencesTruncated: false,
    lease: null,
    reservation: null,
    attempts: [],
    session: null,
    verification: null,
    createdAt: now,
    updatedAt: now
  };
}
function subjectKeyOfRun2(run) {
  return buildSubjectKey({
    accountNumericUserId: run.accountNumericUserId,
    repository: run.repository,
    subjectType: run.subjectType,
    subjectNumber: run.subjectNumber,
    ordinal: 0
  });
}
function applyEnqueue(input) {
  const prompt = input.prompt ?? null;
  const runs = [...input.document.runs];
  const subjects = { ...input.document.subjects };
  const links = new Map;
  const created = [];
  const joins = [];
  for (const delivery of input.deliveries) {
    const shape = subjectShapeOf(delivery);
    const reference = shape === null ? null : referenceOf(delivery, true);
    if (shape === null || reference === null) {
      continue;
    }
    const index = runs.findIndex((run2) => !isTerminalRun(run2) && subjectKeyOfRun2(run2) === shape.subjectKey);
    const open = index === -1 ? undefined : runs[index];
    if (open !== undefined) {
      const authorizedReference = { ...reference, presentAtAuthorization: open.reservation === null };
      const folded = joinReference({ run: open, reference: authorizedReference, now: input.now });
      runs[index] = folded.run;
      joins.push({ run: folded.run, reference: authorizedReference, retained: folded.retained });
      links.set(delivery.id, folded.run.correlationId);
      continue;
    }
    const ordinal = subjects[shape.subjectKey] ?? 0;
    subjects[shape.subjectKey] = ordinal + 1;
    const run = runForDelivery({ delivery, shape, ordinal, reference, now: input.now, prompt });
    runs.push(run);
    created.push(run);
    links.set(delivery.id, run.correlationId);
  }
  const auditIntents = [
    ...input.document.auditIntents ?? [],
    ...created.map((run) => ({
      eventType: "run.created",
      correlationId: run.correlationId,
      deliveryIds: run.sourceReferences.map((reference) => reference.deliveryId)
    }))
  ];
  return { document: { schemaVersion: RUNS_SCHEMA_VERSION, subjects, runs, auditIntents }, links, created, joins };
}

// service/poll/scan.ts
var SCAN_STATE_FILE = "scan-state.json";
function emptyBindingScan() {
  return { lastScanAt: null, lastError: null, baselineAt: null, forceReplay: false, rescanFrom: null };
}
function emptyScanState() {
  return { bindings: {} };
}
function optionalStampHolds(value) {
  return value === undefined || value === null || typeof value === "string";
}
function stampMemberOf(value) {
  return typeof value === "string" ? value : null;
}
function parseBindingSlot(value) {
  if (!isRecord(value)) {
    return null;
  }
  const { lastScanAt, lastError, baselineAt, forceReplay, rescanFrom } = value;
  const members = [
    [lastScanAt === null || typeof lastScanAt === "string", lastScanAt],
    [lastError === null || typeof lastError === "string", lastError],
    [optionalStampHolds(baselineAt), baselineAt],
    [forceReplay === undefined || typeof forceReplay === "boolean", forceReplay],
    [optionalStampHolds(rescanFrom), rescanFrom]
  ];
  if (members.some(([holds]) => !holds)) {
    return null;
  }
  return {
    lastScanAt: stampMemberOf(lastScanAt),
    lastError: stampMemberOf(lastError),
    baselineAt: stampMemberOf(baselineAt),
    forceReplay: forceReplay === true,
    rescanFrom: stampMemberOf(rescanFrom)
  };
}
function parseStoredScanState(raw) {
  if (!isRecord(raw) || !isRecord(raw.bindings)) {
    return null;
  }
  const bindings = {};
  for (const [key, value] of Object.entries(raw.bindings)) {
    const slot = parseBindingSlot(value);
    if (slot === null) {
      return null;
    }
    bindings[key] = slot;
  }
  return { bindings };
}
var scanChain = { write: Promise.resolve() };
function serializeScan(task) {
  const run = scanChain.write.then(task, task);
  scanChain.write = run;
  return run;
}
async function readScanState(deps) {
  const { store, log } = deps;
  try {
    const result = await store.readJson(SCAN_STATE_FILE, parseStoredScanState);
    if (result.status === "ok") {
      return result.value;
    }
    if (result.status === "quarantined") {
      log.warn("stored scan state was unusable and has been set aside", {
        quarantinePath: result.quarantinePath
      });
    }
    return emptyScanState();
  } catch (cause) {
    log.warn("scan state read failed", { errorKind: cause instanceof Error ? cause.name : typeof cause });
    return emptyScanState();
  }
}
async function writeScanState(input) {
  await input.store.writeJson(SCAN_STATE_FILE, input.state);
}
function withBindingScanState(input) {
  return { bindings: { ...input.state.bindings, [input.bindingId]: input.slot } };
}
function bindingScanOf(state, bindingId) {
  return state.bindings[bindingId] ?? emptyBindingScan();
}
// service/poll/events-write.ts
function buildEventId(input) {
  const { repository } = input;
  const base = `evt-${repository.owner}~${repository.name}~${input.issueNumber}~${input.accountNumericUserId}`;
  return input.discriminator === undefined ? base : `${base}${input.discriminator}`;
}
function discriminatorOf(snapshot) {
  if (snapshot.kind === "mention") {
    return snapshot.origin === "body" ? "~mention~body" : `~mention~${snapshot.commentId}`;
  }
  return snapshot.kind === "review" ? "~review" : undefined;
}
function headShaOf(snapshot) {
  return snapshot.kind === "review" ? snapshot.headSha : null;
}
function baseRefOf(snapshot) {
  return snapshot.kind === "review" ? snapshot.baseRef : null;
}
function subjectTypeOfSnapshot(snapshot) {
  if (snapshot.subjectType !== undefined) {
    return snapshot.subjectType;
  }
  return snapshot.kind === "review" ? "pull_request" : "issue";
}
function createEvent(snapshot) {
  const separatorIndex = snapshot.repository.indexOf("/");
  const owner = separatorIndex === -1 ? snapshot.repository : snapshot.repository.slice(0, separatorIndex);
  const name = separatorIndex === -1 ? "" : snapshot.repository.slice(separatorIndex + 1);
  const base = {
    bindingId: snapshot.bindingId,
    kind: snapshot.kind,
    repository: snapshot.repository,
    accountNumericUserId: snapshot.accountNumericUserId,
    accountLogin: snapshot.accountLogin,
    projectId: snapshot.projectId,
    worktreeOption: snapshot.worktreeOption,
    issueNumber: snapshot.issue.issueNumber,
    issueTitle: snapshot.issue.issueTitle,
    issueUrl: snapshot.issue.issueUrl,
    issueBodyExcerpt: snapshot.issue.issueBodyExcerpt,
    actorLogin: snapshot.actorLogin,
    actorAttribution: snapshot.actorAttribution,
    headSha: headShaOf(snapshot),
    baseRef: baseRefOf(snapshot),
    triggerNote: snapshot.triggerNote,
    detectedAt: snapshot.detectedAt,
    subjectType: subjectTypeOfSnapshot(snapshot)
  };
  return {
    ...base,
    id: buildEventId({
      repository: { owner, name },
      issueNumber: snapshot.issue.issueNumber,
      accountNumericUserId: snapshot.accountNumericUserId,
      discriminator: discriminatorOf(snapshot)
    })
  };
}
// service/poll/events.ts
var MAX_DISPATCHED_EVENTS = 500;
function isDispatchedTerminal(event) {
  return event.state === "dispatched";
}
function serializedQueue(events, retainedRunIds) {
  const retained = retainedRunIds === undefined ? events : events.filter((event) => event.state !== undefined || event.runCorrelationId === undefined || retainedRunIds.has(event.runCorrelationId));
  const live = retained.filter((event) => !isDispatchedTerminal(event));
  const dispatched = retained.filter((event) => isDispatchedTerminal(event)).slice(-MAX_DISPATCHED_EVENTS);
  return [...live, ...dispatched];
}
var recoveredQuarantines = new WeakMap;
function claimQuarantinePass(store, quarantinePath) {
  const handled = recoveredQuarantines.get(store) ?? new Set;
  recoveredQuarantines.set(store, handled);
  if (handled.has(basename(quarantinePath))) {
    return false;
  }
  handled.add(basename(quarantinePath));
  return true;
}
async function resetScanWindows(input) {
  return await serializeScan(async () => {
    const state = await readScanState(input);
    const bindings = {};
    let cleared = 0;
    for (const [bindingId, slot] of Object.entries(state.bindings)) {
      const next = slot.lastScanAt === null && slot.forceReplay ? slot : { ...slot, lastScanAt: null, forceReplay: true };
      cleared += next === slot ? 0 : 1;
      bindings[bindingId] = next;
    }
    if (cleared > 0) {
      await writeScanState({ store: input.store, state: { bindings } });
    }
    return cleared;
  });
}
async function recordQueueRecovery(input) {
  try {
    await appendAudit(input.store, {
      eventType: "delivery.recovered",
      actorSource: "service",
      entity: { kind: "delivery", id: EVENTS_FILE },
      decision: null,
      reason: "events queue quarantined — scan windows reset",
      correlationId: newCorrelationId(),
      details: { quarantinePath: input.quarantinePath, bindingsReset: input.bindingsReset }
    });
  } catch (cause) {
    input.log.warn("queue recovery audit row could not be appended", {
      errorKind: cause instanceof Error ? cause.name : typeof cause
    });
  }
}
async function recoverQuarantinedQueue(input) {
  if (!claimQuarantinePass(input.store, input.quarantinePath)) {
    return;
  }
  const bindingsReset = await resetScanWindows(input);
  input.log.info("scan windows reset after the event queue was quarantined", { bindingsReset });
  await recordQueueRecovery({ ...input, bindingsReset });
}
var QUARANTINE_EVIDENCE_PREFIX2 = `${EVENTS_FILE}.corrupt-`;
async function recoverFromEvidence(input) {
  const entries = await input.store.listDir(".");
  for (const entry of entries) {
    if (entry.startsWith(QUARANTINE_EVIDENCE_PREFIX2)) {
      await recoverQuarantinedQueue({ ...input, quarantinePath: join2(input.store.dataDir, entry) });
    }
  }
}
async function readQueue(input) {
  const result = await input.store.readJson(EVENTS_FILE, parseStoredEvents);
  if (result.status === "ok") {
    return result.value;
  }
  if (result.status === "quarantined") {
    input.log.warn("stored event queue was unusable and has been set aside", {
      quarantinePath: result.quarantinePath
    });
  }
  if (result.status === "quarantined" && result.quarantinePath !== null) {
    await recoverQuarantinedQueue({ ...input, quarantinePath: result.quarantinePath });
  } else {
    await recoverFromEvidence(input);
  }
  return [];
}
async function readEvents(input) {
  try {
    return await readQueue(input);
  } catch (cause) {
    input.log.warn("event queue read failed", { errorKind: cause instanceof Error ? cause.name : typeof cause });
    return [];
  }
}
async function enqueueWithinChain(input) {
  const existing = await readQueue(input);
  const known = new Set(existing.map((event) => event.id));
  const fresh = input.incoming.filter((event) => {
    if (known.has(event.id)) {
      return false;
    }
    known.add(event.id);
    return true;
  });
  if (fresh.length === 0) {
    return [];
  }
  const document = await readRunsDocument(input);
  const outcome = applyEnqueue({
    document,
    deliveries: fresh,
    now: nowIso(),
    ...input.prompt !== undefined && { prompt: input.prompt }
  });
  const appended = fresh.map((event) => {
    const runCorrelationId = outcome.links.get(event.id);
    return runCorrelationId === undefined ? event : { ...event, runCorrelationId };
  });
  const persistedRuns = await writeRunsDocument({ ...input, document: outcome.document });
  const persistedIds = new Set(persistedRuns.runs.map((run) => run.correlationId));
  await input.store.writeJson(EVENTS_FILE, serializedQueue([...existing, ...appended], persistedIds));
  await readRunsDocument(input);
  await recordEnqueueAudits({ ...input, outcome, appended });
  return appended;
}
async function enqueueEvents(input) {
  return await inQueueChain(async () => await enqueueWithinChain(input));
}

// service/poll/excerpt-trim.ts
var DAY_MS2 = 86400000;
var RUN_DISPATCHED = "dispatched";
async function readRunStates(input) {
  const stored = await input.store.readJson(RUNS_FILE, parseRunsDocument);
  if (stored.status === "quarantined") {
    input.log.warn("stored run document is unreadable; post-003 excerpts stay put", {
      quarantinePath: stored.quarantinePath
    });
  }
  if (stored.status !== "ok") {
    return new Map;
  }
  return new Map(stored.value.runs.map((run) => [run.correlationId, run.state]));
}
function dispatchFinished(event, runStates) {
  if (isDispatchedTerminal(event)) {
    return true;
  }
  if (event.state !== undefined || event.runCorrelationId === undefined) {
    return false;
  }
  return runStates.get(event.runCorrelationId) === RUN_DISPATCHED;
}
function clearable(input) {
  const { event, runStates, cutoff } = input;
  if (!dispatchFinished(event, runStates) || event.excerptTrimmedAt !== undefined || event.issueBodyExcerpt === "") {
    return false;
  }
  const stamped = Date.parse(event.detectedAt);
  return Number.isFinite(stamped) && stamped < cutoff;
}
async function trimExcerpts(input) {
  const now = input.now ?? Date.now();
  return await inQueueChain(async () => {
    const events = await readEvents({ store: input.store, log: input.log });
    const cutoff = now - input.config.excerptRetentionDays * DAY_MS2;
    const runStates = events.length === 0 ? new Map : await readRunStates({ store: input.store, log: input.log });
    const eligible = events.filter((event) => clearable({ event, runStates, cutoff }));
    if (eligible.length === 0) {
      return { cleared: 0 };
    }
    const clearing = new Set(eligible.map((event) => event.id));
    const clearedAt = new Date(now).toISOString();
    const next = events.map((event) => clearing.has(event.id) ? { ...event, issueBodyExcerpt: "", excerptTrimmedAt: clearedAt } : event);
    await input.store.writeJson(EVENTS_FILE, next);
    await appendAudit(input.store, {
      eventType: "audit.trimmed",
      actorSource: "service",
      entity: { kind: "service", id: CONFIGURATION_ENTITY_ID },
      decision: "trimmed",
      reason: "stored payload excerpts trimmed; limit reached: excerpt-days",
      details: {
        entriesRemoved: eligible.length,
        limitReached: "excerpt-days",
        minimalReferencesPreserved: 0
      }
    });
    input.log.info("stored payload excerpts trimmed", { entriesRemoved: eligible.length });
    return { cleared: eligible.length };
  });
}

// service/retention.ts
async function runGuarded(input) {
  try {
    await input.pass();
  } catch (cause) {
    input.log.warn(input.message, { errorKind: cause instanceof Error ? cause.name : typeof cause });
  }
}
async function runRetentionPasses(input) {
  await runGuarded({
    message: "audit retention pass failed",
    log: input.log,
    pass: () => trimAudit(input)
  });
  await runGuarded({
    message: "excerpt retention pass failed",
    log: input.log,
    pass: () => trimExcerpts(input)
  });
}
async function readOpenConfig(store, log) {
  try {
    const { config } = configFromStore(await store.readJson(CONFIG_FILE, parseStoredConfig), log);
    return config;
  } catch (cause) {
    log.warn("retention configuration read failed", {
      errorKind: cause instanceof Error ? cause.name : typeof cause
    });
    return DEFAULT_CONFIG;
  }
}
async function runRetentionAtOpen(input) {
  if (input.store === null) {
    return;
  }
  const config = await readOpenConfig(input.store, input.log);
  await runRetentionPasses({ store: input.store, log: input.log, config });
}

// service/auth.ts
import { createHash as createHash3, timingSafeEqual } from "node:crypto";
var BEARER_PREFIX = "Bearer ";
var DIGEST_ALGORITHM = "sha256";
function bearerCredential(header) {
  if (header === undefined) {
    return "";
  }
  return header.startsWith(BEARER_PREFIX) ? header.slice(BEARER_PREFIX.length) : "";
}
function digestsMatch(presented, expected) {
  const left = createHash3(DIGEST_ALGORITHM).update(presented).digest();
  const right = createHash3(DIGEST_ALGORITHM).update(expected).digest();
  return timingSafeEqual(left, right);
}
function isAuthorized(header, token) {
  return digestsMatch(bearerCredential(header), token);
}

// service/body.ts
var BYTES_PER_UTF16_UNIT = 3;
var REQUEST_BODY_MAX_BYTES = REQUEST_BODY_MAX_CHARS * BYTES_PER_UTF16_UNIT;
function readBytes(request) {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    let isSettled = false;
    const finish = (outcome) => {
      if (isSettled) {
        return;
      }
      isSettled = true;
      resolve(outcome);
    };
    request.on("data", (chunk) => {
      total += chunk.length;
      if (total > REQUEST_BODY_MAX_BYTES) {
        request.resume();
        finish({ kind: "too-large" });
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      finish({ kind: "complete", chunks });
    });
    request.on("error", () => {
      finish({ kind: "aborted" });
    });
    request.on("close", () => {
      finish({ kind: "aborted" });
    });
  });
}
async function readJsonBody(request) {
  const outcome = await readBytes(request);
  if (outcome.kind === "too-large") {
    return { status: "too-large", consumed: false };
  }
  if (outcome.kind === "aborted") {
    return { status: "invalid-json", consumed: false };
  }
  const text = Buffer.concat(outcome.chunks).toString("utf8");
  if (text === "") {
    return { status: "empty", consumed: true };
  }
  if (text.length > REQUEST_BODY_MAX_CHARS) {
    return { status: "too-large", consumed: true };
  }
  const parsed = parseJsonText(text);
  if (!parsed.ok) {
    return { status: "invalid-json", consumed: true };
  }
  return { status: "ok", consumed: true, value: parsed.value };
}

// service/store/index.ts
import { promises as fs5 } from "node:fs";
import { isAbsolute, resolve as resolve2 } from "node:path";

// service/store/dir.ts
import { promises as fs } from "node:fs";
import { resolve } from "node:path";
var DATA_DIR_MODE = 448;
var DATA_FILE_MODE = 384;
var STORE_RELATIVE_PATH = ".config/openchamber/mecha-turk";
function resolveDataDir(env) {
  const home = env.HOME;
  if (home === undefined || home === "") {
    throw new StorageUnavailableError("HOME is not set; the Mecha Turk data directory cannot be located");
  }
  return resolve(home, STORE_RELATIVE_PATH);
}
async function ensureDir(dirPath) {
  try {
    await fs.mkdir(dirPath, { recursive: true, mode: DATA_DIR_MODE });
    await fs.chmod(dirPath, DATA_DIR_MODE);
  } catch (error) {
    throw new StorageUnavailableError(`directory cannot be created or made owner-only: ${dirPath}`, error);
  }
}

// service/store/json.ts
import { randomUUID } from "node:crypto";
import { promises as fs3 } from "node:fs";
import { dirname, join as join3 } from "node:path";

// service/store/files.ts
import { promises as fs2 } from "node:fs";
function isMissingFile(error) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
async function readTextFile(filePath) {
  try {
    return await fs2.readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) {
      return null;
    }
    throw new StorageUnavailableError(`store file cannot be read: ${filePath}`, error);
  }
}
async function removeIfPresent(filePath) {
  try {
    await fs2.rm(filePath, { force: true });
  } catch {
    return;
  }
}

// service/store/json.ts
var QUARANTINE_MARKER = ".corrupt-";
var TEMP_SUFFIX = ".tmp";
var JSON_INDENT = 2;
async function writeSyncedTempFile(tempPath, text) {
  const handle = await fs3.open(tempPath, "w", DATA_FILE_MODE);
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function quarantine(filePath) {
  const quarantinePath = `${filePath}${QUARANTINE_MARKER}${Date.now()}-${randomUUID()}`;
  try {
    await fs3.rename(filePath, quarantinePath);
  } catch (error) {
    if (isMissingFile(error)) {
      return { status: "quarantined", quarantinePath: null };
    }
    throw new StorageUnavailableError(`unusable store file cannot be set aside: ${filePath}`, error);
  }
  return { status: "quarantined", quarantinePath };
}
async function writeJsonAtomic(filePath, value) {
  const text = `${JSON.stringify(value, null, JSON_INDENT)}
`;
  const tempPath = `${filePath}${TEMP_SUFFIX}${randomUUID()}`;
  await ensureDir(dirname(filePath));
  try {
    await writeSyncedTempFile(tempPath, text);
    await fs3.rename(tempPath, filePath);
  } catch (error) {
    await removeIfPresent(tempPath);
    throw new StorageUnavailableError(`store file cannot be written: ${filePath}`, error);
  }
}
var TEMP_DEBRIS_PATTERN = /\.tmp[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
var SWEEP_MAX_DEPTH = 3;
function isTempDebris(name) {
  return TEMP_DEBRIS_PATTERN.test(name);
}
async function sweepTempDebris(dirPath, depth = SWEEP_MAX_DEPTH) {
  if (depth < 0) {
    return 0;
  }
  let entries;
  try {
    entries = await fs3.readdir(dirPath, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    const target = join3(dirPath, entry.name);
    if (entry.isDirectory()) {
      removed += await sweepTempDebris(target, depth - 1);
    } else if (entry.isFile() && isTempDebris(entry.name)) {
      removed += 1;
      await removeIfPresent(target);
    }
  }
  return removed;
}
async function readJsonFile(filePath, validate) {
  const text = await readTextFile(filePath);
  if (text === null) {
    return { status: "absent" };
  }
  const parsed = parseJsonText(text);
  if (!parsed.ok) {
    return await quarantine(filePath);
  }
  const value = validate(parsed.value);
  if (value === null) {
    return await quarantine(filePath);
  }
  return { status: "ok", value };
}

// service/store/ndjson.ts
import { randomUUID as randomUUID2 } from "node:crypto";
import { promises as fs4 } from "node:fs";
import { dirname as dirname2 } from "node:path";
async function appendJsonLine(filePath, entry) {
  const line = `${JSON.stringify(entry)}
`;
  try {
    await fs4.mkdir(dirname2(filePath), { recursive: true, mode: DATA_DIR_MODE });
    const handle = await fs4.open(filePath, "a", DATA_FILE_MODE);
    try {
      await handle.writeFile(line, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof StorageUnavailableError) {
      throw error;
    }
    throw new StorageUnavailableError(`log line cannot be appended: ${filePath}`, error);
  }
}
async function writeJsonLinesAtomic(filePath, entries) {
  const text = entries.map((entry) => `${JSON.stringify(entry)}
`).join("");
  const tempPath = `${filePath}${TEMP_SUFFIX}${randomUUID2()}`;
  await ensureDir(dirname2(filePath));
  try {
    await writeSyncedTempFile(tempPath, text);
    await fs4.rename(tempPath, filePath);
  } catch (error) {
    await removeIfPresent(tempPath);
    throw new StorageUnavailableError(`store file cannot be written: ${filePath}`, error);
  }
}
async function readJsonLines(filePath, parse) {
  const text = await readTextFile(filePath);
  if (text === null) {
    return { entries: [], malformed: 0 };
  }
  const entries = [];
  let malformed = 0;
  for (const line of text.split(`
`)) {
    const trimmed = line.trim();
    if (trimmed === "") {
      continue;
    }
    const parsed = parseJsonText(trimmed);
    const value = parsed.ok ? parse(parsed.value) : null;
    if (value === null) {
      malformed += 1;
      continue;
    }
    entries.push(value);
  }
  return { entries, malformed };
}

// service/store/index.ts
var SERVICE_SCHEMA_VERSION = 1;
var STATE_FILE = "state.json";
function parseServiceState(raw) {
  if (!isRecord(raw)) {
    return null;
  }
  const version = raw.schemaVersion;
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) {
    return null;
  }
  const initializedAt = typeof raw.initializedAt === "string" ? raw.initializedAt : nowIso();
  return { schemaVersion: version, initializedAt };
}
async function readOrCreateSchemaVersion(dataDir) {
  const statePath = resolve2(dataDir, STATE_FILE);
  const result = await readJsonFile(statePath, parseServiceState);
  if (result.status === "ok") {
    return result.value.schemaVersion;
  }
  const state = { schemaVersion: SERVICE_SCHEMA_VERSION, initializedAt: nowIso() };
  await writeJsonAtomic(statePath, state);
  return SERVICE_SCHEMA_VERSION;
}
function resolveStorePath(dataDir, relativePath) {
  if (relativePath === "" || isAbsolute(relativePath) || relativePath.includes("..")) {
    throw new Error(`store path must be a relative path inside the data directory: ${relativePath}`);
  }
  return resolve2(dataDir, relativePath);
}
async function listStoreDir(dataDir, relativePath) {
  const target = resolveStorePath(dataDir, relativePath);
  try {
    return await fs5.readdir(target);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw new StorageUnavailableError(`store directory cannot be listed: ${target}`, error);
  }
}
async function removeStoreFile(dataDir, relativePath) {
  const target = resolveStorePath(dataDir, relativePath);
  try {
    await fs5.rm(target, { force: true });
  } catch (error) {
    throw new StorageUnavailableError(`store file cannot be removed: ${target}`, error);
  }
}
function createStore(dataDir, schemaVersion) {
  const locate = (relativePath) => resolveStorePath(dataDir, relativePath);
  return {
    dataDir,
    schemaVersion,
    readJson: async (relativePath, validate) => await readJsonFile(locate(relativePath), validate),
    writeJson: async (relativePath, value) => await writeJsonAtomic(locate(relativePath), value),
    appendLine: async (relativePath, entry) => await appendJsonLine(locate(relativePath), entry),
    writeLines: async (relativePath, entries) => await writeJsonLinesAtomic(locate(relativePath), entries),
    readLines: async (relativePath, parse) => await readJsonLines(locate(relativePath), parse),
    listDir: async (relativePath) => await listStoreDir(dataDir, relativePath),
    removeFile: async (relativePath) => await removeStoreFile(dataDir, relativePath)
  };
}
async function openStore(options) {
  const { dataDir } = options;
  await ensureDir(dataDir);
  await sweepTempDebris(dataDir);
  const schemaVersion = await readOrCreateSchemaVersion(dataDir);
  return createStore(dataDir, schemaVersion);
}

// service/pipeline.ts
var CONTENT_TYPE_HEADER = "content-type";
var CONTENT_LENGTH_HEADER = "content-length";
var CONNECTION_HEADER = "connection";
var PARAM_PREFIX = ":";
function matchPathPattern(routePath, pathname) {
  const pattern = routePath.split("/");
  const segments = pathname.split("/");
  if (pattern.length !== segments.length) {
    return null;
  }
  const params = {};
  for (const [index, expected] of pattern.entries()) {
    const actual = segments[index];
    if (actual === undefined) {
      return null;
    }
    if (expected.startsWith(PARAM_PREFIX)) {
      if (actual === "") {
        return null;
      }
      params[expected.slice(PARAM_PREFIX.length)] = actual;
    } else if (expected !== actual) {
      return null;
    }
  }
  return params;
}
function isPatternPath(routePath) {
  return routePath.split("/").some((segment) => segment.startsWith(PARAM_PREFIX));
}
function writeResponse(call, response) {
  const outgoing = call.response;
  if (call.sent || outgoing.headersSent) {
    call.deps.log.warn("response already committed");
    return;
  }
  call.sent = true;
  const serialized = serializeBody(response.body);
  const status = serialized.ok ? response.status : STATUS.internal;
  const body = serialized.ok ? serialized.text : JSON.stringify(serialized.fallback.body);
  const text = redact(body);
  const headers = {
    [CONTENT_TYPE_HEADER]: JSON_CONTENT_TYPE,
    [CONTENT_LENGTH_HEADER]: String(Buffer.byteLength(text))
  };
  const extra = response.headers ?? {};
  for (const [name, value] of Object.entries(extra)) {
    headers[name] = value;
  }
  if (!call.bodyRead) {
    headers[CONNECTION_HEADER] = "close";
  }
  outgoing.writeHead(status, headers);
  outgoing.end(text);
}
function describeFailure(error, call) {
  if (error instanceof StorageUnavailableError) {
    return errorResponse(STATUS.storageUnavailable, { code: error.code, message: error.message });
  }
  const correlationId = newCorrelationId();
  call.deps.log.error("route failed", { correlationId, error: describeError(error) });
  return errorResponse(STATUS.internal, {
    code: "internal",
    message: "unexpected service failure",
    correlationId
  });
}
function patternRoutes(routes, pathname) {
  return routes.filter((route) => route.path !== pathname && isPatternPath(route.path) && matchPathPattern(route.path, pathname) !== null);
}
function matchRoute(call, url) {
  const method = call.request.method ?? "";
  const { routes } = call.deps;
  const candidates = [
    ...routes.filter((route2) => route2.path === url.pathname),
    ...patternRoutes(routes, url.pathname)
  ];
  if (candidates.length === 0) {
    return { kind: "not-found" };
  }
  const route = candidates.find((candidate) => candidate.method === method);
  if (route === undefined) {
    return { kind: "method-not-allowed", allow: candidates.map((candidate) => candidate.method) };
  }
  return { kind: "matched", route, params: matchPathPattern(route.path, url.pathname) ?? {} };
}
function refusalResponse(match) {
  if (match.kind === "not-found") {
    return errorResponse(STATUS.notFound, { code: "not-found", message: "no route for this path" });
  }
  return {
    status: STATUS.methodNotAllowed,
    body: errorBody({
      code: "method-not-allowed",
      message: "method not allowed for this path"
    }),
    headers: { allow: match.allow.join(", ") }
  };
}
async function readBody(call) {
  const result = await readJsonBody(call.request);
  call.bodyRead = result.consumed;
  if (result.status === "too-large") {
    writeResponse(call, errorResponse(STATUS.payloadTooLarge, {
      code: "payload-too-large",
      message: `request body exceeds the ${REQUEST_BODY_MAX_CHARS}-character limit`
    }));
    return null;
  }
  if (result.status === "invalid-json") {
    writeResponse(call, errorResponse(STATUS.badRequest, { code: "invalid-json", message: "request body must be valid JSON" }));
    return null;
  }
  return result.status === "ok" ? result.value : undefined;
}
function matchRequest(call) {
  const { request, deps } = call;
  if (!isAuthorized(request.headers.authorization, deps.env.token)) {
    writeResponse(call, unauthorizedResponse());
    return null;
  }
  const url = parseRequestTarget(request.url);
  if (url === null) {
    writeResponse(call, errorResponse(STATUS.badRequest, {
      code: "bad-path",
      message: "request target must be an absolute path on this service"
    }));
    return null;
  }
  const match = matchRoute(call, url);
  if (match.kind !== "matched") {
    writeResponse(call, refusalResponse(match));
    return null;
  }
  return { url, route: match.route, params: match.params };
}
async function runPipeline(call) {
  const matched = matchRequest(call);
  if (matched === null) {
    return;
  }
  const body = await readBody(call);
  if (body === null) {
    return;
  }
  const request = {
    method: call.request.method ?? "GET",
    url: matched.url,
    body,
    params: matched.params
  };
  let response;
  try {
    response = await matched.route.handler(call.deps.context, request);
  } catch (error) {
    response = describeFailure(error, call);
  }
  writeResponse(call, response);
}
function attachCompletion(call) {
  const startedAt = Date.now();
  const url = parseRequestTarget(call.request.url);
  let isSettled = false;
  const complete = () => {
    if (isSettled) {
      return;
    }
    isSettled = true;
    call.deps.state.inFlight -= 1;
    call.deps.log.info("request", {
      method: call.request.method ?? "unknown",
      path: url === null ? "<invalid-target>" : url.pathname,
      status: call.response.statusCode,
      durationMs: Date.now() - startedAt
    });
  };
  call.response.once("finish", complete);
  call.response.once("close", complete);
}
function createRequestHandler(deps) {
  return (request, response) => {
    deps.state.inFlight += 1;
    const call = { request, response, deps, bodyRead: false, sent: false };
    attachCompletion(call);
    runPipeline(call).catch((error) => {
      deps.log.error("request pipeline failed", { error: describeError(error) });
      writeResponse(call, errorResponse(STATUS.internal, {
        code: "internal",
        message: "unexpected service failure",
        correlationId: newCorrelationId()
      }));
    });
  };
}

// service/routes/credential.ts
var TOKEN_MAX_CHARS = 4096;
var EXPECTED_LOGIN_MAX_CHARS = 200;
var SCOPE_MISSING_PREFIX = "scope-missing:";
function readToken2(raw) {
  if (typeof raw !== "string") {
    return { issues: [{ field: "token", remediation: "send the GitHub token as a JSON string" }] };
  }
  const issues = [];
  if (raw === "") {
    issues.push({ field: "token", remediation: "the token must not be empty" });
  }
  if (/\s/.test(raw)) {
    issues.push({ field: "token", remediation: "the token must not contain whitespace" });
  }
  if (raw.length > TOKEN_MAX_CHARS) {
    issues.push({ field: "token", remediation: `the token must be at most ${TOKEN_MAX_CHARS} characters` });
  }
  return issues.length > 0 ? { issues } : { token: raw, issues };
}
function expectedLoginIssues(raw) {
  if (raw === undefined) {
    return [];
  }
  if (typeof raw === "string" && raw !== "" && raw.length <= EXPECTED_LOGIN_MAX_CHARS) {
    return [];
  }
  return [
    {
      field: "expectedLogin",
      remediation: `send a non-empty string of at most ${EXPECTED_LOGIN_MAX_CHARS} characters, or omit the field`
    }
  ];
}
function parseCredentialBody(raw, canAcceptExpectedLogin) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      ok: false,
      response: validationResponse([{ field: "body", remediation: "send a JSON object" }])
    };
  }
  const body = raw;
  const read = readToken2(body.token);
  const issues = [...read.issues, ...canAcceptExpectedLogin ? expectedLoginIssues(body.expectedLogin) : []];
  if (issues.length > 0 || read.token === undefined) {
    return { ok: false, response: validationResponse(issues) };
  }
  return {
    ok: true,
    credential: {
      token: read.token,
      expectedLogin: canAcceptExpectedLogin && typeof body.expectedLogin === "string" ? body.expectedLogin : null
    }
  };
}
function capabilityLabel(reason) {
  const capability = reason.slice(SCOPE_MISSING_PREFIX.length);
  switch (capability) {
    case "metadata": {
      return "Metadata";
    }
    case "issues": {
      return "Issues";
    }
    case "pull-requests": {
      return "Pull requests";
    }
    default: {
      return "Contents";
    }
  }
}
function reasonCopy(reason) {
  if (reason === "auth-failed") {
    return "GitHub rejected this token — create a fresh PAT and paste it again";
  }
  if (reason === "sso-required") {
    return "Your organization requires SSO — authorize the token for this org, then paste it again";
  }
  return `This token is missing the ${capabilityLabel(reason)} scope — update the token, then paste it again`;
}
function credentialRejectedResponse(reason, correlationId) {
  return errorResponse(STATUS.validation, {
    code: "credential-rejected",
    message: reasonCopy(reason),
    correlationId,
    reasonClass: reason
  });
}
function upstreamUnavailableResponse(detail, correlationId) {
  const messages = {
    offline: "GitHub could not be reached — check the network, then paste the token again",
    timeout: "GitHub did not answer in time — wait a moment, then paste the token again",
    upstream: "GitHub returned an unexpected response — wait a moment, then paste the token again"
  };
  return errorResponse(STATUS.badGateway, {
    code: "upstream-unavailable",
    message: messages[detail],
    correlationId
  });
}
function githubRateLimitedResponse(retryAfterSeconds) {
  return throttleResponse({
    status: STATUS.tooManyRequests,
    code: "rate-limited",
    message: "GitHub rate-limited this verification — wait the stated time, then paste the token again",
    retryAfterSeconds
  });
}
var VERIFY_BUSY_MESSAGE = "a verification is already running — wait a moment, then retry";
function throttleRefusal(code, retryAfterSeconds) {
  const message = code === "verify-busy" ? VERIFY_BUSY_MESSAGE : `verification attempts are limited — retry after ${retryAfterSeconds} seconds`;
  return throttleResponse({ status: STATUS.tooManyRequests, code, message, retryAfterSeconds });
}
function accountRejectedResponse(message, correlationId) {
  return errorResponse(STATUS.validation, {
    code: "account-rejected",
    message,
    correlationId
  });
}
function duplicateAccountResponse(correlationId) {
  return errorResponse(STATUS.conflict, {
    code: "duplicate-account",
    message: "an account with this GitHub id already exists — rotate its token instead",
    correlationId
  });
}
function guardCredentialRoute(handler) {
  return async (context, request) => {
    try {
      return await handler(context, request);
    } catch (error) {
      if (error instanceof StorageUnavailableError) {
        return storageUnavailableResponse();
      }
      const correlationId = newCorrelationId();
      context.log.error("credential route failed", {
        correlationId,
        errorKind: error instanceof Error ? error.name : typeof error
      });
      return errorResponse(STATUS.internal, {
        code: "internal",
        message: "unexpected service failure",
        correlationId
      });
    }
  };
}

// service/routes/accounts.ts
var ACCOUNTS_PATH = "/v1/accounts";
var ACCOUNT_TOKEN_PATH = `${ACCOUNTS_PATH}/:numericUserId/token`;
var ACCOUNT_PATH = `${ACCOUNTS_PATH}/:numericUserId`;
var FORCE_QUERY_FLAG = "force";
var FORCE_QUERY_VALUE = "1";
var ROTATION_ID_MISMATCH = "the new token belongs to a different GitHub account than this one";
var ROTATION_LOGIN_MISMATCH = "the new token belongs to a different GitHub login";
var REJECTED_EVENT = "account.rejected";
var REJECT_DECISION = "reject";
var ACCOUNT_KIND = "account";
function unknownAccountResponse() {
  return errorResponse(STATUS.notFound, {
    code: "unknown-account",
    message: "no account with this GitHub id is registered"
  });
}
function bindingsRefusalResponse(count) {
  return errorResponse(STATUS.conflict, {
    code: "invalid-transition",
    message: `${count} binding(s) still reference this account — remove them, or confirm a force delete`
  });
}
function pathAccountId(request) {
  const raw = request.params.numericUserId;
  return isNumericUserId(raw) ? raw : null;
}
async function handleListAccounts(context) {
  const { store } = context;
  if (store === null) {
    return storageUnavailableResponse();
  }
  const accounts = await listAccounts(store, context.log);
  return { status: STATUS.ok, body: { accounts: accounts.map((account) => toAccountDto(account)) } };
}
function rotatedAccount(input) {
  const { account, outcome, token } = input;
  const isRecovering = account.state !== "active";
  const verifiedAt = nowIso();
  return {
    ...account,
    login: outcome.identity.login,
    credential: { token, kind: outcome.credentialKind, verifiedAt },
    scopeCheck: outcome.scopeCheck,
    verifiedAt,
    ...isRecovering && { state: "active", connectionState: "connected", errorReason: null }
  };
}
async function recordRotationRejection(subject, reason) {
  await appendAudit(subject.store, {
    eventType: REJECTED_EVENT,
    actorSource: "service",
    entity: { kind: ACCOUNT_KIND, id: subject.account.numericUserId },
    decision: REJECT_DECISION,
    reason,
    correlationId: subject.correlationId,
    details: { reasonClass: reason, operation: "rotation" }
  });
}
async function rotationRefusal(subject, outcome) {
  if (outcome.kind === "rate-limited") {
    return githubRateLimitedResponse(outcome.retryAfterSeconds);
  }
  if (outcome.kind === "unavailable") {
    return upstreamUnavailableResponse(outcome.detail, subject.correlationId);
  }
  if (outcome.kind === "rejected") {
    await recordRotationRejection(subject, outcome.reason);
    return credentialRejectedResponse(outcome.reason, subject.correlationId);
  }
  if (outcome.identity.numericUserId !== subject.account.numericUserId) {
    await recordRotationRejection(subject, "rotation-id-mismatch");
    return accountRejectedResponse(ROTATION_ID_MISMATCH, subject.correlationId);
  }
  const expected = subject.account.expectedLogin;
  if (expected !== null && expected.toLowerCase() !== outcome.identity.login.toLowerCase()) {
    await recordRotationRejection(subject, "expected-login-mismatch");
    return accountRejectedResponse(ROTATION_LOGIN_MISMATCH, subject.correlationId);
  }
  return null;
}
async function recordRotation(input) {
  try {
    await appendAudit(input.store, {
      eventType: "account.rotated",
      actorSource: "operator",
      entity: { kind: ACCOUNT_KIND, id: input.account.numericUserId },
      decision: "accept",
      reason: "replacement token verified against GitHub /user",
      correlationId: input.correlationId,
      details: { login: input.account.login, scopeCheck: input.account.scopeCheck.results }
    });
  } catch (error) {
    input.log.warn("account rotated but the audit row could not be appended", {
      numericUserId: input.account.numericUserId,
      errorKind: error instanceof Error ? error.name : typeof error
    });
  }
}
async function persistRotation(input) {
  const rotated = rotatedAccount({ account: input.account, outcome: input.outcome, token: input.token });
  await writeAccount(input.store, rotated);
  await recordRotation({ store: input.store, log: input.log, account: rotated, correlationId: input.correlationId });
  return {
    status: STATUS.ok,
    body: { numericUserId: rotated.numericUserId, login: rotated.login, verifiedAt: rotated.verifiedAt }
  };
}
async function prepareRotation(input) {
  const parsed = parseCredentialBody(input.body, false);
  if (!parsed.ok) {
    return { ok: false, response: parsed.response };
  }
  const account = input.pathId === null ? null : await readAccount({ store: input.store, numericUserId: input.pathId, log: input.log });
  if (account === null) {
    return { ok: false, response: unknownAccountResponse() };
  }
  return { ok: true, account, credential: parsed.credential };
}
async function handleRotateToken(context, request) {
  const { store } = context;
  if (store === null) {
    return storageUnavailableResponse();
  }
  const prepared = await prepareRotation({
    store,
    log: context.log,
    pathId: pathAccountId(request),
    body: request.body
  });
  if (!prepared.ok) {
    return prepared.response;
  }
  const decision = context.throttle.attempt();
  if (!decision.allowed) {
    return throttleRefusal(decision.code, decision.retryAfterSeconds);
  }
  try {
    const outcome = await context.github.verify(prepared.credential.token);
    const subject = { store, account: prepared.account, correlationId: newCorrelationId() };
    const refusal = await rotationRefusal(subject, outcome);
    if (refusal !== null) {
      return refusal;
    }
    if (outcome.kind !== "ok") {
      return upstreamUnavailableResponse("upstream", subject.correlationId);
    }
    return await persistRotation({
      store,
      log: context.log,
      account: prepared.account,
      token: prepared.credential.token,
      outcome,
      correlationId: subject.correlationId
    });
  } finally {
    decision.lease.release();
  }
}
async function recordDisabledBindings(store, bindings) {
  for (const binding of bindings) {
    await appendAudit(store, {
      eventType: "binding.disabled",
      actorSource: "operator",
      entity: { kind: "binding", id: binding.bindingId },
      decision: "disable",
      reason: "account deleted with force=1",
      details: {}
    });
  }
}
async function recordAccountDeleted(store, numericUserId) {
  await appendAudit(store, {
    eventType: "account.deleted",
    actorSource: "operator",
    entity: { kind: ACCOUNT_KIND, id: numericUserId },
    decision: "remove",
    reason: "operator deleted the account",
    details: { credentialFile: accountPath(numericUserId) }
  });
}
async function handleDeleteAccount(context, request) {
  const { store } = context;
  if (store === null) {
    return storageUnavailableResponse();
  }
  const pathId = pathAccountId(request);
  const account = pathId === null ? null : await readAccount({ store, numericUserId: pathId, log: context.log });
  if (account === null || pathId === null) {
    return unknownAccountResponse();
  }
  const bindings = await bindingsReferencing(store, pathId);
  const isForced = request.url.searchParams.get(FORCE_QUERY_FLAG) === FORCE_QUERY_VALUE;
  if (!isForced && bindings.length > 0) {
    return bindingsRefusalResponse(bindings.length);
  }
  if (bindings.length > 0) {
    await recordDisabledBindings(store, await disableBindings(store, bindings));
  }
  await removeAccount(store, pathId);
  await recordAccountDeleted(store, pathId);
  return { status: STATUS.ok, body: { removed: true } };
}
var listAccountsRoute = {
  method: "GET",
  path: ACCOUNTS_PATH,
  handler: guardCredentialRoute(handleListAccounts)
};
var rotateTokenRoute = {
  method: "POST",
  path: ACCOUNT_TOKEN_PATH,
  handler: guardCredentialRoute(handleRotateToken)
};
var accountRemovalRoute = {
  method: "DELETE",
  path: ACCOUNT_PATH,
  handler: guardCredentialRoute(handleDeleteAccount)
};

// service/routes/account-profile.ts
var SAFE_FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
function profileBodyRefusal() {
  return {
    field: "body",
    remediation: "supply displayName, startingPrompt, or both — the body carries neither"
  };
}
function unexpectedProfileMemberIssue(key) {
  const shape = findSecretLeak(key);
  if (shape !== null) {
    return {
      field: "body",
      remediation: `the body must not carry credential-shaped member names (matched shape: ${shape})`
    };
  }
  const remediation = "the account profile body is a closed set — supply displayName, startingPrompt, or both";
  if (!SAFE_FIELD_NAME.test(key)) {
    return { field: "body", remediation };
  }
  return { field: truncatedFieldName(key), remediation };
}
function readProfileKey(input) {
  const { key, record, scratch } = input;
  if (key === "displayName") {
    scratch.carried.add(key);
    const verdict = validateDisplayName(record.displayName);
    if (verdict.ok) {
      scratch.displayName = { present: true, value: verdict.displayName };
    } else {
      scratch.issues.push(verdict.issue);
    }
    return;
  }
  if (key === "startingPrompt") {
    scratch.carried.add(key);
    const verdict = validateStartingPrompt(record.startingPrompt);
    if (verdict.ok) {
      scratch.startingPrompt = { present: true, value: verdict.prompt };
    } else {
      scratch.issues.push(verdict.issue);
    }
    return;
  }
  scratch.issues.push(unexpectedProfileMemberIssue(key));
}
function profileBodyOf(raw) {
  if (!isRecord(raw)) {
    return { ok: false, issues: [profileBodyRefusal()] };
  }
  const scratch = {
    issues: [],
    carried: new Set,
    displayName: { present: false },
    startingPrompt: { present: false }
  };
  for (const key of Object.keys(raw)) {
    readProfileKey({ key, record: raw, scratch });
  }
  if (scratch.carried.size === 0) {
    scratch.issues.push(profileBodyRefusal());
  }
  return scratch.issues.length > 0 ? { ok: false, issues: scratch.issues } : { ok: true, body: { displayName: scratch.displayName, startingPrompt: scratch.startingPrompt } };
}
async function runProfileWrite(input) {
  const { store, log, numericUserId } = input;
  return await runAccountPromptChain(store, async () => {
    const stored = await readAccountUnobserved({ store, numericUserId, log });
    if (stored === null) {
      return { kind: "missing" };
    }
    const parsed = profileBodyOf(input.body);
    if (!parsed.ok) {
      return { kind: "refused", issues: parsed.issues };
    }
    await recordAccountPromptChanges({ store, log, accounts: [stored], actor: "service" });
    const updated = {
      ...stored,
      ...parsed.body.displayName.present && { displayName: parsed.body.displayName.value },
      ...parsed.body.startingPrompt.present && { startingPrompt: parsed.body.startingPrompt.value },
      updatedAt: nowIso()
    };
    await writeAccount(store, updated);
    await recordAccountPromptChanges({ store, log, accounts: [updated], actor: "operator" });
    return { kind: "ok", account: updated };
  });
}
async function handleAccountProfile(context, request) {
  const { store } = context;
  if (store === null) {
    return storageUnavailableResponse();
  }
  const pathId = pathAccountId(request);
  if (pathId === null) {
    return unknownAccountResponse();
  }
  const outcome = await runProfileWrite({
    store,
    log: context.log,
    numericUserId: pathId,
    body: request.body
  });
  if (outcome.kind === "missing") {
    return unknownAccountResponse();
  }
  if (outcome.kind === "refused") {
    return validationResponse(outcome.issues);
  }
  return { status: STATUS.ok, body: { account: toAccountDto(outcome.account) } };
}
var putAccountProfileRoute = {
  method: "PUT",
  path: ACCOUNT_PATH,
  handler: guardCredentialRoute(handleAccountProfile)
};

// service/routes/audit.ts
var AUDIT_PATH = "/v1/audit";
var DEFAULT_AUDIT_LIMIT = 100;
var MAX_AUDIT_LIMIT = 200;
function auditLimitOf(raw) {
  if (raw === null || raw.trim() === "") {
    return DEFAULT_AUDIT_LIMIT;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_AUDIT_LIMIT;
  }
  return Math.min(Math.max(Math.trunc(parsed), 1), MAX_AUDIT_LIMIT);
}
function auditCursorOf(raw) {
  if (raw === null || raw.trim() === "") {
    return 0;
  }
  if (!/^[0-9]{1,15}$/.test(raw.trim())) {
    return null;
  }
  return Number(raw.trim());
}
function cursorIssue() {
  const issues = [{
    field: "cursor",
    remediation: "send the nextCursor this route returned, or omit it to start at the oldest row"
  }];
  return validationResponse(issues);
}
async function handleAuditRead(context, request) {
  const { store } = context;
  if (store === null) {
    return storageUnavailableResponse();
  }
  const cursor = auditCursorOf(request.url.searchParams.get("cursor"));
  if (cursor === null) {
    return cursorIssue();
  }
  const limit = auditLimitOf(request.url.searchParams.get("limit"));
  const correlationId = request.url.searchParams.get("correlationId");
  const entries = await readAuditEntries(store);
  const filtered = correlationId === null ? entries : entries.filter((entry) => entry.correlationId === correlationId);
  const ahead = filtered.filter((entry) => entry.seq > cursor);
  const page = ahead.slice(0, limit);
  const last = page.at(-1);
  return {
    status: STATUS.ok,
    body: {
      entries: page,
      nextCursor: last !== undefined && ahead.length > page.length ? last.seq : null,
      count: page.length
    }
  };
}
var auditRoute = {
  method: "GET",
  path: AUDIT_PATH,
  handler: (context, request) => handleAuditRead(context, request)
};

// service/config-schema.ts
var NEXT_CYCLE = "next-cycle";
var TAKE_EFFECT = {
  intervalMs: NEXT_CYCLE,
  overlapMs: NEXT_CYCLE,
  perPage: NEXT_CYCLE,
  retryMaxAttempts: NEXT_CYCLE,
  retryBaseMs: NEXT_CYCLE,
  retryMaxMs: NEXT_CYCLE,
  auditRetentionDays: NEXT_CYCLE,
  auditMaxEntries: NEXT_CYCLE,
  excerptRetentionDays: NEXT_CYCLE,
  leaseMs: NEXT_CYCLE,
  resultDeadlineMs: NEXT_CYCLE,
  logLevel: "immediate",
  expectedAgent: "next-dispatch",
  startingPrompt: NEXT_CYCLE
};
var STARTING_PROMPT_FORMAT = "text sent to the agent verbatim, with no placeholders; " + `at most ${STARTING_PROMPT_MAX_CODE_POINTS} code points after trimming; ` + "credential-shaped, reserved-marker, and control characters refused rather than stored; " + "empty means the global prompt tier is unset; the session still runs the pinned Default Agent, " + "which this text cannot change";
function configSchema() {
  const numericFields = Object.keys(NUMERIC_BOUNDS);
  const descriptors = [
    {
      name: "startingPrompt",
      kind: "string",
      unit: null,
      format: STARTING_PROMPT_FORMAT,
      maxLength: STARTING_PROMPT_MAX_CODE_POINTS,
      default: DEFAULT_CONFIG.startingPrompt,
      takesEffect: TAKE_EFFECT.startingPrompt,
      multiline: true
    }
  ];
  for (const field of numericFields) {
    descriptors.push({
      name: field,
      kind: "integer",
      unit: NUMERIC_BOUNDS[field].unit,
      min: NUMERIC_BOUNDS[field].min,
      max: NUMERIC_BOUNDS[field].max,
      default: DEFAULT_CONFIG[field],
      takesEffect: TAKE_EFFECT[field]
    });
  }
  descriptors.push({
    name: "logLevel",
    kind: "enum",
    unit: null,
    values: LOG_LEVEL_VALUES,
    default: DEFAULT_CONFIG.logLevel,
    takesEffect: TAKE_EFFECT.logLevel
  }, {
    name: "expectedAgent",
    kind: "string",
    unit: null,
    format: EXPECTED_AGENT_RULE.format,
    maxLength: EXPECTED_AGENT_RULE.maxLength,
    default: DEFAULT_CONFIG.expectedAgent,
    takesEffect: TAKE_EFFECT.expectedAgent
  });
  return descriptors;
}

// service/config-audit.ts
var CONFIG_CHANGED_EVENT = "config.changed";
var WITHHELD = "<withheld>";
var APPLIED_REASON = "configuration replaced";
var REFUSED_REASON = "configuration refused";
function configPromptFingerprint(text) {
  const tier = promptTierOf({ startingPrompt: text ?? null });
  return tier === null ? null : tier.fingerprint;
}
var PROMPT_FINGERPRINT_PATTERN2 = /^mtp-[0-9a-f]{32}$/;
function recordedConfigPromptFingerprint(value) {
  return typeof value === "string" && PROMPT_FINGERPRINT_PATTERN2.test(value) ? value : null;
}
function recordedValue(field, value) {
  if (field !== "startingPrompt") {
    return value;
  }
  return configPromptFingerprint(typeof value === "string" ? value : null);
}
function configChanges(previous, next) {
  const fields = Object.keys(DEFAULT_CONFIG).filter((field) => previous[field] !== next[field]).toSorted((left, right) => left.localeCompare(right));
  return fields.map((field) => ({
    field,
    from: recordedValue(field, previous[field]),
    to: recordedValue(field, next[field])
  }));
}
function takeEffectOf(changes) {
  const takesEffect = {};
  for (const change of changes) {
    takesEffect[change.field] = TAKE_EFFECT[change.field];
  }
  return takesEffect;
}
function refusedFields(issues) {
  const documented = new Set(Object.keys(DEFAULT_CONFIG));
  const fields = [];
  for (const issue of issues) {
    const name = documented.has(issue.field) ? issue.field : WITHHELD;
    if (!fields.includes(name)) {
      fields.push(name);
    }
  }
  return fields;
}
async function appendConfigApplied(input) {
  try {
    await appendAudit(input.store, {
      eventType: CONFIG_CHANGED_EVENT,
      actorSource: input.actor ?? "operator",
      entity: { kind: "service", id: CONFIGURATION_ENTITY_ID },
      decision: "applied",
      reason: APPLIED_REASON,
      details: {
        changes: input.changes.map((change) => ({
          field: change.field,
          from: change.from,
          to: change.to
        })),
        takesEffect: takeEffectOf(input.changes)
      }
    });
    return true;
  } catch (cause) {
    input.log.warn("configuration change could not be recorded", {
      errorKind: cause instanceof Error ? cause.name : typeof cause,
      changes: input.changes.length
    });
    return false;
  }
}
async function appendConfigRefused(input) {
  if (input.store === null) {
    input.log.warn("configuration refusal could not be recorded", {
      errorKind: "storage-unavailable",
      issueCount: input.issues.length
    });
    return false;
  }
  try {
    await appendAudit(input.store, {
      eventType: CONFIG_CHANGED_EVENT,
      actorSource: "operator",
      entity: { kind: "service", id: CONFIGURATION_ENTITY_ID },
      decision: "refused",
      reason: REFUSED_REASON,
      details: {
        issueCount: input.issues.length,
        fields: refusedFields(input.issues)
      }
    });
    return true;
  } catch (cause) {
    input.log.warn("configuration refusal could not be recorded", {
      errorKind: cause instanceof Error ? cause.name : typeof cause,
      issueCount: input.issues.length
    });
    return false;
  }
}

// service/config-prompt-observe.ts
var observationStates2 = new WeakMap;
function stateFor2(store) {
  let state = observationStates2.get(store);
  if (state === undefined) {
    state = { baseline: null, seeded: false, chain: Promise.resolve() };
    observationStates2.set(store, state);
  }
  return state;
}
function startingPromptChangeOf(details) {
  const { changes } = details;
  if (!Array.isArray(changes)) {
    return null;
  }
  for (const change of changes) {
    if (isRecord(change) && change.field === "startingPrompt") {
      return { to: change.to };
    }
  }
  return null;
}
function baselineFromTrail(entries) {
  let highestSeq = 0;
  let baseline = null;
  for (const entry of entries) {
    if (entry.eventType !== CONFIG_CHANGED_EVENT || entry.seq <= highestSeq) {
      continue;
    }
    const change = startingPromptChangeOf(entry.details);
    if (change === null) {
      continue;
    }
    highestSeq = entry.seq;
    baseline = recordedConfigPromptFingerprint(change.to);
  }
  return baseline;
}
async function ensureSeeded(input) {
  if (input.state.seeded) {
    return true;
  }
  try {
    const trail = await input.store.readLines(AUDIT_FILE, parseAuditEntry);
    input.state.baseline = baselineFromTrail(trail.entries);
    input.state.seeded = true;
    return true;
  } catch (cause) {
    input.log.warn("configuration prompt baseline could not be established", {
      errorKind: cause instanceof Error ? cause.name : typeof cause
    });
    return false;
  }
}
async function runConfigPromptChain(store, task) {
  const state = stateFor2(store);
  const run = state.chain.then(task, task);
  state.chain = run;
  return await run;
}
async function recordConfigPromptChanges(input) {
  const state = stateFor2(input.store);
  if (!await ensureSeeded({ store: input.store, state, log: input.log })) {
    return 0;
  }
  const current = configPromptFingerprint(input.config.startingPrompt);
  const previous = state.baseline;
  state.baseline = current;
  if (previous === current) {
    return 0;
  }
  const isWritten = await appendConfigApplied({
    store: input.store,
    log: input.log,
    actor: input.actor,
    changes: [{ field: "startingPrompt", from: previous, to: current }]
  });
  return isWritten ? 1 : 0;
}
async function advanceConfigPromptBaseline(input) {
  const state = stateFor2(input.store);
  if (!await ensureSeeded({ store: input.store, state, log: input.log })) {
    return;
  }
  state.baseline = configPromptFingerprint(input.config.startingPrompt);
}

// service/routes/config.ts
var CONFIG_PATH = "/v1/config";
async function handleGetConfig(context) {
  if (context.store === null) {
    return storageUnavailableResponse();
  }
  const read = await readStoredConfig({ store: context.store, log: context.log });
  return {
    status: STATUS.ok,
    body: {
      config: read.config,
      fields: configSchema(),
      source: read.source,
      defaultsApplied: read.defaultsApplied
    }
  };
}
async function runConfigWrite(input) {
  const { store, log, candidate } = input;
  return await runConfigPromptChain(store, async () => {
    const previous = configFromStore(await store.readJson(CONFIG_FILE, parseStoredConfig), log);
    await recordConfigPromptChanges({ store, log, config: previous.config, actor: "service" });
    const changes = configChanges(previous.config, candidate);
    await store.writeJson(CONFIG_FILE, candidate);
    log.setLevel(candidate.logLevel);
    const wasAppended = changes.length === 0 || await appendConfigApplied({ store, log, changes });
    await advanceConfigPromptBaseline({ store, log, config: candidate });
    return wasAppended;
  });
}
async function handlePutConfig(context, request) {
  const validation = validateConfig(request.body);
  if (!validation.ok) {
    await appendConfigRefused({ store: context.store, log: context.log, issues: validation.issues });
    return validationResponse(validation.issues);
  }
  if (context.store === null) {
    return storageUnavailableResponse();
  }
  const wasAppended = await runConfigWrite({
    store: context.store,
    log: context.log,
    candidate: validation.config
  });
  return { status: STATUS.ok, body: { config: validation.config, auditWritten: wasAppended } };
}
var configRoute = {
  method: "GET",
  path: CONFIG_PATH,
  handler: (context) => handleGetConfig(context)
};
var putConfigRoute = {
  method: "PUT",
  path: CONFIG_PATH,
  handler: (context, request) => handlePutConfig(context, request)
};

// service/bindings-history-scope.ts
var DEFAULT_HISTORY_SCOPE = "new-only";
var HISTORY_SCOPES = ["new-only", "recent-history"];
var LOOK_BACK_MS = 604800000;
var LOOK_BACK_BOUNDS = {
  min: 3600000,
  max: 2592000000,
  unit: "milliseconds"
};
var FIELD = "historyScope";
var NOT_A_SCOPE_REMEDIATION = "historyScope must be `new-only` (watch from this binding's own creation " + "onward) or `recent-history` (also look back over the last seven days, once), or null to clear it " + 'to `new-only`; there is no "all history" option';
function isHistoryScope(value) {
  return value === "new-only" || value === "recent-history";
}
function lookBackWithinBounds(candidate) {
  return Number.isFinite(candidate) && candidate >= LOOK_BACK_BOUNDS.min && candidate <= LOOK_BACK_BOUNDS.max;
}
function lookBackMs() {
  return lookBackWithinBounds(LOOK_BACK_MS) ? LOOK_BACK_MS : null;
}
function historyScopeOf(raw) {
  const value = raw.historyScope;
  if (value === undefined || value === null) {
    return { scope: null };
  }
  return isHistoryScope(value) ? { scope: value } : { issue: { field: FIELD, remediation: NOT_A_SCOPE_REMEDIATION } };
}
function effectiveHistoryScope(historyScope) {
  return historyScope ?? DEFAULT_HISTORY_SCOPE;
}

// src/config.ts
var REPOSITORY_PART_PATTERN = /^[A-Za-z0-9_.-]+$/;
var BRANCH_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
var PARENT_PATH_REFERENCE = "..";
var PROJECT_ID_PATTERN = /^[\x20-\x7E]+$/;
var PROJECT_ID_MAX = 128;
function parseRepository(value) {
  const parts = value.trim().split("/");
  if (parts.length !== 2) {
    return null;
  }
  const owner = parts[0];
  const name = parts[1];
  if (owner === undefined || name === undefined || owner === "" || name === "" || !REPOSITORY_PART_PATTERN.test(owner) || !REPOSITORY_PART_PATTERN.test(name)) {
    return null;
  }
  return { owner, name };
}
function parseWorktreeOption(value) {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "none") {
    return { kind: "none" };
  }
  if (trimmed === "generated") {
    return { kind: "generated" };
  }
  if (!trimmed.startsWith("new:")) {
    return null;
  }
  const name = trimmed.slice("new:".length).trim();
  if (name === "" || name.includes(PARENT_PATH_REFERENCE) || !BRANCH_NAME_PATTERN.test(name)) {
    return null;
  }
  return { kind: "new", name };
}
function parseProjectId(raw) {
  if (raw === null) {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.length > PROJECT_ID_MAX || !PROJECT_ID_PATTERN.test(trimmed)) {
    return null;
  }
  return trimmed;
}
function repositoryLabel(repository) {
  return `${repository.owner}/${repository.name}`;
}
function repositoryRefOf(repository) {
  const index = repository.indexOf("/");
  if (index === -1) {
    return { owner: repository, name: "" };
  }
  return { owner: repository.slice(0, index), name: repository.slice(index + 1) };
}

// service/bindings-allow-list.ts
var GITHUB_LOGIN_MAX_CHARS = 39;
var SINGLE_LOGIN = /^[A-Za-z0-9]$/;
var LOGIN_SHAPE = /^[A-Za-z0-9][A-Za-z0-9-]*[A-Za-z0-9]$/;
var BOT_SUFFIX = "[bot]";
function isGitHubLogin(value) {
  if (typeof value !== "string") {
    return false;
  }
  const isBot = value.toLowerCase().endsWith(BOT_SUFFIX);
  const spelled = isBot ? value.slice(0, -BOT_SUFFIX.length) : value;
  if (spelled.length === 0 || spelled.length > GITHUB_LOGIN_MAX_CHARS) {
    return false;
  }
  return spelled.length === 1 ? SINGLE_LOGIN.test(spelled) : LOGIN_SHAPE.test(spelled) && !spelled.includes("--");
}
var FIELD2 = "allowedUsers";
var NOT_AN_ARRAY_REMEDIATION = "allowedUsers must be an array of GitHub logins, or omitted so any human " + "actor may trigger this repository";
var EMPTY_REMEDIATION = "allowedUsers must name at least one GitHub login: omit the field to let any human " + "actor may trigger this repository, or list the logins who may; to stop every trigger, disable the binding";
var NOT_A_LOGIN_REMEDIATION = "allowedUsers must name GitHub logins: at most 39 characters, " + "alphanumeric with single interior hyphens";
function refuse2(remediation) {
  return { issue: { field: FIELD2, remediation } };
}
function bindingAllowedUsersOf(raw) {
  const value = raw.allowedUsers;
  if (value === undefined) {
    return { users: null };
  }
  if (!Array.isArray(value)) {
    return refuse2(NOT_AN_ARRAY_REMEDIATION);
  }
  if (value.length === 0) {
    return refuse2(EMPTY_REMEDIATION);
  }
  const users = [];
  for (const entry of value) {
    if (!isGitHubLogin(entry)) {
      return refuse2(NOT_A_LOGIN_REMEDIATION);
    }
    users.push(entry);
  }
  return { users };
}
function isActorAllowed(login, allowedUsers) {
  if (login === "") {
    return false;
  }
  if (allowedUsers === undefined) {
    return true;
  }
  const wanted = login.toLowerCase();
  return allowedUsers.some((candidate) => candidate.toLowerCase() === wanted);
}

// service/bindings.ts
var MAX_BINDINGS = 100;
var MAX_BINDING_ID_CHARS = 128;
var MAX_REPOSITORY_CHARS = 200;
var NUMERIC_ID_PATTERN = /^\d+$/;
function stringFieldOf(value) {
  return typeof value === "string" && value !== "" ? value : null;
}
function issue(value) {
  return { issue: value };
}
function triggersFieldOf(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value;
  const { assignment, mention, reviewRequest } = record;
  if (typeof assignment !== "boolean" || typeof mention !== "boolean") {
    return null;
  }
  if (reviewRequest !== undefined && typeof reviewRequest !== "boolean") {
    return null;
  }
  return { assignment, mention, reviewRequest: reviewRequest === true };
}
function stateFieldOf(value) {
  if (value === undefined) {
    return "active";
  }
  if (value === "active" || value === "disabled") {
    return value;
  }
  return null;
}
function stampOrKeep(value, fallback) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : fallback;
}
function storedStampOf(value) {
  if (value === undefined) {
    return null;
  }
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : undefined;
}
function repositoryFieldOf(value) {
  if (typeof value !== "string" || value.length > MAX_REPOSITORY_CHARS) {
    return null;
  }
  const parsed = parseRepository(value);
  return parsed === null ? null : `${parsed.owner}/${parsed.name}`;
}
function worktreeFieldOf(value) {
  const parsed = parseWorktreeOption(typeof value === "string" ? value : "");
  if (parsed === null) {
    return null;
  }
  if (parsed.kind === "new") {
    return `new:${parsed.name}`;
  }
  return parsed.kind;
}
function bindingIdentityOf(raw, hasAccount) {
  const bindingId = stringFieldOf(raw.bindingId);
  if (bindingId === null || bindingId.length > MAX_BINDING_ID_CHARS) {
    return issue({
      field: "bindingId",
      remediation: `bindingId must be a unique string of at most ${MAX_BINDING_ID_CHARS} characters`
    });
  }
  const accountId = raw.accountNumericUserId;
  if (typeof accountId !== "string" || !NUMERIC_ID_PATTERN.test(accountId)) {
    return issue({
      field: "accountNumericUserId",
      remediation: "accountNumericUserId must be the GitHub numeric user id of a registered account"
    });
  }
  if (!hasAccount) {
    return issue({
      field: "accountNumericUserId",
      remediation: "register the account before binding it"
    });
  }
  const login = stringFieldOf(raw.accountLogin);
  if (login === null || login.trim() === "") {
    return issue({
      field: "accountLogin",
      remediation: "accountLogin must be the login shown for this account"
    });
  }
  return { binding: { bindingId, accountNumericUserId: accountId, accountLogin: login } };
}
function bindingTargetOf(raw) {
  const repository = repositoryFieldOf(raw.repository);
  if (repository === null) {
    return issue({
      field: "repository",
      remediation: "repository must be an existing GitHub repository written as `owner/name`"
    });
  }
  const projectId = parseProjectId(stringFieldOf(raw.projectId));
  if (projectId === null) {
    return issue({
      field: "projectId",
      remediation: "projectId must be an existing OpenChamber project id (from the panel picker)"
    });
  }
  const worktreeOption = worktreeFieldOf(raw.worktreeOption);
  if (worktreeOption === null) {
    return issue({
      field: "worktreeOption",
      remediation: "worktreeOption must be `none`, `generated`, or `new:<branch-name>`"
    });
  }
  return { binding: { repository, projectId, worktreeOption } };
}
function bindingModeOf(raw) {
  const triggers = triggersFieldOf(raw.triggers);
  if (triggers === null) {
    return issue({
      field: "triggers",
      remediation: "triggers must be an object with assignment, mention, and reviewRequest boolean flags"
    });
  }
  const state = stateFieldOf(raw.state);
  if (state === null) {
    return issue({
      field: "state",
      remediation: "state must be `active` or `disabled`"
    });
  }
  return { binding: { triggers, state } };
}
function bindingPromptOf(raw) {
  const verdict = validateStartingPrompt(raw.startingPrompt);
  return verdict.ok ? { prompt: verdict.prompt } : { issue: verdict.issue };
}
function assembleBinding(raw, hasAccount) {
  const identity = bindingIdentityOf(raw, hasAccount);
  if ("issue" in identity) {
    return null;
  }
  const target = bindingTargetOf(raw);
  if ("issue" in target) {
    return null;
  }
  const mode = bindingModeOf(raw);
  if ("issue" in mode) {
    return null;
  }
  const prompt = bindingPromptOf(raw);
  if ("issue" in prompt) {
    return null;
  }
  const allowedUsers = bindingAllowedUsersOf(raw);
  if ("issue" in allowedUsers) {
    return null;
  }
  const historyScope = historyScopeOf(raw);
  if ("issue" in historyScope) {
    return null;
  }
  const login = identity.binding.accountLogin.trim();
  const createdAt = stampOrKeep(raw.createdAt, nowIso());
  return {
    ...identity.binding,
    accountLogin: login,
    ...target.binding,
    ...mode.binding,
    ...prompt.prompt !== null && { startingPrompt: prompt.prompt },
    ...allowedUsers.users !== null && { allowedUsers: allowedUsers.users },
    ...historyScope.scope !== null && { historyScope: historyScope.scope },
    createdAt,
    updatedAt: stampOrKeep(raw.updatedAt, createdAt)
  };
}
function refusalsIn(verdicts) {
  return verdicts.flatMap((verdict) => ("issue" in verdict) ? [verdict.issue] : []);
}
function parseBinding(input) {
  const { raw, hasAccount } = input;
  const record = assembleBinding(raw, hasAccount);
  if (record !== null) {
    return { binding: record };
  }
  return {
    issues: refusalsIn([
      bindingIdentityOf(raw, hasAccount),
      bindingTargetOf(raw),
      bindingModeOf(raw),
      bindingPromptOf(raw),
      bindingAllowedUsersOf(raw),
      historyScopeOf(raw)
    ])
  };
}
function collectBindingIssues(candidates, hasAccount) {
  const issues = [];
  const seen = new Set;
  const bindings = [];
  for (const candidate of candidates) {
    const record = isRecord(candidate) ? candidate : null;
    if (record === null) {
      issues.push({ field: "bindings[]", remediation: "each binding must be a JSON object" });
      continue;
    }
    const isKnown = typeof record.accountNumericUserId === "string" && hasAccount(record.accountNumericUserId);
    const verdict = parseBinding({ raw: record, hasAccount: isKnown });
    if ("issues" in verdict) {
      issues.push(...verdict.issues);
      continue;
    }
    if (seen.has(verdict.binding.bindingId)) {
      issues.push({ field: "bindingId", remediation: "each binding must carry a unique bindingId" });
      continue;
    }
    seen.add(verdict.binding.bindingId);
    bindings.push(verdict.binding);
  }
  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return { ok: true, bindings };
}
function validateBindings(input) {
  const bodyCopy = "send `{ bindings: [...] }` holding every binding the panel keeps";
  const body = isRecord(input.raw) ? input.raw : null;
  if (body === null || !Array.isArray(body.bindings)) {
    return {
      ok: false,
      issues: [{ field: "body", remediation: bodyCopy }]
    };
  }
  const capCopy = `keep the list to ${MAX_BINDINGS} bindings`;
  if (body.bindings.length > MAX_BINDINGS) {
    return {
      ok: false,
      issues: [{ field: "bindings", remediation: capCopy }]
    };
  }
  return collectBindingIssues(body.bindings, input.hasAccount);
}
async function writeBindings(input) {
  await input.store.writeJson(BINDINGS_FILE, input.bindings);
}

// service/history-scope-audit.ts
var HISTORY_SCOPE_UPDATED_EVENT = "binding.history-scope-updated";
var observationStates3 = new WeakMap;
function stateFor3(store) {
  let state = observationStates3.get(store);
  if (state === undefined) {
    state = { baseline: new Map, seeded: false, chain: Promise.resolve() };
    observationStates3.set(store, state);
  }
  return state;
}
function recordedScopeOf(recorded) {
  return HISTORY_SCOPES.find((scope) => scope === recorded) ?? null;
}
async function seedBaseline2(store, baseline) {
  const trail = await store.readLines(AUDIT_FILE, parseAuditEntry);
  const highest = new Map;
  for (const entry of trail.entries) {
    if (entry.eventType !== HISTORY_SCOPE_UPDATED_EVENT) {
      continue;
    }
    const { bindingId } = entry.details;
    if (typeof bindingId !== "string") {
      continue;
    }
    const scope = recordedScopeOf(entry.details.to) ?? effectiveHistoryScope();
    const prior = highest.get(bindingId);
    if (prior === undefined || entry.seq > prior.seq) {
      highest.set(bindingId, { seq: entry.seq, scope });
    }
  }
  for (const [bindingId, value] of highest) {
    baseline.set(bindingId, value.scope);
  }
}
async function runHistoryScopeChain(store, task) {
  const state = stateFor3(store);
  const start = async () => {
    if (!state.seeded) {
      await seedBaseline2(store, state.baseline);
      state.seeded = true;
    }
    return await task();
  };
  const run = state.chain.then(start, start);
  state.chain = run;
  return await run;
}
function decisionFor(input) {
  if (input.from === input.to) {
    return "changed";
  }
  const fallback = effectiveHistoryScope();
  if (input.from === fallback) {
    return "set";
  }
  return input.to === fallback ? "cleared" : "changed";
}
async function appendHistoryScopeChange(input) {
  const decision = decisionFor({ from: input.from, to: input.to });
  await appendAudit(input.store, {
    eventType: HISTORY_SCOPE_UPDATED_EVENT,
    actorSource: input.actor,
    entity: { kind: "binding", id: input.bindingId },
    correlationId: newCorrelationId(),
    decision,
    reason: null,
    details: { bindingId: input.bindingId, from: input.from, to: input.to, actor: input.actor }
  });
}
function dropUnobserved(state, observed) {
  for (const bindingId of state.baseline.keys()) {
    if (!observed.has(bindingId)) {
      state.baseline.delete(bindingId);
    }
  }
}
async function recordOneChange2(context) {
  const { input, binding, to, from } = context;
  try {
    await appendHistoryScopeChange({
      store: input.store,
      bindingId: binding.bindingId,
      from,
      to,
      actor: input.actor
    });
    return 1;
  } catch (cause) {
    input.log.warn("history-scope change audit row could not be appended", {
      bindingId: binding.bindingId,
      from,
      to,
      errorKind: cause instanceof Error ? cause.name : typeof cause
    });
    return 0;
  }
}
async function recordHistoryScopeChanges(input) {
  const state = stateFor3(input.store);
  const observed = new Set;
  let rows = 0;
  for (const binding of input.bindings) {
    observed.add(binding.bindingId);
    const to = effectiveHistoryScope(binding.historyScope);
    const from = state.baseline.get(binding.bindingId) ?? effectiveHistoryScope();
    state.baseline.set(binding.bindingId, to);
    if (from === to) {
      continue;
    }
    rows += await recordOneChange2({ input, binding, to, from });
  }
  dropUnobserved(state, observed);
  return rows;
}
async function observeHistoryScopeChanges(input) {
  return await runHistoryScopeChain(input.store, async () => await recordHistoryScopeChanges(input));
}

// service/prompt-audit.ts
var PROMPT_UPDATED_EVENT = "binding.prompt-updated";
var observationStates4 = new WeakMap;
function stateFor4(store) {
  let state = observationStates4.get(store);
  if (state === undefined) {
    state = { baseline: new Map, seeded: false, chain: Promise.resolve() };
    observationStates4.set(store, state);
  }
  return state;
}
async function seedBaseline3(store, baseline) {
  const trail = await store.readLines(AUDIT_FILE, parseAuditEntry);
  const highest = new Map;
  for (const entry of trail.entries) {
    if (entry.eventType !== PROMPT_UPDATED_EVENT) {
      continue;
    }
    const { bindingId } = entry.details;
    if (typeof bindingId !== "string") {
      continue;
    }
    const recorded = entry.details.promptFingerprint;
    const fingerprint = typeof recorded === "string" && entry.details.promptPresent === true && PROMPT_FINGERPRINT_PATTERN.test(recorded) ? recorded : null;
    const prior = highest.get(bindingId);
    if (prior === undefined || entry.seq > prior.seq) {
      highest.set(bindingId, { seq: entry.seq, fingerprint });
    }
  }
  for (const [bindingId, value] of highest) {
    baseline.set(bindingId, value.fingerprint);
  }
}
async function runPromptChain(store, task) {
  const state = stateFor4(store);
  const start = async () => {
    if (!state.seeded) {
      await seedBaseline3(store, state.baseline);
      state.seeded = true;
    }
    return await task();
  };
  const run = state.chain.then(start, start);
  state.chain = run;
  return await run;
}
async function appendPromptChange(input) {
  const isPresent = input.current !== null;
  let decision;
  if (input.current === null) {
    decision = "cleared";
  } else {
    decision = input.previousFingerprint === null ? "set" : "changed";
  }
  await appendAudit(input.store, {
    eventType: PROMPT_UPDATED_EVENT,
    actorSource: input.actor,
    entity: { kind: "binding", id: input.bindingId },
    correlationId: newCorrelationId(),
    decision,
    reason: null,
    details: {
      bindingId: input.bindingId,
      promptPresent: isPresent,
      promptFingerprint: input.current?.fingerprint ?? null,
      promptLength: input.current?.length ?? 0,
      previousFingerprint: input.previousFingerprint
    }
  });
}
function dropUnobserved2(state, observed) {
  for (const bindingId of state.baseline.keys()) {
    if (!observed.has(bindingId)) {
      state.baseline.delete(bindingId);
    }
  }
}
async function recordOneChange3(context) {
  const { input, binding, snapshot, current, previous } = context;
  try {
    await appendPromptChange({
      store: input.store,
      bindingId: binding.bindingId,
      current: snapshot,
      previousFingerprint: previous,
      actor: input.actor
    });
    return 1;
  } catch (cause) {
    input.log.warn("prompt change audit row could not be appended", {
      bindingId: binding.bindingId,
      promptFingerprint: current,
      errorKind: cause instanceof Error ? cause.name : typeof cause
    });
    return 0;
  }
}
async function recordPromptChanges(input) {
  const state = stateFor4(input.store);
  const observed = new Set;
  let rows = 0;
  for (const binding of input.bindings) {
    observed.add(binding.bindingId);
    const snapshot = promptTierOf(binding);
    const current = snapshot === null ? null : snapshot.fingerprint;
    const previous = state.baseline.get(binding.bindingId) ?? null;
    state.baseline.set(binding.bindingId, current);
    if (previous === current) {
      continue;
    }
    rows += await recordOneChange3({ input, binding, snapshot, current, previous });
  }
  dropUnobserved2(state, observed);
  return rows;
}
async function observePromptChanges(input) {
  return await runPromptChain(input.store, async () => await recordPromptChanges(input));
}

// service/bindings-read.ts
var BINDINGS_UNUSABLE = "stored bindings were unusable and have been set aside";
var BINDINGS_READ_FAILED = "bindings read failed";
function noteFirstRefusal(note, issues) {
  const first = issues[0];
  if (first !== undefined && note.reason === null) {
    note.reason = `${first.field}: ${first.remediation}`;
  }
}
function parseBindingsFile(raw, note) {
  if (!Array.isArray(raw) || raw.some((entry) => !isRecord(entry))) {
    return null;
  }
  const bindings = [];
  for (const entry of raw) {
    const verdict = parseBinding({ raw: entry, hasAccount: true });
    if ("issues" in verdict) {
      noteFirstRefusal(note, verdict.issues);
      return null;
    }
    bindings.push(verdict.binding);
  }
  return bindings;
}
async function readBindingsUnobserved(input) {
  const { store, log } = input;
  const note = { reason: null };
  try {
    const result = await store.readJson(BINDINGS_FILE, (raw) => parseBindingsFile(raw, note));
    if (result.status === "ok") {
      return result.value;
    }
    if (result.status === "quarantined") {
      log.warn(BINDINGS_UNUSABLE, {
        quarantinePath: result.quarantinePath,
        ...note.reason !== null && { reason: note.reason }
      });
    }
    return [];
  } catch (cause) {
    log.warn(BINDINGS_READ_FAILED, { errorKind: cause instanceof Error ? cause.name : typeof cause });
    return [];
  }
}
async function readBindings(input) {
  const bindings = await readBindingsUnobserved(input);
  await observePromptChanges({
    store: input.store,
    log: input.log,
    bindings,
    actor: "service"
  });
  await observeHistoryScopeChanges({
    store: input.store,
    log: input.log,
    bindings,
    actor: "service"
  });
  return bindings;
}
async function readBindingsForAuthorization(input) {
  const { store, log } = input;
  const note = { reason: null };
  try {
    const result = await store.readJson(BINDINGS_FILE, (raw) => parseBindingsFile(raw, note));
    if (result.status === "ok") {
      return { readable: true, bindings: result.value };
    }
    if (result.status === "quarantined") {
      log.warn(BINDINGS_UNUSABLE, {
        quarantinePath: result.quarantinePath,
        ...note.reason !== null && { reason: note.reason }
      });
    }
    return { readable: false };
  } catch (cause) {
    log.warn(BINDINGS_READ_FAILED, { errorKind: cause instanceof Error ? cause.name : typeof cause });
    return { readable: false };
  }
}
var NOT_ESTABLISHED = { kind: "unreadable" };
function creationStampOf(entry) {
  const stored = storedStampOf(entry.createdAt);
  if (stored === null) {
    return { kind: "absent" };
  }
  return stored === undefined ? { kind: "unreadable" } : { kind: "stamp", at: stored };
}
async function readStoredCreationStamps(input) {
  const answers = new Map;
  if (input.bindingIds.length === 0) {
    return answers;
  }
  const fail = () => {
    for (const bindingId of input.bindingIds) {
      answers.set(bindingId, NOT_ESTABLISHED);
    }
    return answers;
  };
  try {
    const result = await input.store.readJson(BINDINGS_FILE, (raw) => {
      if (!Array.isArray(raw)) {
        return null;
      }
      const stamps = new Map;
      for (const entry of raw) {
        if (!isRecord(entry) || typeof entry.bindingId !== "string") {
          continue;
        }
        stamps.set(entry.bindingId, creationStampOf(entry));
      }
      return stamps;
    });
    if (result.status === "ok") {
      for (const bindingId of input.bindingIds) {
        answers.set(bindingId, result.value.get(bindingId) ?? NOT_ESTABLISHED);
      }
      return answers;
    }
    if (result.status === "quarantined") {
      input.log.warn(BINDINGS_UNUSABLE, {
        quarantinePath: result.quarantinePath
      });
    }
  } catch (cause) {
    input.log.warn(BINDINGS_READ_FAILED, {
      errorKind: cause instanceof Error ? cause.name : typeof cause
    });
  }
  return fail();
}

// service/poll/claim-bounds.ts
var MAX_CLAIMED_RUNS = 50;
var CLAIM_ANSWER_RESERVE_CHARS = 65536;
var CLAIM_EVENTS_BUDGET_CHARS = RESPONSE_BODY_MAX_CHARS - CLAIM_ANSWER_RESERVE_CHARS;
var RUN_EXCERPT_MAX_CHARS = 12000;
var REFERENCE_EXCERPT_MAX_CHARS = 600;
var EXCERPT_TRUNCATION_MARKER = "… [truncated]";
var EXCERPT_OMITTED_MARKER = "[excerpt omitted: the claim answer carried this reference without its text]";
function boundedExcerpt(excerpt) {
  if (excerpt.length <= REFERENCE_EXCERPT_MAX_CHARS) {
    return excerpt;
  }
  return `${excerpt.slice(0, REFERENCE_EXCERPT_MAX_CHARS)}${EXCERPT_TRUNCATION_MARKER}`;
}
function excerptCost(excerpt) {
  return excerpt === EXCERPT_OMITTED_MARKER ? 0 : excerpt.length;
}
function projectReferences(input) {
  let remaining = input.budget;
  return input.references.map((reference) => {
    const stored = input.deliveries.get(reference.deliveryId)?.issueBodyExcerpt ?? "";
    const bounded = boundedExcerpt(stored);
    const excerpt = remaining >= excerptCost(bounded) ? bounded : EXCERPT_OMITTED_MARKER;
    remaining -= excerptCost(excerpt);
    return {
      deliveryId: reference.deliveryId,
      kind: reference.kind,
      origin: reference.origin,
      sourceUrl: reference.sourceUrl,
      detectedAt: reference.detectedAt,
      excerpt,
      presentAtAuthorization: reference.presentAtAuthorization
    };
  });
}
function measureEvents(runs) {
  return JSON.stringify(runs).length;
}

// service/poll/claim.ts
import { createHash as createHash4 } from "node:crypto";

// service/poll/claim-project.ts
function reviewCoordinates(delivery) {
  const head = delivery?.headSha ?? null;
  const base = delivery?.baseRef ?? null;
  return { ...head !== null && { headSha: head }, ...base !== null && { baseRef: base } };
}
function deliveryView(input) {
  const { delivery, primary } = input;
  return {
    accountLogin: delivery?.accountLogin ?? "",
    issueTitle: delivery?.issueTitle ?? "",
    issueUrl: primary?.sourceUrl ?? "",
    issueBodyExcerpt: delivery?.issueBodyExcerpt ?? "",
    ...reviewCoordinates(delivery)
  };
}
function promptViewOf(run) {
  if (run.prompt === null) {
    return {
      promptPresent: false,
      promptFingerprint: null,
      promptLength: null,
      promptSources: null,
      promptText: null
    };
  }
  return {
    promptPresent: true,
    promptFingerprint: run.prompt.fingerprint,
    promptLength: run.prompt.length,
    promptSources: run.prompt.sources,
    promptText: run.prompt.text
  };
}
function projectClaimedRun(input) {
  const { run, lease, deliveries } = input;
  const primary = run.sourceReferences[0];
  const delivery = primary === undefined ? undefined : deliveries.get(primary.deliveryId);
  return {
    correlationId: run.correlationId,
    runKey: run.runKey,
    ordinal: run.ordinal,
    attempt: run.attempt,
    lease,
    state: "pending",
    stateReason: `waiting for a panel; leased until ${lease.expiresAt}`,
    bindingId: run.bindingId,
    repository: run.repository,
    projectId: run.projectId,
    worktreeOption: run.worktreeOption,
    subjectType: run.subjectType,
    issueNumber: run.subjectNumber,
    attachmentId: run.attachmentId,
    sourceReferences: projectReferences({
      references: run.sourceReferences,
      deliveries,
      budget: RUN_EXCERPT_MAX_CHARS
    }),
    referenceCount: run.referenceCount,
    referencesNotRetained: run.referencesNotRetained,
    referencesTruncated: run.referencesTruncated,
    detectedAt: primary?.detectedAt ?? run.createdAt,
    ...promptViewOf(run),
    ...deliveryView({ delivery, primary })
  };
}

// service/poll/runs-transitions.ts
var MAX_AUTO_REQUEUES = 3;
function leaseRun(input) {
  const { run, lease, now } = input;
  if (run.state !== "pending" || runHistoryIndicatesSession(run)) {
    return null;
  }
  return {
    ...run,
    state: "claimed",
    stateReason: `lease held by ${lease.holder} until ${lease.expiresAt}`,
    lease: { attempt: run.attempt, ...lease },
    attempts: openedHistory(run),
    updatedAt: now
  };
}
function expireLease(input) {
  const { run, now, chargeBudget } = input;
  if (run.state !== "claimed" || run.lease === null || run.reservation !== null || runHistoryIndicatesSession(run) || Date.parse(run.lease.expiresAt) > Date.parse(now)) {
    return null;
  }
  return {
    ...run,
    state: "pending",
    stateReason: null,
    attempt: run.attempt + 1,
    requeuesUsed: run.requeuesUsed + (chargeBudget ? 1 : 0),
    lease: null,
    attempts: attemptHistory(run, {
      ...currentAttempt(run),
      outcome: "expired",
      reason: "lease expired without a reservation",
      resultReportedAt: now
    }),
    updatedAt: now
  };
}
function parkRun(input) {
  const { run, now, reason } = input;
  if (isTerminalRun(run) || run.session !== null) {
    return null;
  }
  const open = currentAttempt(run);
  const attempts = open.outcome === null ? attemptHistory(run, { ...open, outcome: "expired", reason, resultReportedAt: now }) : run.attempts;
  return {
    ...run,
    state: "dead-lettered",
    stateReason: reason,
    lease: null,
    attempts,
    updatedAt: now
  };
}
function wedgeUnconfirmed(input) {
  const { run, now } = input;
  if (run.state !== "starting" || run.reservation === null || run.session !== null) {
    return null;
  }
  return {
    ...run,
    state: "unconfirmed",
    stateReason: `no result by ${run.reservation.resultDeadlineAt}`,
    attempts: attemptHistory(run, {
      ...currentAttempt(run),
      outcome: "unconfirmed",
      reason: "result deadline passed",
      resultReportedAt: now
    }),
    updatedAt: now
  };
}

// service/poll/claim.ts
var UNKNOWN_HOLDER = "unknown";
var MAX_HOLDER_CHARS = 64;
var LEASE_ID_HEX_CHARS = 24;
function holderOf(raw) {
  if (raw === null || raw.length === 0 || raw.length > MAX_HOLDER_CHARS || !/^[A-Za-z0-9._~-]+$/.test(raw)) {
    return UNKNOWN_HOLDER;
  }
  return raw;
}
function buildLeaseId(input) {
  const digest = createHash4("sha256").update(`${input.correlationId}|${input.attempt}|${input.issuedAt}`, "utf8").digest("hex").slice(0, LEASE_ID_HEX_CHARS);
  return `lse-${digest}`;
}
function deliveriesById(queue) {
  return new Map(queue.map((event) => [event.id, event]));
}
function planOne(input, run) {
  const expiresAt = new Date(Date.parse(input.now) + input.leaseMs).toISOString();
  const leaseId = buildLeaseId({ correlationId: run.correlationId, attempt: run.attempt, issuedAt: input.now });
  const claimed = leaseRun({
    run,
    lease: { leaseId, holder: input.holder, issuedAt: input.now, expiresAt, provenance: "panel" },
    now: input.now
  });
  if (claimed === null) {
    return null;
  }
  const lease = {
    leaseId,
    attempt: claimed.attempt,
    holder: input.holder,
    issuedAt: input.now,
    expiresAt
  };
  return { run: claimed, lease, claimed: projectClaimedRun({ run: claimed, lease, deliveries: input.deliveries }) };
}
function planClaim(input) {
  const claims = [];
  const runs = [...input.document.runs];
  let eligible = 0;
  let deferred = 0;
  let used = measureEvents([]);
  for (const [index, run] of runs.entries()) {
    if (run.state !== "pending" || runHistoryIndicatesSession(run)) {
      continue;
    }
    eligible += 1;
    const attempt = planOne(input, run);
    if (attempt === null) {
      deferred += 1;
      continue;
    }
    const cost = measureEvents([attempt.claimed]) + (claims.length > 0 ? 1 : 0);
    if (claims.length >= input.maxRuns || used + cost > input.budgetChars) {
      deferred += 1;
      continue;
    }
    used += cost;
    runs[index] = attempt.run;
    claims.push(attempt);
  }
  return { claims, document: { ...input.document, runs }, deferred: Math.max(deferred, eligible - claims.length) };
}
async function readLeaseMs(store, log) {
  try {
    const stored = await store.readJson(CONFIG_FILE, parseStoredConfig);
    return configFromStore(stored, log).config.leaseMs;
  } catch (cause) {
    log.warn("lease duration read failed", { errorKind: cause instanceof Error ? cause.name : typeof cause });
    return DEFAULT_CONFIG.leaseMs;
  }
}
async function appendClaimAudit(input) {
  try {
    await appendAudit(input.store, {
      eventType: "dispatch.claimed",
      actorSource: "panel",
      entity: { kind: "run", id: input.claim.run.correlationId },
      correlationId: input.claim.run.correlationId,
      details: {
        leaseId: input.claim.lease.leaseId,
        attempt: input.claim.lease.attempt,
        leaseExpiry: input.claim.lease.expiresAt,
        sourceReferenceCount: input.claim.claimed.sourceReferences.length,
        holder: input.claim.lease.holder
      }
    });
    return true;
  } catch (cause) {
    input.log.warn("dispatch claim audit row could not be appended", {
      correlationId: input.claim.run.correlationId,
      errorKind: cause instanceof Error ? cause.name : typeof cause
    });
    return false;
  }
}
var DEFAULT_CLAIM_BOUNDS = {
  maxRuns: MAX_CLAIMED_RUNS,
  budgetChars: CLAIM_EVENTS_BUDGET_CHARS
};
function hasEligibleRun(document) {
  return document.runs.some((run) => run.state === "pending" && !runHistoryIndicatesSession(run));
}
async function claimPendingRuns(input) {
  const now = input.now ?? nowIso();
  const maxRuns = input.maxRuns ?? DEFAULT_CLAIM_BOUNDS.maxRuns;
  const budgetChars = input.budgetChars ?? DEFAULT_CLAIM_BOUNDS.budgetChars;
  const leaseMs = await readLeaseMs(input.store, input.log);
  const deliveries = deliveriesById(await readEvents(input));
  await whenQueueIdle();
  const preview = await previewRunsDocument({ ...input, now });
  if (!hasEligibleRun(preview)) {
    return { runs: [], deferred: 0, auditWritten: true };
  }
  const outcome = await inQueueChain(async () => {
    const document = await readRunsDocument({ ...input, now });
    const planned = planClaim({ document, holder: input.holder, leaseMs, now, deliveries, maxRuns, budgetChars });
    if (planned.claims.length === 0) {
      return planned;
    }
    return { ...planned, document: await writeRunsDocument({ ...input, document: planned.document }) };
  });
  const written = [];
  for (const claim of outcome.claims) {
    written.push(await appendClaimAudit({ store: input.store, log: input.log, claim }));
  }
  return {
    runs: outcome.claims.map((claim) => claim.claimed),
    deferred: outcome.deferred,
    auditWritten: written.every(Boolean)
  };
}

// service/poll/cycle-config.ts
function describeKind(cause) {
  return cause instanceof Error ? cause.name : typeof cause;
}
async function currentIntervalMs(store, log) {
  if (store === null) {
    return DEFAULT_CONFIG.intervalMs;
  }
  try {
    const { config } = configFromStore(await store.readJson(CONFIG_FILE, parseStoredConfig), log);
    return config.intervalMs;
  } catch (cause) {
    log.warn("poll interval read failed", { errorKind: describeKind(cause) });
    return DEFAULT_CONFIG.intervalMs;
  }
}
async function readCycleConfig(input) {
  try {
    return await runConfigPromptChain(input.store, async () => {
      const { config } = configFromStore(await input.store.readJson(CONFIG_FILE, parseStoredConfig), input.log);
      await recordConfigPromptChanges({
        store: input.store,
        log: input.log,
        config,
        actor: "service"
      });
      return config;
    });
  } catch (cause) {
    input.log.warn("cycle configuration read failed", { errorKind: describeKind(cause) });
    return DEFAULT_CONFIG;
  }
}

// service/poll/run-history-project.ts
var WAITING_REASON = "waiting for a panel";
function reviewCoordinates2(delivery) {
  const head = delivery?.headSha ?? null;
  const base = delivery?.baseRef ?? null;
  return { ...head !== null && { headSha: head }, ...base !== null && { baseRef: base } };
}
function recordedCause(run) {
  for (let index = run.attempts.length - 1;index !== -1; index -= 1) {
    const reason = run.attempts[index]?.reason ?? null;
    if (reason !== null) {
      return reason;
    }
  }
  return run.state === "failed" ? run.stateReason : null;
}
function dispatchResultOf(run) {
  if (run.session !== null) {
    return run.session.sessionId;
  }
  return recordedCause(run);
}
function deliveryView2(input) {
  const { run, primary, delivery } = input;
  const title = delivery?.issueTitle ?? "";
  return {
    issueTitle: title === "" ? `#${run.subjectNumber}` : title,
    issueUrl: delivery?.issueUrl ?? primary?.sourceUrl ?? ""
  };
}
function withReviewCoordinates(row, delivery) {
  const coordinates = reviewCoordinates2(delivery);
  if (coordinates.headSha === undefined && coordinates.baseRef === undefined) {
    return row;
  }
  return { ...row, ...coordinates };
}
function liveResultDeadlineOf(run) {
  if (run.reservation === null || run.reservation.consumed) {
    return null;
  }
  return run.reservation.resultDeadlineAt;
}
function leaseViewOf(run) {
  if (run.lease === null) {
    return { leaseExpiresAt: null, claimedAt: null };
  }
  return { leaseExpiresAt: run.lease.expiresAt, claimedAt: run.lease.issuedAt };
}
function sessionViewOf(run) {
  if (run.session === null) {
    return null;
  }
  return {
    sessionId: run.session.sessionId,
    attachmentId: run.session.attachmentId,
    dispatchedAt: run.session.dispatchedAt
  };
}
function verificationViewOf(run) {
  if (run.verification === null) {
    return null;
  }
  return {
    observedAgent: run.verification.observedAgent,
    expectedAgent: run.verification.expectedAgent,
    ok: run.verification.ok,
    note: run.verification.note
  };
}
function promptViewOf2(run) {
  if (run.prompt === null) {
    return {
      promptPresent: false,
      promptFingerprint: null,
      promptLength: null,
      promptSources: null
    };
  }
  return {
    promptPresent: true,
    promptFingerprint: run.prompt.fingerprint,
    promptLength: run.prompt.length,
    promptSources: run.prompt.sources
  };
}
function historyRowOf(input) {
  const { run, deliveries } = input;
  const primary = run.sourceReferences[0];
  const delivery = primary === undefined ? undefined : deliveries.get(primary.deliveryId);
  const view = deliveryView2({ run, primary, delivery });
  const lease = leaseViewOf(run);
  const dispatchStamp = run.session === null ? null : run.session.dispatchedAt;
  return withReviewCoordinates({
    id: run.correlationId,
    state: run.state,
    stateReason: run.stateReason ?? WAITING_REASON,
    runKey: run.runKey,
    ordinal: run.ordinal,
    attempt: run.attempt,
    correlationId: run.correlationId,
    attachmentId: run.attachmentId,
    projectId: run.projectId,
    worktreeOption: run.worktreeOption,
    leaseExpiresAt: lease.leaseExpiresAt,
    resultDeadlineAt: liveResultDeadlineOf(run),
    sourceReferences: run.sourceReferences,
    referenceCount: run.referenceCount,
    referencesTruncated: run.referencesTruncated,
    referencesNotRetained: run.referencesNotRetained,
    session: sessionViewOf(run),
    verification: verificationViewOf(run),
    kind: primary?.kind ?? "assignment",
    repository: run.repository,
    issueNumber: run.subjectNumber,
    issueTitle: view.issueTitle,
    issueUrl: view.issueUrl,
    detectedAt: primary?.detectedAt ?? run.createdAt,
    bindingId: run.bindingId,
    dispatchResult: dispatchResultOf(run),
    claimedAt: lease.claimedAt,
    dispatchedAt: dispatchStamp,
    ...promptViewOf2(run),
    actorPolicy: run.actorPolicy
  }, delivery);
}
function projectRunHistory(input) {
  const rows = input.runs.map((run) => historyRowOf({ run, deliveries: input.deliveries }));
  return rows.toSorted((left, right) => Date.parse(right.detectedAt) - Date.parse(left.detectedAt)).slice(0, input.cap);
}

// service/poll/window.ts
var BASELINE_UNREADABLE = "baseline-unreadable";
var LOOK_BACK_OUT_OF_BOUNDS = "look-back-out-of-bounds";
var STAMP_UNREADABLE = "stamp-unreadable";
function readableStamp(value) {
  return value !== null && !Number.isNaN(Date.parse(value)) ? value : null;
}
function baselineFor(input) {
  if (input.stored.kind === "unreadable") {
    return { refused: BASELINE_UNREADABLE };
  }
  const createdAtMs = input.stored.kind === "stamp" ? Date.parse(input.stored.at) : Date.parse(input.binding.createdAt);
  if (Number.isNaN(createdAtMs)) {
    return { refused: BASELINE_UNREADABLE };
  }
  let reachedBackMs = input.overlapMs;
  if (effectiveHistoryScope(input.binding.historyScope) === "recent-history") {
    const lookBack = lookBackMs();
    if (lookBack === null) {
      return { refused: LOOK_BACK_OUT_OF_BOUNDS };
    }
    reachedBackMs = lookBack;
  }
  return { window: new Date(createdAtMs - reachedBackMs).toISOString() };
}
function windowFor(input) {
  const armed = readableStamp(input.scanned.rescanFrom);
  if (armed !== null) {
    return { window: armed };
  }
  const recorded = readableStamp(input.scanned.lastScanAt);
  if (recorded !== null) {
    return { window: new Date(Date.parse(recorded) - input.overlapMs).toISOString() };
  }
  if (input.scanned.lastScanAt !== null) {
    return { refused: STAMP_UNREADABLE };
  }
  const baseline = readableStamp(input.scanned.baselineAt);
  if (baseline !== null) {
    return { window: baseline };
  }
  return { refused: BASELINE_UNREADABLE };
}
function stampInWindow(stamp, windowStart) {
  if (stamp === null) {
    return false;
  }
  const observed = Date.parse(stamp);
  const start = Date.parse(windowStart);
  return !Number.isNaN(observed) && !Number.isNaN(start) && observed >= start;
}
function bindingsNeedingBaseline(input) {
  return input.bindings.filter((binding) => {
    const slot = input.slots[binding.bindingId];
    return (slot?.lastScanAt ?? null) === null && (slot?.baselineAt ?? null) === null;
  }).map((binding) => binding.bindingId);
}

// service/routes/events-page.ts
var MIN_PAGE_SIZE = 10;
var DEFAULT_PAGE_SIZE = 25;
var MID_PAGE_SIZE = 50;
var MAX_PAGE_SIZE = 100;
var LIST_PAGE_SIZES = [MIN_PAGE_SIZE, DEFAULT_PAGE_SIZE, MID_PAGE_SIZE, MAX_PAGE_SIZE];
var LISTABLE_STATES = [
  "pending",
  "claimed",
  "starting",
  "dispatched",
  "failed",
  "unconfirmed",
  "dead-lettered"
];
function pageSizeOf(raw) {
  if (raw === null || raw === "") {
    return DEFAULT_PAGE_SIZE;
  }
  if (!/^\d{1,3}$/.test(raw)) {
    return null;
  }
  const parsed = Number(raw);
  return LIST_PAGE_SIZES.includes(parsed) ? parsed : null;
}
function boundaryOf(raw) {
  if (raw === null || raw === "") {
    return { ok: true, boundary: null };
  }
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return { ok: false };
  }
  if (typeof decoded !== "object" || decoded === null) {
    return { ok: false };
  }
  const record = decoded;
  const stamp = record.detectedAt;
  const key = record.id;
  if (typeof stamp !== "string" || typeof key !== "string" || key === "" || Number.isNaN(Date.parse(stamp))) {
    return { ok: false };
  }
  return { ok: true, boundary: { detectedAt: stamp, id: key } };
}
function encodeBoundary(row) {
  const payload = { detectedAt: row.detectedAt, id: row.id };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}
function isKebabReason(value) {
  if (value === "") {
    return false;
  }
  return value.split("-").every((part) => /^[a-z0-9]+$/.test(part));
}
function stateFilterOf(raw) {
  if (raw === null || raw === "") {
    return { ok: true, state: null };
  }
  if (raw === "blocked" || LISTABLE_STATES.includes(raw)) {
    return { ok: true, state: raw };
  }
  const prefix = "blocked:";
  if (raw.startsWith(prefix) && isKebabReason(raw.slice(prefix.length))) {
    return { ok: true, state: raw };
  }
  return { ok: false };
}
function listQueryOf(request) {
  const params = request.url.searchParams;
  const limit = pageSizeOf(params.get("limit"));
  if (limit === null) {
    return {
      ok: false,
      response: validationResponse([{
        field: "limit",
        remediation: `ask for one of ${LIST_PAGE_SIZES.join(", ")} rows per page`
      }])
    };
  }
  const cursor = boundaryOf(params.get("cursor"));
  if (!cursor.ok) {
    return {
      ok: false,
      response: validationResponse([{
        field: "cursor",
        remediation: "the cursor is not one this service issued; drop it to start at the first page"
      }])
    };
  }
  const state = stateFilterOf(params.get("state"));
  if (!state.ok) {
    return {
      ok: false,
      response: validationResponse([{
        field: "state",
        remediation: `ask for one of ${LISTABLE_STATES.join(", ")}, blocked, or blocked:<reason>`
      }])
    };
  }
  const bindingId = params.get("bindingId") ?? "";
  return {
    ok: true,
    query: { limit, boundary: cursor.boundary, state: state.state, bindingId }
  };
}
function matchesFilters(row, query) {
  if (query.bindingId !== "" && row.bindingId !== query.bindingId) {
    return false;
  }
  if (query.state === null) {
    return true;
  }
  return query.state === "blocked" ? row.state.startsWith("blocked:") : row.state === query.state;
}
function newestFirst(left, right) {
  const byStamp = Date.parse(right.detectedAt) - Date.parse(left.detectedAt);
  if (byStamp !== 0) {
    return byStamp;
  }
  if (left.id === right.id) {
    return 0;
  }
  return left.id < right.id ? 1 : -1;
}
function afterBoundary(row, boundary) {
  const byStamp = Date.parse(row.detectedAt) - Date.parse(boundary.detectedAt);
  if (byStamp !== 0) {
    return byStamp < 0;
  }
  return row.id < boundary.id;
}
function buildEventPage(input) {
  return { ...input };
}

// service/routes/events.ts
var EVENTS_PENDING_PATH = "/v1/events/pending";
var EVENTS_PATH = "/v1/events";
function actorPolicyOf(binding) {
  return binding.allowedUsers === undefined ? "open" : "restricted";
}
function claimLimitOf(raw) {
  if (raw === null || raw === "") {
    return MAX_CLAIMED_RUNS;
  }
  if (!/^[0-9]{1,6}$/.test(raw)) {
    return null;
  }
  const limit = Number(raw);
  return limit >= 1 && limit <= MAX_CLAIMED_RUNS ? limit : null;
}
async function readStatusRows(input) {
  const [scannedState, runs] = await Promise.all([readScanState(input), previewRunsDocument(input)]);
  const counts = new Map;
  for (const run of runs.runs) {
    if (run.state === "pending") {
      counts.set(run.bindingId, (counts.get(run.bindingId) ?? 0) + 1);
    }
  }
  return input.bindings.map((binding) => {
    const scan = bindingScanOf(scannedState, binding.bindingId);
    const verdict = windowFor({ binding, scanned: scan, overlapMs: input.overlapMs });
    return {
      bindingId: binding.bindingId,
      repository: binding.repository,
      projectId: binding.projectId,
      accountLogin: binding.accountLogin,
      active: binding.state === "active",
      lastScanAt: scan.lastScanAt,
      lastError: scan.lastError,
      pendingCount: counts.get(binding.bindingId) ?? 0,
      actorPolicy: actorPolicyOf(binding),
      windowStart: "window" in verdict ? verdict.window : null,
      historyScope: effectiveHistoryScope(binding.historyScope),
      forceReplay: scan.forceReplay
    };
  });
}
async function handlePendingEvents(context, request) {
  const { store } = context;
  if (store === null) {
    return storageUnavailableResponse();
  }
  const limit = claimLimitOf(request.url.searchParams.get("limit"));
  if (limit === null) {
    return validationResponse([{
      field: "limit",
      remediation: `ask for at most ${MAX_CLAIMED_RUNS} runs per claim; ` + "the rest stay claimable for the next call"
    }]);
  }
  const claimed = await claimPendingRuns({
    store,
    log: context.log,
    holder: holderOf(request.url.searchParams.get("holder")),
    maxRuns: limit
  });
  const bindings = await readBindings({ store, log: context.log });
  const { overlapMs } = await readCycleConfig({ store, log: context.log });
  const rows = await readStatusRows({ store, log: context.log, bindings, overlapMs });
  return {
    status: STATUS.ok,
    body: { events: claimed.runs, status: rows, auditWritten: claimed.auditWritten }
  };
}
async function projectHistory(context, store) {
  const document = await previewRunsDocument({ store, log: context.log });
  const queue = await readEvents({ store, log: context.log });
  return projectRunHistory({
    runs: document.runs,
    deliveries: new Map(queue.map((event) => [event.id, event])),
    cap: document.runs.length
  }).toSorted(newestFirst);
}
async function handleEventHistory(context, request) {
  const { store } = context;
  if (store === null) {
    return storageUnavailableResponse();
  }
  const parsed = listQueryOf(request);
  if (!parsed.ok) {
    return parsed.response;
  }
  const { query } = parsed;
  const rows = await projectHistory(context, store);
  const filtered = rows.filter((row) => matchesFilters(row, query));
  const { boundary } = query;
  const remaining = boundary === null ? filtered : filtered.filter((row) => afterBoundary(row, boundary));
  const window = remaining.slice(0, query.limit + 1);
  const hasMore = window.length > query.limit;
  const events = window.slice(0, query.limit);
  const last = events.at(-1);
  return {
    status: STATUS.ok,
    body: {
      events,
      page: buildEventPage({
        limit: query.limit,
        nextCursor: hasMore && last !== undefined ? encodeBoundary(last) : null,
        hasMore,
        total: filtered.length,
        snapshotAt: new Date().toISOString(),
        filter: { bindingId: query.bindingId === "" ? null : query.bindingId, state: query.state }
      })
    }
  };
}
var pendingEventsRoute = {
  method: "GET",
  path: EVENTS_PENDING_PATH,
  handler: (context, request) => handlePendingEvents(context, request)
};
var eventHistoryRoute = {
  method: "GET",
  path: EVENTS_PATH,
  handler: (context, request) => handleEventHistory(context, request)
};

// service/poll/row-text.ts
var MAX_ROW_TEXT_CHARS = 500;
var TEXT_TRUNCATION_MARKER = "… [truncated]";
function boundText(value) {
  if (value.length <= MAX_ROW_TEXT_CHARS) {
    return value;
  }
  return `${value.slice(0, MAX_ROW_TEXT_CHARS)}${TEXT_TRUNCATION_MARKER}`;
}
function rowText(value) {
  return value === null ? null : boundText(value);
}

// service/poll/dispatch-audit.ts
var RUN_ENTITY_KIND2 = "run";
var PANEL_ACTOR = "panel";
var SERVICE_ACTOR2 = "service";
var OPERATOR_ACTOR = "operator";
function runRow(run) {
  return { entity: { kind: RUN_ENTITY_KIND2, id: run.correlationId }, correlationId: run.correlationId };
}
function promptDetails(run) {
  return {
    bindingId: run.bindingId,
    promptPresent: run.prompt !== null,
    promptFingerprint: run.prompt === null ? null : run.prompt.fingerprint,
    promptLength: run.prompt === null ? null : run.prompt.length,
    promptSources: run.prompt === null ? null : run.prompt.sources,
    actorPolicy: run.actorPolicy
  };
}
function reservedRow(input) {
  return {
    eventType: "dispatch.reserved",
    actorSource: PANEL_ACTOR,
    ...runRow(input.run),
    details: {
      leaseId: input.leaseId,
      attempt: input.run.attempt,
      dispatchTokenFingerprint: buildDispatchTokenFingerprint(input.dispatchToken),
      attachmentId: input.run.attachmentId,
      ...promptDetails(input.run)
    }
  };
}
function resultRow(input) {
  return {
    eventType: "dispatch.result",
    actorSource: PANEL_ACTOR,
    ...runRow(input.run),
    decision: input.sessionId === null ? "failed" : "dispatched",
    details: {
      attempt: input.run.attempt,
      dispatchTokenFingerprint: buildDispatchTokenFingerprint(input.dispatchToken),
      ...input.sessionId === null ? { failureReason: rowText(input.problem) } : { sessionId: input.sessionId },
      ...promptDetails(input.run)
    }
  };
}
function duplicateReportRow(input) {
  return {
    eventType: "dispatch.duplicate-report",
    actorSource: SERVICE_ACTOR2,
    ...runRow(input.run),
    decision: "no-change",
    details: {
      attempt: input.run.attempt,
      dispatchTokenFingerprint: buildDispatchTokenFingerprint(input.dispatchToken),
      state: input.state
    }
  };
}
function abandonedRow(input) {
  return {
    eventType: "dispatch.abandoned",
    actorSource: PANEL_ACTOR,
    ...runRow(input.run),
    decision: "no-session",
    details: {
      attempt: input.run.attempt,
      dispatchTokenFingerprint: buildDispatchTokenFingerprint(input.dispatchToken),
      reason: rowText(input.reason)
    }
  };
}
function blockedRow(input) {
  return {
    eventType: "run.blocked",
    actorSource: PANEL_ACTOR,
    ...runRow(input.run),
    decision: "blocked",
    details: {
      blockedReason: input.blockedReason,
      priorState: input.priorState,
      guidance: rowText(input.guidance)
    }
  };
}
function retryRow(input) {
  return {
    eventType: "dispatch.retry",
    actorSource: OPERATOR_ACTOR,
    ...runRow(input.run),
    decision: "retry",
    details: {
      priorState: input.priorState,
      attemptBefore: input.attemptBefore,
      attemptAfter: input.attemptAfter,
      causeReportedCleared: input.causeReportedCleared,
      causeClearedSource: input.causeClearedSource,
      attemptReset: input.reset,
      causeReport: rowText(input.causeReport)
    }
  };
}
function resolvedRow(input) {
  return {
    eventType: "dispatch.resolved",
    actorSource: OPERATOR_ACTOR,
    ...runRow(input.run),
    decision: input.decision,
    details: {
      priorState: input.priorState,
      note: rowText(input.note),
      guidance: rowText(input.guidance)
    }
  };
}
function readBackVerdict(input) {
  if (!input.wasCompared) {
    return { eventType: "agent.uncompared", decision: "observed" };
  }
  return input.wasMatched ? { eventType: "agent.verified", decision: "verified" } : { eventType: "agent.mismatch", decision: "warn" };
}
function verificationRow(input) {
  const { verification } = input;
  const wasCompared = verification.expectedAgent !== "";
  const verdict = readBackVerdict({
    wasCompared,
    wasMatched: wasCompared && verification.ok
  });
  return {
    eventType: verdict.eventType,
    actorSource: PANEL_ACTOR,
    ...runRow(input.run),
    decision: verdict.decision,
    details: {
      sessionId: input.run.session?.sessionId ?? "",
      observedAgent: verification.observedAgent,
      expectedAgent: verification.expectedAgent,
      ...!wasCompared && { baselineProvenance: input.baselineProvenance },
      note: rowText(verification.note)
    }
  };
}
function actorDetails(actor) {
  return {
    bindingId: actor.bindingId,
    actorPolicy: actor.actorPolicy,
    ...actor.deniedLogins !== undefined && { deniedLogins: actor.deniedLogins.map((login) => boundText(login)) },
    ...actor.deniedAttributions !== undefined && { deniedAttributions: [...actor.deniedAttributions] },
    unreadableReferences: actor.unreadableReferences,
    retainedReferences: actor.retainedReferences,
    referencesNotRetained: actor.referencesNotRetained,
    referencesTruncated: actor.referencesTruncated
  };
}
function refusedRow(input) {
  return {
    eventType: "dispatch.refused",
    actorSource: SERVICE_ACTOR2,
    ...runRow(input.run),
    decision: "refused",
    reason: input.reason,
    details: {
      operation: input.operation,
      code: input.code,
      priorState: input.run.state,
      attempt: input.attempt,
      ...input.leaseId !== undefined && { leaseId: input.leaseId },
      ...input.dispatchTokenFingerprint !== undefined && { dispatchTokenFingerprint: input.dispatchTokenFingerprint },
      ...input.actor !== undefined && actorDetails(input.actor)
    }
  };
}
async function appendRunRow(input) {
  try {
    await appendAudit(input.store, input.row);
    return true;
  } catch (cause) {
    input.log.warn("dispatch lifecycle audit row could not be appended", {
      correlationId: input.correlationId,
      eventType: input.row.eventType,
      errorKind: cause instanceof Error ? cause.name : typeof cause
    });
    return false;
  }
}

// service/poll/run-refusal.ts
var STALE_LEASE_CODE = "stale-lease";
function refuse3(code, message) {
  return { code, message };
}
function refuseOnWindow(input) {
  return { ...refuse3(input.code, input.message), referenceWindow: input.referenceWindow };
}
function staleAttemptMessage(attempt, current) {
  return `the request names attempt ${attempt} but this run stands on attempt ${current}; ` + "read the run again and act on the attempt it reports";
}

// service/poll/dispatch-actor-gate.ts
var ACTOR_NOT_ALLOWED = "actor-not-allowed";
var ACTOR_BLOCKED_REASON = ACTOR_NOT_ALLOWED;
var UNRECORDED_BASIS = "unrecorded";
function classifyActor(reference) {
  const login = reference.actorLogin;
  if (login === undefined || login === "" || login.toLowerCase().endsWith("[bot]")) {
    return { readable: false };
  }
  return { readable: true, login, attribution: reference.actorAttribution ?? null };
}
function classifyRun(run) {
  const classified = run.sourceReferences.map((reference) => classifyActor(reference));
  return {
    readable: classified.filter((actor) => actor.readable),
    unreadableReferences: classified.filter((actor) => !actor.readable).length
  };
}
function judgedWindow(run) {
  return {
    retained: run.sourceReferences.length,
    notRetained: run.referencesNotRetained,
    truncated: run.referencesTruncated
  };
}
function refusalDetails(input) {
  const window = judgedWindow(input.run);
  return {
    bindingId: input.run.bindingId,
    actorPolicy: input.policy,
    ...input.deniedLogins !== undefined && { deniedLogins: input.deniedLogins },
    ...input.deniedAttributions !== undefined && { deniedAttributions: input.deniedAttributions },
    unreadableReferences: input.unreadableReferences,
    retainedReferences: window.retained,
    referencesNotRetained: window.notRetained,
    referencesTruncated: window.truncated
  };
}
function judgedWindowWord(run) {
  return judgedWindow(run).truncated ? "truncated" : "complete";
}
function truncatedNote(run) {
  if (!run.referencesTruncated) {
    return "";
  }
  return `; this run's source reference list was cut at ${run.sourceReferences.length} of ` + `${run.referenceCount} triggers, so this decision was made on an incomplete list and adding a login to ` + "the binding's allowedUsers cannot clear it";
}
function namedActors(actors) {
  return actors.map((actor) => `${actor.login} (${actor.attribution === "subject-author" ? "the issue or pull-request author, attributed under the rule in force when this row was written" : actor.attribution ?? UNRECORDED_BASIS})`).join(", ");
}
function unreadableNote(unreadableReferences) {
  return unreadableReferences === 0 ? "every reference names a readable actor" : `${unreadableReferences} of this run's references name no readable actor`;
}
function deniedPolicyRefusal(input) {
  return {
    admitted: false,
    refused: {
      refusal: refuseOnWindow({
        code: ACTOR_NOT_ALLOWED,
        message: `${input.message}${truncatedNote(input.run)}`,
        referenceWindow: judgedWindowWord(input.run)
      }),
      actor: refusalDetails({
        run: input.run,
        policy: input.policy,
        deniedLogins: input.readable.map((actor) => actor.login),
        deniedAttributions: input.readable.map((actor) => actor.attribution ?? UNRECORDED_BASIS),
        unreadableReferences: input.unreadableReferences
      })
    }
  };
}
function judgeActorPolicy(input) {
  const { run, allowedUsers } = input;
  const { readable, unreadableReferences } = classifyRun(run);
  const policy = allowedUsers === undefined ? "open" : "restricted";
  if (readable.some((actor) => isActorAllowed(actor.login, allowedUsers))) {
    return { admitted: true, policy };
  }
  const refuseWith = (message) => deniedPolicyRefusal({ run, policy, message, readable, unreadableReferences });
  if (readable.length > 0) {
    return refuseWith("no source reference on this run names an actor the binding's allowedUsers permits: " + `${namedActors(readable)}; ${unreadableNote(unreadableReferences)}`);
  }
  return refuseWith(unreadableReferences === 0 ? "this run records no source reference, so no actor can be permitted" : `this run records no readable actor: all ${unreadableReferences} of its references name no ` + "attribution or name a bot account, which no binding can permit");
}
function unreadablePolicyRefusal(run, cause) {
  const { unreadableReferences } = classifyRun(run);
  const message = cause === "binding-absent" ? `no binding ${run.bindingId} exists, so its allow-list cannot be read and no dispatch is authorized` : `the bindings document could not be read, so the allow-list for binding ${run.bindingId} cannot be ` + "judged and no dispatch is authorized";
  return {
    admitted: false,
    refused: {
      refusal: refuseOnWindow({
        code: ACTOR_NOT_ALLOWED,
        message: `${message}${truncatedNote(run)}`,
        referenceWindow: judgedWindowWord(run)
      }),
      actor: refusalDetails({
        run,
        policy: null,
        deniedLogins: undefined,
        deniedAttributions: undefined,
        unreadableReferences
      })
    }
  };
}
async function readLivePolicy(input) {
  const read = await readBindingsForAuthorization({ store: input.store, log: input.log });
  if (!read.readable) {
    return { readable: false, cause: "document-unreadable" };
  }
  const binding = read.bindings.find((candidate) => candidate.bindingId === input.bindingId);
  return binding === undefined ? { readable: false, cause: "binding-absent" } : { readable: true, allowedUsers: binding.allowedUsers };
}

// service/poll/run-chain.ts
async function operateRun(target, task) {
  const now = target.now ?? nowIso();
  return await inQueueChain(async () => {
    const document = await readRunsDocument({ ...target, now });
    const index = document.runs.findIndex((run2) => run2.correlationId === target.correlationId);
    const run = document.runs[index];
    if (run === undefined) {
      return { status: "not-found" };
    }
    return await task({
      run,
      now,
      persist: async (next) => {
        const runs = [...document.runs];
        runs[index] = next;
        await writeRunsDocument({ store: target.store, log: target.log, document: { ...document, runs } });
      }
    });
  });
}
async function appendRefusalRow(input) {
  const { refusal } = input;
  const row = refusedRow({
    run: refusal.run,
    operation: refusal.operation,
    code: refusal.refusal.code,
    reason: refusal.refusal.message,
    attempt: refusal.attempt,
    ...refusal.leaseId !== undefined && { leaseId: refusal.leaseId },
    ...refusal.dispatchTokenFingerprint !== undefined && { dispatchTokenFingerprint: refusal.dispatchTokenFingerprint },
    ...refusal.actor !== undefined && { actor: refusal.actor }
  });
  return await appendRunRow({
    store: input.store,
    log: input.log,
    correlationId: refusal.run.correlationId,
    row
  });
}
function sessionRefOf(input) {
  return {
    sessionId: input.sessionId,
    attachmentId: input.run.attachmentId,
    dispatchedAt: input.now,
    title: "",
    sourceUrl: input.run.sourceReferences[0]?.sourceUrl ?? "",
    worktree: null
  };
}

// service/poll/dispatch-authorize.ts
var INVALID_TRANSITION = "invalid-transition";
var STALE_MESSAGE = "the lease is expired or does not match this run";
function sessionIdOf(run) {
  if (run.session !== null) {
    return run.session.sessionId;
  }
  return run.attempts.find((attempt) => attempt.sessionId !== null)?.sessionId ?? null;
}
function judgeLease(input) {
  const { run, leaseId, attempt, now } = input;
  const stale = refuse3("stale-lease", STALE_MESSAGE);
  if (run.lease?.leaseId !== leaseId) {
    return stale;
  }
  if (attempt !== run.attempt || run.lease.attempt !== run.attempt) {
    return stale;
  }
  return Date.parse(run.lease.expiresAt) <= Date.parse(now) ? stale : null;
}
function judgeReserve(input) {
  const { run } = input;
  if (runHistoryIndicatesSession(run)) {
    const sessionId = sessionIdOf(run);
    return refuse3("already-dispatched", sessionId === null ? "this run already produced a session" : `a session already exists: ${sessionId}`);
  }
  const lease = judgeLease(input);
  if (lease !== null) {
    return lease;
  }
  const { reservation } = run;
  if (reservation !== null) {
    const { attempt, resultDeadlineAt } = reservation;
    return refuse3("already-reserved", `this run is already authorized: attempt ${attempt} must report by ${resultDeadlineAt}`);
  }
  return run.state === "claimed" ? null : refuse3(INVALID_TRANSITION, `this run is ${run.state}; only a claimed run can be authorized`);
}
function reservedRun(input) {
  const { run, dispatchToken, resultDeadlineAt, actorPolicy, now } = input;
  return {
    ...run,
    state: "starting",
    stateReason: `authorized at ${now}; result due by ${resultDeadlineAt}`,
    actorPolicy,
    reservation: { dispatchToken, attempt: run.attempt, reservedAt: now, resultDeadlineAt, consumed: false },
    attempts: attemptHistory(run, { ...currentAttempt(run), dispatchToken, reservedAt: now }),
    updatedAt: now
  };
}
async function readResultDeadlineMs(store, log) {
  try {
    const stored = await store.readJson(CONFIG_FILE, parseStoredConfig);
    return configFromStore(stored, log).config.resultDeadlineMs;
  } catch (cause) {
    log.warn("result deadline read failed", { errorKind: cause instanceof Error ? cause.name : typeof cause });
    return DEFAULT_CONFIG.resultDeadlineMs;
  }
}
async function refusedReserve(input) {
  const { call, run, refusal, actor } = input;
  return {
    status: "refused",
    refusal,
    run,
    auditWritten: await appendRefusalRow({
      store: call.store,
      log: call.log,
      refusal: {
        run,
        operation: "reserve",
        refusal,
        attempt: call.attempt,
        leaseId: call.leaseId,
        ...actor !== undefined && { actor }
      }
    })
  };
}
async function reserveDispatch(input) {
  const deadlineMs = await readResultDeadlineMs(input.store, input.log);
  return await operateRun(input, async ({ run, now, persist }) => {
    const refusal = judgeReserve({ run, leaseId: input.leaseId, attempt: input.attempt, now });
    if (refusal !== null) {
      return await refusedReserve({ call: input, run, refusal });
    }
    const policy = await readLivePolicy({ store: input.store, log: input.log, bindingId: run.bindingId });
    const gate = policy.readable ? judgeActorPolicy({ run, allowedUsers: policy.allowedUsers }) : unreadablePolicyRefusal(run, policy.cause);
    if (!gate.admitted) {
      return await refusedReserve({
        call: input,
        run,
        refusal: gate.refused.refusal,
        actor: gate.refused.actor
      });
    }
    const lease = run.lease;
    const dispatchToken = buildDispatchToken(run.runKey, run.attempt);
    const resultDeadlineAt = new Date(Date.parse(now) + deadlineMs).toISOString();
    const starting = reservedRun({ run, dispatchToken, resultDeadlineAt, actorPolicy: gate.policy, now });
    await persist(starting);
    return {
      status: "applied",
      run: starting,
      dispatchToken,
      tokenExpiresAt: lease.expiresAt,
      resultDeadlineAt,
      auditWritten: await appendRunRow({
        store: input.store,
        log: input.log,
        correlationId: starting.correlationId,
        row: reservedRow({ run: starting, leaseId: lease.leaseId, dispatchToken })
      })
    };
  });
}

// service/poll/dispatch-block.ts
var BLOCKED_REASONS = new Set([
  "project-missing",
  "binding-missing",
  "credential",
  "policy",
  ACTOR_BLOCKED_REASON
]);
var INVALID_TRANSITION2 = "invalid-transition";
function judgeBlock(input) {
  const { run } = input;
  const lease = judgeLease(input);
  if (lease !== null) {
    return lease;
  }
  if (runHistoryIndicatesSession(run)) {
    const sessionId = sessionIdOf(run);
    return refuse3(INVALID_TRANSITION2, sessionId === null ? "this run already produced a session and cannot be blocked" : `this run already produced session ${sessionId} and cannot be blocked`);
  }
  return run.state === "claimed" ? null : refuse3(INVALID_TRANSITION2, `this run is ${run.state}; only a claimed run can be blocked`);
}
function blockedRun(input) {
  const { run, blockedReason, detail, now } = input;
  return {
    ...run,
    state: `blocked:${blockedReason}`,
    stateReason: detail,
    lease: null,
    attempts: attemptHistory(run, {
      ...currentAttempt(run),
      outcome: "blocked",
      reason: detail,
      resultReportedAt: now
    }),
    updatedAt: now
  };
}
async function appendBlockRow(input) {
  const { input: block, run, priorState } = input;
  return await appendRunRow({
    store: block.store,
    log: block.log,
    correlationId: run.correlationId,
    row: blockedRow({
      run,
      blockedReason: block.blockedReason,
      priorState,
      guidance: block.guidance
    })
  });
}
async function blockDispatch(input) {
  return await operateRun(input, async ({ run, now, persist }) => {
    const refusal = judgeBlock({ run, leaseId: input.leaseId, attempt: input.attempt, now });
    if (refusal !== null) {
      return {
        status: "refused",
        refusal,
        run,
        auditWritten: await appendRefusalRow({
          store: input.store,
          log: input.log,
          refusal: {
            run,
            operation: "blocked",
            refusal,
            attempt: input.attempt,
            leaseId: input.leaseId
          }
        })
      };
    }
    const priorState = run.state;
    const blocked = blockedRun({ run, blockedReason: input.blockedReason, detail: input.detail, now });
    await persist(blocked);
    return {
      status: "applied",
      run: blocked,
      auditWritten: await appendBlockRow({ input, run: blocked, priorState })
    };
  });
}

// service/poll/dispatch-report.ts
var INVALID_TRANSITION3 = "invalid-transition";
var STALE_TOKEN_MESSAGE = "the dispatch token is unknown, superseded, or already consumed by another attempt";
function repeatedOutcome(input) {
  const { run, outcome } = input;
  const recorded = currentAttempt(run);
  if (recorded.outcome !== outcome.attemptOutcome) {
    return false;
  }
  return outcome.sessionId === null ? recorded.reason === outcome.reason && run.state === "failed" : recorded.sessionId === outcome.sessionId && sessionIdOf(run) === outcome.sessionId;
}
function conflict(run) {
  const sessionId = sessionIdOf(run);
  return refuse3(INVALID_TRANSITION3, sessionId === null ? "a different outcome is already recorded for this attempt and cannot be replaced" : `this attempt already reported session ${sessionId}; a different outcome cannot replace it`);
}
function tokenSpent(run, dispatchToken) {
  const live = currentAttempt(run);
  return run.attempts.some((record) => record !== live && record.dispatchToken === dispatchToken && (record.resultReportedAt !== null || record.outcome !== null));
}
function judgeReport(input) {
  const { run, dispatchToken, attempt, outcome } = input;
  const stale = refuse3("stale-lease", STALE_TOKEN_MESSAGE);
  const { reservation } = run;
  if (reservation?.dispatchToken !== dispatchToken) {
    return { refusal: stale };
  }
  if (reservation.attempt !== run.attempt || attempt !== run.attempt) {
    return { refusal: stale };
  }
  if (reservation.consumed) {
    return repeatedOutcome({ run, outcome }) ? { verdict: "duplicate" } : { refusal: conflict(run) };
  }
  if (tokenSpent(run, dispatchToken)) {
    return { refusal: stale };
  }
  return run.state === "starting" || run.state === "unconfirmed" ? { verdict: "apply" } : {
    refusal: refuse3(INVALID_TRANSITION3, `this run is ${run.state}; an authorized outcome can only be reported while it is ` + "starting or unconfirmed")
  };
}
function closedAttempt(input) {
  return {
    ...input.attempt,
    outcome: input.outcome.attemptOutcome,
    sessionId: input.outcome.sessionId,
    reason: input.outcome.reason,
    resultReportedAt: input.now
  };
}
function reportedRun(input) {
  const { run, outcome, now } = input;
  const reservation = run.reservation;
  const { sessionId } = outcome;
  return {
    ...run,
    state: sessionId === null ? "failed" : "dispatched",
    stateReason: sessionId === null ? outcome.reason ?? "dispatch produced no session" : `session ${sessionId} created`,
    lease: null,
    reservation: { ...reservation, consumed: true },
    attempts: attemptHistory(run, closedAttempt({ attempt: currentAttempt(run), outcome, now })),
    ...sessionId !== null && { session: sessionRefOf({ run, sessionId, now }) },
    updatedAt: now
  };
}
function reportRow(input) {
  if (input.operation === "abandon") {
    return abandonedRow({
      run: input.run,
      dispatchToken: input.dispatchToken,
      reason: input.outcome.reason ?? ""
    });
  }
  return resultRow({
    run: input.run,
    dispatchToken: input.dispatchToken,
    sessionId: input.outcome.sessionId,
    problem: input.outcome.reason
  });
}
async function refusedReport(input) {
  const { target, run, operation, refusal, attempt, dispatchToken } = input;
  return {
    status: "refused",
    refusal,
    run,
    auditWritten: await appendRefusalRow({
      store: target.store,
      log: target.log,
      refusal: {
        run,
        operation,
        refusal,
        attempt,
        dispatchTokenFingerprint: buildDispatchTokenFingerprint(dispatchToken)
      }
    })
  };
}
async function duplicateReport(input, run) {
  return {
    status: "duplicate",
    run,
    auditWritten: await appendRunRow({
      store: input.store,
      log: input.log,
      correlationId: run.correlationId,
      row: duplicateReportRow({ run, dispatchToken: input.dispatchToken, state: run.state })
    })
  };
}
async function applyVerdict(input) {
  const { report, run, verdict, persist } = input;
  if ("refusal" in verdict) {
    return await refusedReport({
      target: report,
      run,
      operation: report.operation,
      refusal: verdict.refusal,
      attempt: report.attempt,
      dispatchToken: report.dispatchToken
    });
  }
  if (verdict.verdict === "duplicate") {
    return await duplicateReport(report, run);
  }
  const settled2 = reportedRun({ run, outcome: report.outcome, now: report.now ?? run.updatedAt });
  await persist(settled2);
  const wasAppended = await appendRunRow({
    store: report.store,
    log: report.log,
    correlationId: settled2.correlationId,
    row: reportRow({
      run: settled2,
      dispatchToken: report.dispatchToken,
      outcome: report.outcome,
      operation: report.operation
    })
  });
  return { status: "applied", run: settled2, auditWritten: wasAppended };
}
async function reportDispatch(input) {
  return await operateRun(input, async ({ run, now, persist }) => {
    const report = { ...input, now };
    const verdict = judgeReport({
      run,
      dispatchToken: input.dispatchToken,
      attempt: input.attempt,
      outcome: input.outcome
    });
    return await applyVerdict({ report, run, verdict, persist });
  });
}

// service/routes/run-scope.ts
var MAX_CORRELATION_ID_CHARS = 64;
var CORRELATION_ID_PATTERN = /^mt-run-[0-9a-f]{24}$/;
var LEASE_ID_PATTERN = /^lse-[0-9a-f]{24}$/;
var DISPATCH_TOKEN_PATTERN = /^dtk-[0-9a-f]{32}$/;
var RUN_SCOPE_PREFIX = "/v1/events/:correlationId";
function pathCorrelationId(raw) {
  if (raw === undefined || raw.length === 0 || raw.length > MAX_CORRELATION_ID_CHARS) {
    return null;
  }
  return CORRELATION_ID_PATTERN.test(raw) ? raw : null;
}
var BODY_REMEDIATION = "send a JSON object carrying the run identity and attempt";
var ECHO_REMEDIATION = "echo the run correlation id exactly as the path names it";
function isBodyObject(raw) {
  return raw === undefined || typeof raw === "object" && raw !== null && !Array.isArray(raw);
}
function echoIssue(record, correlationId) {
  return record.correlationId === correlationId ? null : { field: "correlationId", remediation: ECHO_REMEDIATION };
}
function readMember(value, pattern) {
  return typeof value === "string" && pattern.test(value) ? value : null;
}
function requiredMember(input) {
  const value = readMember(input.record[input.name], input.pattern);
  if (value === null && input.required) {
    input.issues.push({ field: input.name, remediation: input.remediation });
  }
  return value;
}
function parseRunScopeRequest(input) {
  const { raw, correlationId, needs } = input;
  const isStructured = isBodyObject(raw) && raw !== undefined;
  const record = isStructured ? raw : {};
  const issues = [];
  if (raw !== undefined && !isStructured) {
    issues.push({ field: "body", remediation: BODY_REMEDIATION });
  }
  const echo = echoIssue(record, correlationId);
  if (echo !== null) {
    issues.push(echo);
  }
  const { attempt } = record;
  if (typeof attempt !== "number" || !Number.isSafeInteger(attempt) || attempt < 1) {
    issues.push({ field: "attempt", remediation: "send the attempt number this run is on, as a whole number" });
  }
  const leaseId = requiredMember({
    record,
    name: "leaseId",
    pattern: LEASE_ID_PATTERN,
    remediation: "send the lease id this run was claimed under",
    required: needs.leaseId === true,
    issues
  });
  const dispatchToken = requiredMember({
    record,
    name: "dispatchToken",
    pattern: DISPATCH_TOKEN_PATTERN,
    remediation: "send the dispatch token this run was authorized with",
    required: needs.dispatchToken === true,
    issues
  });
  return { correlationId, attempt, leaseId, dispatchToken, fields: record, issues };
}
function readRunScopeRequest(input) {
  const { raw, correlationId, needs } = input;
  const parsed = parseRunScopeRequest({ raw, correlationId, needs });
  if (parsed.issues.length > 0) {
    return validationResponse(parsed.issues);
  }
  const { leaseId, dispatchToken, attempt, fields } = parsed;
  return { correlationId, attempt, leaseId, dispatchToken, fields };
}
function readRunScopeBody(input) {
  const { raw, correlationId } = input;
  const isStructured = isBodyObject(raw) && raw !== undefined;
  const record = isStructured ? raw : {};
  const issues = [];
  if (raw !== undefined && !isStructured) {
    issues.push({ field: "body", remediation: BODY_REMEDIATION });
  }
  const echo = echoIssue(record, correlationId);
  if (echo !== null) {
    issues.push(echo);
  }
  return issues.length > 0 ? validationResponse(issues) : { fields: record };
}
function isRefusal(parsed) {
  return "status" in parsed;
}

// service/routes/run-answer.ts
var REFUSAL_STATUS = new Map([
  ["unknown-run", STATUS.notFound],
  ["stale-lease", STATUS.conflict],
  ["already-reserved", STATUS.conflict],
  ["already-dispatched", STATUS.conflict],
  ["invalid-transition", STATUS.conflict],
  ["actor-not-allowed", STATUS.conflict],
  ["cause-not-cleared", STATUS.conflict],
  ["validation", STATUS.validation]
]);
function unknownRunResponse() {
  return errorResponse(STATUS.notFound, {
    code: "unknown-run",
    message: "no run carries this correlation id; refresh, it may have been evicted"
  });
}
function runOutcomeResponse(input) {
  const { context, operation, outcome, success } = input;
  if (outcome.status === "not-found") {
    return unknownRunResponse();
  }
  if (!outcome.auditWritten && outcome.run !== null) {
    context.log.warn("dispatch operation could not record its row", {
      correlationId: outcome.run.correlationId,
      operation,
      outcome: outcome.status
    });
  }
  if (outcome.status === "refused") {
    const { code, message, referenceWindow } = outcome.refusal;
    return errorResponse(REFUSAL_STATUS.get(code) ?? STATUS.conflict, {
      code,
      message,
      ...referenceWindow !== undefined && { referenceWindow }
    });
  }
  return { status: STATUS.ok, body: success(outcome.run, outcome.auditWritten) };
}
function runAnswer(input) {
  return {
    correlationId: input.correlationId,
    attempt: input.run.attempt,
    state: input.run.state,
    auditWritten: input.auditWritten
  };
}
var UNREADABLE_BODY_REASON = "the request did not validate";
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function refusalReason(response) {
  const { body } = response;
  if (!isRecord2(body) || !isRecord2(body.error)) {
    return UNREADABLE_BODY_REASON;
  }
  const { message } = body.error;
  return typeof message === "string" && message.length > 0 ? message : UNREADABLE_BODY_REASON;
}
async function refuseRunRequest(input) {
  const { context, correlationId, operation, response } = input;
  const { store } = context;
  if (store !== null) {
    const reason = refusalReason(response);
    await operateRun({ store, log: context.log, correlationId }, async ({ run }) => await appendRefusalRow({
      store,
      log: context.log,
      refusal: { run, operation, refusal: refuse3("validation", reason), attempt: run.attempt }
    }));
  }
  return response;
}

// service/routes/run-fields.ts
var MAX_BODY_TEXT_CHARS = 1000;
var SESSION_ID_PATTERN = /^ses_[A-Za-z0-9._~-]+$/;
var MAX_SESSION_ID_CHARS = 128;
function textMember(value, bound = MAX_BODY_TEXT_CHARS) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 || trimmed.length > bound ? null : trimmed;
}
function baselineMember(value, bound = MAX_BODY_TEXT_CHARS) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > bound ? null : trimmed;
}
var PROVENANCE_SHAPE_FIX = "send one of configured, defaulted, unset — where the comparison baseline came from";
var BASELINE_PROVENANCES = ["configured", "defaulted", "unset"];
function provenanceMember(value) {
  return BASELINE_PROVENANCES.find((candidate) => candidate === value) ?? null;
}
function provenanceIssue(provenance, expectedAgent) {
  const isConfigured = provenance === "configured";
  const hasBaseline = expectedAgent !== "";
  if (isConfigured !== hasBaseline) {
    return {
      field: "baselineProvenance",
      remediation: "send 'configured' with a non-blank expectedAgent, " + "or 'defaulted' or 'unset' with an empty one"
    };
  }
  return null;
}
function readProvenance(fields, expectedAgent) {
  const provenance = provenanceMember(fields.baselineProvenance);
  if (provenance === null) {
    return { field: "baselineProvenance", remediation: PROVENANCE_SHAPE_FIX };
  }
  return provenanceIssue(provenance, expectedAgent) ?? provenance;
}
function flagMember(value, isAbsent) {
  return typeof value === "boolean" ? value : isAbsent;
}
function sessionIdIssue(value) {
  if (value === null) {
    return null;
  }
  if (value.length > MAX_SESSION_ID_CHARS || !SESSION_ID_PATTERN.test(value)) {
    return {
      field: "sessionId",
      remediation: "send the session id the host minted: ses_ followed by at most " + `${MAX_SESSION_ID_CHARS} path-safe characters`
    };
  }
  return null;
}
function overLongTextResponse(fields, names) {
  const issues = [];
  for (const name of names) {
    const value = fields[name];
    if (typeof value === "string" && value.trim().length > MAX_BODY_TEXT_CHARS) {
      issues.push({ field: name, remediation: `send at most ${MAX_BODY_TEXT_CHARS} characters` });
    }
  }
  return issues.length > 0 ? validationResponse(issues) : null;
}

// service/routes/dispatch.ts
var RESERVE_PATH = `${RUN_SCOPE_PREFIX}/reserve`;
var DISPATCHED_PATH = `${RUN_SCOPE_PREFIX}/dispatched`;
var ABANDON_PATH = `${RUN_SCOPE_PREFIX}/abandon`;
var BLOCKED_PATH = `${RUN_SCOPE_PREFIX}/blocked`;
async function handleReserve(context, request) {
  const { store } = context;
  if (store === null) {
    return storageUnavailableResponse();
  }
  const correlationId = pathCorrelationId(request.params.correlationId);
  if (correlationId === null) {
    return unknownRunResponse();
  }
  const parsed = readRunScopeRequest({ raw: request.body, correlationId, needs: { leaseId: true } });
  if (isRefusal(parsed)) {
    return await refuseRunRequest({ context, operation: "reserve", correlationId, response: parsed });
  }
  const reserved = await reserveDispatch({
    store,
    log: context.log,
    correlationId,
    leaseId: parsed.leaseId,
    attempt: parsed.attempt
  });
  return runOutcomeResponse({ context, operation: "reserve", outcome: reserved, success: (run, auditWritten) => ({
    ...runAnswer({ correlationId, run, auditWritten }),
    dispatchToken: reserved.status === "applied" ? reserved.dispatchToken : null,
    tokenExpiresAt: reserved.status === "applied" ? reserved.tokenExpiresAt : null,
    resultDeadlineAt: reserved.status === "applied" ? reserved.resultDeadlineAt : null
  }) });
}
function readResultOutcome(fields) {
  const sessionId = textMember(fields.sessionId);
  const problem = textMember(fields.problem);
  const hasSession = sessionId !== null;
  const hasProblem = problem !== null;
  if (hasSession === hasProblem) {
    return {
      ok: false,
      response: errorResponse(STATUS.validation, {
        code: "validation",
        message: "report exactly one outcome: the session that was created, " + "or the problem that prevented one"
      })
    };
  }
  const sessionIssue = sessionIdIssue(sessionId);
  return sessionIssue === null ? { ok: true, sessionId, problem } : { ok: false, response: validationResponse([sessionIssue]) };
}
async function handleDispatched(context, request) {
  const { store } = context;
  if (store === null) {
    return storageUnavailableResponse();
  }
  const correlationId = pathCorrelationId(request.params.correlationId);
  if (correlationId === null) {
    return unknownRunResponse();
  }
  const parsed = readRunScopeRequest({ raw: request.body, correlationId, needs: { dispatchToken: true } });
  if (isRefusal(parsed)) {
    return await refuseRunRequest({ context, operation: "result", correlationId, response: parsed });
  }
  const report = readResultOutcome(parsed.fields);
  if (!report.ok) {
    return await refuseRunRequest({ context, operation: "result", correlationId, response: report.response });
  }
  const reported = await reportDispatch({
    store,
    log: context.log,
    correlationId,
    dispatchToken: parsed.dispatchToken,
    attempt: parsed.attempt,
    operation: "result",
    outcome: {
      attemptOutcome: report.sessionId === null ? "failed" : "dispatched",
      sessionId: report.sessionId,
      reason: report.problem
    }
  });
  return runOutcomeResponse({ context, operation: "result", outcome: reported, success: (run, auditWritten) => runAnswer({ correlationId, run, auditWritten }) });
}
async function handleAbandon(context, request) {
  const { store } = context;
  if (store === null) {
    return storageUnavailableResponse();
  }
  const correlationId = pathCorrelationId(request.params.correlationId);
  if (correlationId === null) {
    return unknownRunResponse();
  }
  const parsed = readRunScopeRequest({ raw: request.body, correlationId, needs: { dispatchToken: true } });
  if (isRefusal(parsed)) {
    return await refuseRunRequest({ context, operation: "abandon", correlationId, response: parsed });
  }
  const reason = textMember(parsed.fields.reason);
  if (reason === null) {
    return await refuseRunRequest({
      context,
      operation: "abandon",
      correlationId,
      response: errorResponse(STATUS.validation, {
        code: "validation",
        message: "reason: say why the reserved attempt was abandoned, so the failure row is readable"
      })
    });
  }
  const abandoned = await reportDispatch({
    store,
    log: context.log,
    correlationId,
    dispatchToken: parsed.dispatchToken,
    attempt: parsed.attempt,
    operation: "abandon",
    outcome: { attemptOutcome: "abandoned", sessionId: null, reason }
  });
  return runOutcomeResponse({ context, operation: "abandon", outcome: abandoned, success: (run, auditWritten) => runAnswer({ correlationId, run, auditWritten }) });
}
function readBlockReport(fields) {
  const guidance = textMember(fields.guidance);
  const overlong = overLongTextResponse(fields, ["guidance"]);
  const blockedReason = textMember(fields.blockedReason);
  const detail = textMember(fields.detail);
  if (blockedReason === null || detail === null || !BLOCKED_REASONS.has(blockedReason)) {
    return {
      ok: false,
      response: errorResponse(STATUS.validation, {
        code: "validation",
        message: `blockedReason: name one of ${[...BLOCKED_REASONS].join(", ")}; detail: describe the cause`
      })
    };
  }
  if (overlong !== null) {
    return { ok: false, response: overlong };
  }
  return { ok: true, blockedReason, detail, guidance };
}
async function handleBlocked(context, request) {
  const { store } = context;
  if (store === null) {
    return storageUnavailableResponse();
  }
  const correlationId = pathCorrelationId(request.params.correlationId);
  if (correlationId === null) {
    return unknownRunResponse();
  }
  const parsed = readRunScopeRequest({ raw: request.body, correlationId, needs: { leaseId: true } });
  if (isRefusal(parsed)) {
    return await refuseRunRequest({ context, operation: "blocked", correlationId, response: parsed });
  }
  const report = readBlockReport(parsed.fields);
  if (!report.ok) {
    return await refuseRunRequest({ context, operation: "blocked", correlationId, response: report.response });
  }
  const blocked = await blockDispatch({
    store,
    log: context.log,
    correlationId,
    leaseId: parsed.leaseId,
    attempt: parsed.attempt,
    blockedReason: report.blockedReason,
    detail: report.detail,
    guidance: report.guidance
  });
  return runOutcomeResponse({ context, operation: "blocked", outcome: blocked, success: (run, auditWritten) => runAnswer({ correlationId, run, auditWritten }) });
}
var reserveRoute = {
  method: "POST",
  path: RESERVE_PATH,
  handler: (context, request) => handleReserve(context, request)
};
var dispatchedRoute = {
  method: "POST",
  path: DISPATCHED_PATH,
  handler: (context, request) => handleDispatched(context, request)
};
var abandonRoute = {
  method: "POST",
  path: ABANDON_PATH,
  handler: (context, request) => handleAbandon(context, request)
};
var blockedRoute = {
  method: "POST",
  path: BLOCKED_PATH,
  handler: (context, request) => handleBlocked(context, request)
};

// service/routes/bindings.ts
var BINDINGS_PATH = "/v1/bindings";
function withEffectiveScopes(bindings) {
  return bindings.map((binding) => ({ ...binding, historyScope: effectiveHistoryScope(binding.historyScope) }));
}
async function handleGetBindings(context) {
  const { store } = context;
  if (store === null) {
    return storageUnavailableResponse();
  }
  const stored = await readBindings({ store, log: context.log });
  const { overlapMs } = await readCycleConfig({ store, log: context.log });
  const status = await readStatusRows({ store, log: context.log, bindings: stored, overlapMs });
  return { status: STATUS.ok, body: { bindings: withEffectiveScopes(stored), status } };
}
function omittedMemberIds(submitted) {
  const prompt = new Set;
  const historyScope = new Set;
  for (const entry of submitted) {
    if (!isRecord(entry)) {
      continue;
    }
    const { bindingId } = entry;
    if (typeof bindingId !== "string") {
      continue;
    }
    if (!Object.hasOwn(entry, "startingPrompt")) {
      prompt.add(bindingId);
    }
    if (!Object.hasOwn(entry, "historyScope")) {
      historyScope.add(bindingId);
    }
  }
  return { prompt, historyScope };
}
function mergeOmittedMembers(input) {
  const storedById = new Map(input.stored.map((binding) => [binding.bindingId, binding]));
  return input.submitted.map((binding) => {
    const isPromptKept = input.omittedPrompt.has(binding.bindingId);
    const isScopeKept = input.omittedScope.has(binding.bindingId);
    if (!isPromptKept && !isScopeKept) {
      return binding;
    }
    const previous = storedById.get(binding.bindingId);
    return {
      ...binding,
      ...isPromptKept && previous?.startingPrompt !== undefined && { startingPrompt: previous.startingPrompt },
      ...isScopeKept && previous?.historyScope !== undefined && { historyScope: previous.historyScope }
    };
  });
}
async function armCatchUps(input) {
  const before = new Map(input.stored.map((binding) => [binding.bindingId, binding]));
  const moved = input.written.filter((binding) => effectiveHistoryScope(binding.historyScope) === "recent-history" && effectiveHistoryScope(before.get(binding.bindingId)?.historyScope) !== "recent-history");
  if (moved.length === 0) {
    return 0;
  }
  const lookBack = lookBackMs();
  if (lookBack === null) {
    input.log.warn("history-mode catch-up was not armed: the declared look-back is outside its own bound");
    return 0;
  }
  const armedFrom = new Date(Date.parse(input.at) - lookBack).toISOString();
  return await serializeScan(async () => {
    const state = await readScanState(input);
    let next = state;
    let armed = 0;
    for (const binding of moved) {
      const slot = bindingScanOf(state, binding.bindingId);
      if (slot.lastScanAt === null) {
        continue;
      }
      next = withBindingScanState({
        state: next,
        bindingId: binding.bindingId,
        slot: { ...slot, rescanFrom: armedFrom }
      });
      armed += 1;
    }
    if (armed > 0) {
      await writeScanState({ store: input.store, state: next });
    }
    return armed;
  });
}
async function readCustodyAndValidate(input) {
  const accounts = await listAccountsUnobserved(input.store, input.log);
  const known = new Set(accounts.map((account) => account.numericUserId));
  return {
    accounts,
    validation: validateBindings({
      raw: input.body,
      hasAccount: (numericUserId) => known.has(numericUserId)
    })
  };
}
async function writeGrant(input) {
  const { store, log, submitted, omittedPrompt, omittedScope, at } = input;
  return await inQueueChain(async () => await runPromptChain(store, async () => await runHistoryScopeChain(store, async () => {
    const stored = await readBindingsUnobserved({ store, log });
    await recordPromptChanges({ store, log, bindings: stored, actor: "service" });
    await recordHistoryScopeChanges({ store, log, bindings: stored, actor: "service" });
    const merged = mergeOmittedMembers({ submitted, omittedPrompt, omittedScope, stored });
    await writeBindings({ store, bindings: merged });
    await recordPromptChanges({ store, log, bindings: merged, actor: "operator" });
    await recordHistoryScopeChanges({ store, log, bindings: merged, actor: "operator" });
    await armCatchUps({ store, log, written: merged, stored, at });
    return merged;
  })));
}
async function handlePutBindings(context, request) {
  const { store } = context;
  if (store === null) {
    return storageUnavailableResponse();
  }
  if (typeof request.body !== "object" || request.body === null || Array.isArray(request.body)) {
    return errorResponse(STATUS.validation, {
      code: "validation",
      message: "body: send `{ bindings: [...] }` holding every binding the panel keeps"
    });
  }
  const custody = await readCustodyAndValidate({ store, log: context.log, body: request.body });
  if (!custody.validation.ok) {
    return validationResponse(custody.validation.issues);
  }
  await observeAccountPromptChanges({
    store,
    log: context.log,
    accounts: custody.accounts,
    complete: true,
    actor: "service"
  });
  const omitted = omittedMemberIds(request.body.bindings);
  const bindings = await writeGrant({
    store,
    log: context.log,
    submitted: custody.validation.bindings,
    omittedPrompt: omitted.prompt,
    omittedScope: omitted.historyScope,
    at: nowIso()
  });
  const { overlapMs } = await readCycleConfig({ store, log: context.log });
  const status = await readStatusRows({ store, log: context.log, bindings, overlapMs });
  return { status: STATUS.ok, body: { bindings, status } };
}
var bindingsRoute = {
  method: "GET",
  path: BINDINGS_PATH,
  handler: (context) => handleGetBindings(context)
};
var putBindingsRoute = {
  method: "PUT",
  path: BINDINGS_PATH,
  handler: (context, request) => handlePutBindings(context, request)
};

// service/routes/health.ts
var SERVICE_VERSION = "0.0.1";
function healthResponse(context) {
  return {
    status: STATUS.ok,
    body: { status: "ok", version: SERVICE_VERSION, schemaVersion: context.schemaVersion }
  };
}
var healthRoute = {
  method: "GET",
  path: "/health",
  handler: (context) => healthResponse(context)
};

// service/poll/run-corroborate.ts
var CAUSE_NOT_CLEARED = "cause-not-cleared";
var CORROBORATED_BINDING_REASON = "binding-missing";
var ACTOR_BLOCKED_REASON2 = "actor-not-allowed";
var CORROBORATED_BLOCKED_REASONS = new Set([
  CORROBORATED_BINDING_REASON,
  ACTOR_BLOCKED_REASON2
]);
function judgeActorCause(input) {
  const { run, bindings } = input;
  const binding = bindings.find((candidate) => candidate.bindingId === run.bindingId);
  const gate = binding === undefined ? { admitted: false } : judgeActorPolicy({ run, allowedUsers: binding.allowedUsers });
  if (gate.admitted) {
    return "corroborated";
  }
  return refuse3(CAUSE_NOT_CLEARED, run.referencesTruncated ? "the cause has not cleared: this run's source reference list was cut at " + `${run.sourceReferences.length} of ${run.referenceCount} triggers, so binding ` + `${run.bindingId}'s allow-list is judged against an incomplete list, and adding a login cannot ` + "clear it" : `the cause has not cleared: the allow-list for binding ${run.bindingId} still admits none of this ` + "run's attributed actors");
}

// service/poll/run-operate.ts
var INVALID_TRANSITION4 = "invalid-transition";
function invalidTransition(state) {
  const messages = new Map([
    ["pending", "this run is already waiting for a panel"],
    ["dispatched", "this run is already dispatched; a dispatched run cannot be retried"],
    ["unconfirmed", "this run is unconfirmed; resolve it instead, a retry would discard the evidence"],
    ["claimed", "an attempt is in flight; this run holds a live claim"],
    ["starting", "an attempt is in flight; this run is already authorized to start"],
    ["dead-lettered", "this run is dead-lettered; use return-to-waiting, which resets the attempt count"]
  ]);
  return refuse3(INVALID_TRANSITION4, messages.get(state) ?? `this run is ${state}; it cannot be retried`);
}
async function refused(input) {
  const { run, operation, refusal, store, log } = input;
  return {
    status: "refused",
    refusal,
    run,
    auditWritten: await appendRefusalRow({
      store,
      log,
      refusal: { run, operation, refusal, attempt: run.attempt }
    })
  };
}
function judgeRetry(input) {
  const { run, causeCleared, bindings } = input;
  if (input.attempt !== run.attempt) {
    return refuse3(STALE_LEASE_CODE, staleAttemptMessage(input.attempt, run.attempt));
  }
  if (run.state === "failed") {
    return null;
  }
  if (!run.state.startsWith("blocked:")) {
    return invalidTransition(run.state);
  }
  const blockedReason = run.state.slice("blocked:".length);
  if (!CORROBORATED_BLOCKED_REASONS.has(blockedReason)) {
    return causeCleared ? "reported" : refuse3(CAUSE_NOT_CLEARED, `the cause has not cleared: report the ${blockedReason} cause as cleared once it is, so this ` + "row records what was checked");
  }
  if (blockedReason === CORROBORATED_BINDING_REASON) {
    return bindings.some((binding) => binding.bindingId === run.bindingId) ? "corroborated" : refuse3(CAUSE_NOT_CLEARED, `the cause has not cleared: the binding ${run.bindingId} is still absent`);
  }
  return judgeActorCause({ run, bindings });
}
function waitingRun(input) {
  const { run, now } = input;
  return {
    ...run,
    state: "pending",
    stateReason: null,
    attempt: run.attempt + 1,
    lease: null,
    reservation: null,
    updatedAt: now
  };
}
async function appendRetryRow(input) {
  const { run, store, log, ...rest } = input;
  return await appendRunRow({
    store,
    log,
    correlationId: run.correlationId,
    row: retryRow({
      run,
      ...rest,
      attemptAfter: run.attempt
    })
  });
}
async function retryDispatch(input) {
  const bindings = await readBindings({ store: input.store, log: input.log });
  return await operateRun(input, async ({ run, now, persist }) => {
    const verdict = judgeRetry({
      run,
      attempt: input.attempt,
      causeCleared: input.causeCleared,
      bindings
    });
    if (verdict !== null && typeof verdict === "object") {
      return await refused({ ...input, run, operation: "retry", refusal: verdict });
    }
    const source = verdict;
    const priorState = run.state;
    const attemptBefore = run.attempt;
    const retried = waitingRun({ run, now });
    await persist(retried);
    return { status: "applied", run: retried, auditWritten: await appendRetryRow({
      store: input.store,
      log: input.log,
      run: retried,
      priorState,
      attemptBefore,
      causeReportedCleared: priorState.startsWith("blocked:") ? input.causeCleared : null,
      causeClearedSource: source,
      reset: false,
      causeReport: input.causeReport
    }) };
  });
}
async function requeueDispatch(input) {
  return await operateRun(input, async ({ run, now, persist }) => {
    if (run.state !== "dead-lettered") {
      return await refused({
        ...input,
        run,
        operation: "requeue",
        refusal: refuse3(INVALID_TRANSITION4, `this run is ${run.state}; only a dead-lettered run can be returned to waiting`)
      });
    }
    const attemptBefore = run.attempt;
    const waiting = {
      ...run,
      state: "pending",
      stateReason: null,
      attempt: 1,
      requeuesUsed: 0,
      lease: null,
      reservation: null,
      updatedAt: now
    };
    await persist(waiting);
    return { status: "applied", run: waiting, auditWritten: await appendRetryRow({
      store: input.store,
      log: input.log,
      run: waiting,
      priorState: run.state,
      attemptBefore,
      causeReportedCleared: null,
      causeClearedSource: null,
      reset: true,
      causeReport: null
    }) };
  });
}
function judgeResolve(input) {
  const { run } = input;
  if (run.state === "unconfirmed") {
    return runHistoryIndicatesSession(run) ? refuse3(INVALID_TRANSITION4, "this run already records a session and cannot be resolved") : null;
  }
  return refuse3(INVALID_TRANSITION4, `this run is ${run.state}; only an unconfirmed run can be resolved`);
}
function resolvedRun(input) {
  const { run, sessionId, now } = input;
  if (sessionId === null) {
    return {
      ...run,
      state: "pending",
      stateReason: null,
      attempt: run.attempt + 1,
      lease: null,
      reservation: null,
      updatedAt: now
    };
  }
  return {
    ...run,
    state: "dispatched",
    stateReason: `operator confirmed session ${sessionId}`,
    reservation: run.reservation === null ? null : { ...run.reservation, consumed: true },
    attempts: attemptHistory(run, {
      ...currentAttempt(run),
      outcome: "dispatched",
      sessionId,
      resultReportedAt: now
    }),
    session: sessionRefOf({ run, sessionId, now }),
    updatedAt: now
  };
}
async function resolveDispatch(input) {
  return await operateRun(input, async ({ run, now, persist }) => {
    const refusal = judgeResolve({ run });
    if (refusal !== null) {
      return await refused({ ...input, run, operation: "resolve", refusal });
    }
    const priorState = run.state;
    const resolved = resolvedRun({ run, sessionId: input.sessionId, now });
    await persist(resolved);
    return {
      status: "applied",
      run: resolved,
      auditWritten: await appendRunRow({
        store: input.store,
        log: input.log,
        correlationId: resolved.correlationId,
        row: resolvedRow({
          run: resolved,
          priorState,
          decision: input.sessionId === null ? "no-session" : "dispatched",
          note: input.note,
          guidance: input.guidance
        })
      })
    };
  });
}

// service/poll/run-verify.ts
var INVALID_TRANSITION5 = "invalid-transition";
function judgeVerification(input) {
  const { run, attempt, sessionId } = input;
  if (attempt !== run.attempt) {
    return refuse3(STALE_LEASE_CODE, staleAttemptMessage(attempt, run.attempt));
  }
  if (run.session === null) {
    return refuse3(INVALID_TRANSITION5, `this run is ${run.state} and records no session, so there is nothing to read back`);
  }
  return run.session.sessionId === sessionId ? null : refuse3(INVALID_TRANSITION5, "the reported session is not the session this run recorded");
}
async function recordVerification(input) {
  return await operateRun(input, async ({ run, now, persist }) => {
    const refusal = judgeVerification({ run, attempt: input.attempt, sessionId: input.sessionId });
    if (refusal !== null) {
      return await refused({ ...input, run, operation: "verification", refusal });
    }
    const { observedAgent, expectedAgent, ok, note } = input;
    const verification = { observedAgent, expectedAgent, ok, note, at: now };
    const read = { ...run, verification, updatedAt: now };
    await persist(read);
    return {
      status: "applied",
      run: read,
      auditWritten: await appendRunRow({
        store: input.store,
        log: input.log,
        correlationId: read.correlationId,
        row: verificationRow({ run: read, verification, baselineProvenance: input.baselineProvenance })
      })
    };
  });
}

// service/routes/run-ops.ts
var RETRY_PATH = `${RUN_SCOPE_PREFIX}/retry`;
var REQUEUE_PATH = `${RUN_SCOPE_PREFIX}/requeue`;
var RESOLVE_PATH = `${RUN_SCOPE_PREFIX}/resolve`;
var VERIFICATION_PATH = `${RUN_SCOPE_PREFIX}/verification`;
var RESOLVE_DECISIONS = new Set(["session-created", "no-session"]);
var SESSION_CREATED = "session-created";
function isResolveDecision(value) {
  return RESOLVE_DECISIONS.has(value);
}
function readResolution(fields) {
  const decision = textMember(fields.decision);
  if (decision === null || !isResolveDecision(decision)) {
    return {
      ok: false,
      response: errorResponse(STATUS.validation, {
        code: "validation",
        message: `decision: choose ${[...RESOLVE_DECISIONS].join(" or ")}`
      })
    };
  }
  const sessionId = textMember(fields.sessionId);
  if (decision === SESSION_CREATED && sessionId === null) {
    return {
      ok: false,
      response: errorResponse(STATUS.validation, {
        code: "validation",
        message: "sessionId: this dispatch did create a session, so name the session id to record"
      })
    };
  }
  if (decision !== SESSION_CREATED && sessionId !== null) {
    return {
      ok: false,
      response: errorResponse(STATUS.validation, {
        code: "validation",
        message: "sessionId: a no-session resolution reports that no session exists, so name exactly one " + "outcome — drop sessionId, or choose session-created to record it"
      })
    };
  }
  const sessionIssue = sessionIdIssue(sessionId);
  if (sessionIssue !== null) {
    return { ok: false, response: validationResponse([sessionIssue]) };
  }
  return {
    ok: true,
    decision,
    sessionId: decision === SESSION_CREATED ? sessionId : null
  };
}
async function handleRetry(context, request) {
  const { store } = context;
  if (store === null) {
    return storageUnavailableResponse();
  }
  const correlationId = pathCorrelationId(request.params.correlationId);
  if (correlationId === null) {
    return unknownRunResponse();
  }
  const parsed = readRunScopeRequest({ raw: request.body, correlationId, needs: {} });
  if (isRefusal(parsed)) {
    return await refuseRunRequest({ context, operation: "retry", correlationId, response: parsed });
  }
  const causeReport = textMember(parsed.fields.causeReport);
  const overlong = overLongTextResponse(parsed.fields, ["causeReport"]);
  if (overlong !== null) {
    return await refuseRunRequest({ context, operation: "retry", correlationId, response: overlong });
  }
  const retried = await retryDispatch({
    store,
    log: context.log,
    correlationId,
    attempt: parsed.attempt,
    causeCleared: flagMember(parsed.fields.causeCleared, false),
    causeReport
  });
  return runOutcomeResponse({
    context,
    operation: "retry",
    outcome: retried,
    success: (run, auditWritten) => runAnswer({ correlationId, run, auditWritten })
  });
}
async function handleRequeue(context, request) {
  const { store } = context;
  if (store === null) {
    return storageUnavailableResponse();
  }
  const correlationId = pathCorrelationId(request.params.correlationId);
  if (correlationId === null) {
    return unknownRunResponse();
  }
  const body = readRunScopeBody({ raw: request.body, correlationId });
  if (isRefusal(body)) {
    return await refuseRunRequest({ context, operation: "requeue", correlationId, response: body });
  }
  if (!flagMember(body.fields.confirm, false)) {
    return await refuseRunRequest({
      context,
      operation: "requeue",
      correlationId,
      response: errorResponse(STATUS.validation, {
        code: "validation",
        message: "confirm: returning a run to waiting resets its attempt count; confirm that explicitly"
      })
    });
  }
  const requeued = await requeueDispatch({ store, log: context.log, correlationId });
  return runOutcomeResponse({
    context,
    operation: "requeue",
    outcome: requeued,
    success: (run, auditWritten) => runAnswer({ correlationId, run, auditWritten })
  });
}
async function handleResolve(context, request) {
  const { store } = context;
  if (store === null) {
    return storageUnavailableResponse();
  }
  const correlationId = pathCorrelationId(request.params.correlationId);
  if (correlationId === null) {
    return unknownRunResponse();
  }
  const parsedBody = readRunScopeBody({ raw: request.body, correlationId });
  if (isRefusal(parsedBody)) {
    return await refuseRunRequest({ context, operation: "resolve", correlationId, response: parsedBody });
  }
  const { fields } = parsedBody;
  const resolution = readResolution(fields);
  if (!resolution.ok) {
    return await refuseRunRequest({ context, operation: "resolve", correlationId, response: resolution.response });
  }
  const note = textMember(fields.note);
  const guidance = textMember(fields.guidance);
  const overlong = overLongTextResponse(fields, ["note", "guidance"]);
  if (overlong !== null) {
    return await refuseRunRequest({ context, operation: "resolve", correlationId, response: overlong });
  }
  const resolved = await resolveDispatch({
    store,
    log: context.log,
    correlationId,
    decision: resolution.decision,
    sessionId: resolution.sessionId,
    note,
    guidance
  });
  return runOutcomeResponse({
    context,
    operation: "resolve",
    outcome: resolved,
    success: (run, auditWritten) => runAnswer({ correlationId, run, auditWritten })
  });
}
function readReportMembers(fields, expectedAgent) {
  const provenance = readProvenance(fields, expectedAgent);
  if (typeof provenance !== "string") {
    return validationResponse([provenance]);
  }
  const overlong = overLongTextResponse(fields, ["observedAgent", "note"]);
  if (overlong !== null) {
    return overlong;
  }
  return {
    baselineProvenance: provenance,
    observedAgent: textMember(fields.observedAgent),
    note: textMember(fields.note)
  };
}
function readReadBack(request, correlationId) {
  const parsed = readRunScopeRequest({ raw: request.body, correlationId, needs: {} });
  if (isRefusal(parsed)) {
    return parsed;
  }
  const { fields, attempt } = parsed;
  const overlongBaseline = overLongTextResponse(fields, ["expectedAgent"]);
  if (overlongBaseline !== null) {
    return overlongBaseline;
  }
  const sessionId = textMember(fields.sessionId);
  const expectedAgent = baselineMember(fields.expectedAgent);
  if (sessionId === null || expectedAgent === null) {
    return errorResponse(STATUS.validation, {
      code: "validation",
      message: "sessionId and expectedAgent: both are required to file a read-back against this run"
    });
  }
  const sessionIssue = sessionIdIssue(sessionId);
  if (sessionIssue !== null) {
    return validationResponse([sessionIssue]);
  }
  const members = readReportMembers(fields, expectedAgent);
  if ("status" in members) {
    return members;
  }
  return { attempt, sessionId, expectedAgent, ...members, ok: flagMember(fields.ok, false) };
}
async function handleVerification(context, request) {
  const { store } = context;
  if (store === null) {
    return storageUnavailableResponse();
  }
  const correlationId = pathCorrelationId(request.params.correlationId);
  if (correlationId === null) {
    return unknownRunResponse();
  }
  const readBack = readReadBack(request, correlationId);
  if ("status" in readBack) {
    return await refuseRunRequest({ context, operation: "verification", correlationId, response: readBack });
  }
  const recorded = await recordVerification({
    store,
    log: context.log,
    correlationId,
    ...readBack
  });
  return runOutcomeResponse({
    context,
    operation: "verification",
    outcome: recorded,
    success: (run, auditWritten) => ({
      ...runAnswer({ correlationId, run, auditWritten }),
      verification: run.verification === null ? null : {
        observedAgent: run.verification.observedAgent,
        expectedAgent: run.verification.expectedAgent,
        ok: run.verification.ok,
        note: run.verification.note
      }
    })
  });
}
var retryRunRoute = {
  method: "POST",
  path: RETRY_PATH,
  handler: (context, request) => handleRetry(context, request)
};
var requeueRunRoute = {
  method: "POST",
  path: REQUEUE_PATH,
  handler: (context, request) => handleRequeue(context, request)
};
var resolveRunRoute = {
  method: "POST",
  path: RESOLVE_PATH,
  handler: (context, request) => handleResolve(context, request)
};
var verificationRoute = {
  method: "POST",
  path: VERIFICATION_PATH,
  handler: (context, request) => handleVerification(context, request)
};

// service/poll/view.ts
function createPollingView() {
  let loop = null;
  let isStopping = false;
  const isRunning = () => !isStopping && loop !== null && !loop.state().stopped;
  const view = {
    isRunning: () => isRunning(),
    nextPollAtMs: () => isRunning() ? loop?.state().nextPollAtMs ?? null : null,
    isStopping: () => isStopping
  };
  return {
    view,
    observe: (next) => {
      loop = next;
    },
    beginShutdown: () => {
      isStopping = true;
    }
  };
}
function nextPollAtOf(view, intervalMs) {
  if (!view.isRunning()) {
    return null;
  }
  const armed = view.nextPollAtMs();
  return new Date(armed ?? Date.now() + intervalMs).toISOString();
}
function pausedReasonOf(input) {
  if (!input.storeUsable) {
    return "store-unavailable";
  }
  if (input.stopping) {
    return "stopping";
  }
  if (input.running) {
    return "";
  }
  return input.activeBindings > 0 ? "config-incomplete" : "no-active-bindings";
}

// service/routes/status.ts
var STATUS_PATH = "/v1/status";
function statusAccountRow(account) {
  return {
    numericUserId: account.numericUserId,
    login: account.login,
    connectionState: account.connectionState,
    rate: {
      remaining: null,
      limit: null,
      resetAt: null,
      usedLastHour: 0,
      secondaryBlockedUntil: null,
      conditionalSupport: "unknown",
      updatedAt: account.updatedAt
    },
    streams: []
  };
}
async function statusAccounts(context) {
  if (context.store === null) {
    return [];
  }
  try {
    const accounts = await listAccounts(context.store, context.log);
    return accounts.map((account) => statusAccountRow(account));
  } catch (error) {
    context.log.warn("accounts could not be listed for status", {
      errorKind: error instanceof Error ? error.name : typeof error
    });
    return [];
  }
}
async function storedBindings(context) {
  if (context.store === null) {
    return [];
  }
  try {
    return await readBindings({ store: context.store, log: context.log });
  } catch (error) {
    context.log.warn("bindings could not be listed for status", {
      errorKind: error instanceof Error ? error.name : typeof error
    });
    return [];
  }
}
function unreadableRepositoryRow(binding) {
  return {
    bindingId: binding.bindingId,
    repository: binding.repository,
    projectId: binding.projectId,
    accountLogin: binding.accountLogin,
    active: binding.state === "active",
    lastScanAt: null,
    lastError: null,
    pendingCount: 0,
    readable: false,
    actorPolicy: binding.allowedUsers === undefined ? "open" : "restricted"
  };
}
function mostRecentVerification(runs) {
  let freshest = null;
  for (const run of runs) {
    const { verification } = run;
    if (verification === null) {
      continue;
    }
    if (freshest === null || Date.parse(verification.at) >= Date.parse(freshest.at)) {
      freshest = verification;
    }
  }
  if (freshest === null) {
    return null;
  }
  return {
    observedAgent: freshest.observedAgent,
    expectedAgent: freshest.expectedAgent,
    ok: freshest.ok,
    at: freshest.at
  };
}
function notAvailableVerification() {
  return { available: false, reason: "no-service-mirror" };
}
async function runDerivedProjection(context, bindings, overlapMs) {
  const { store } = context;
  if (store === null) {
    return { repositories: [], verification: notAvailableVerification() };
  }
  try {
    const rows = await readStatusRows({ store, log: context.log, bindings, overlapMs });
    const document = await previewRunsDocument({ store, log: context.log });
    return {
      repositories: rows.map((row) => ({ ...row, readable: true })),
      verification: mostRecentVerification(document.runs)
    };
  } catch (error) {
    context.log.warn("run projection could not be read for status", {
      errorKind: error instanceof Error ? error.name : typeof error
    });
    return {
      repositories: bindings.map((binding) => unreadableRepositoryRow(binding)),
      verification: notAvailableVerification()
    };
  }
}
async function readConfig(context) {
  if (context.store === null) {
    return DEFAULT_CONFIG;
  }
  const result = await context.store.readJson(CONFIG_FILE, parseStoredConfig);
  return configFromStore(result, context.log).config;
}
async function buildStatusBody(context) {
  const config = await readConfig(context);
  const { store, polling } = context;
  const hasStore = store !== null;
  const accounts = await statusAccounts(context);
  const bindings = await storedBindings(context);
  const { repositories, verification } = await runDerivedProjection(context, bindings, config.overlapMs);
  const isRunning = hasStore && polling.isRunning();
  const activeBindings = bindings.filter((binding) => binding.state === "active").length;
  const pausedReason = pausedReasonOf({
    storeUsable: hasStore,
    running: isRunning,
    stopping: polling.isStopping(),
    activeBindings
  });
  return {
    service: {
      status: hasStore ? "ok" : "degraded",
      uptimeMs: Date.now() - context.startedAt,
      dataDir: context.dataDir,
      schemaVersion: store?.schemaVersion ?? null,
      storage: { writable: hasStore }
    },
    accounts,
    repositories,
    agentPin: { expectedAgent: null, lastVerification: verification },
    polling: {
      intervalMs: config.intervalMs,
      nextPollAt: nextPollAtOf(polling, config.intervalMs),
      paused: !isRunning,
      pausedReason
    },
    surface: { supported: true }
  };
}
async function handleGetStatus(context) {
  const body = await buildStatusBody(context);
  return { status: STATUS.ok, body };
}
var statusRoute = {
  method: "GET",
  path: STATUS_PATH,
  handler: (context) => handleGetStatus(context)
};

// service/routes/verify.ts
var VERIFY_PATH = "/v1/accounts/verify";
var LOGIN_MISMATCH_MESSAGE = "the token belongs to a different GitHub login than the expected one";
async function recordRejection(input) {
  const { deps, reason, identity, correlationId } = input;
  const entity = identity === null ? { kind: "service", id: "credential-handoff" } : { kind: "account", id: identity.numericUserId };
  const details = identity === null ? { reasonClass: reason } : { reasonClass: reason, login: identity.login };
  await appendAudit(deps.store, {
    eventType: "account.rejected",
    actorSource: "service",
    entity,
    decision: "reject",
    reason,
    correlationId,
    details
  });
}
async function refusalFor(attempt) {
  const { outcome, deps, correlationId } = attempt;
  if (outcome.kind === "rate-limited") {
    return githubRateLimitedResponse(outcome.retryAfterSeconds);
  }
  if (outcome.kind === "unavailable") {
    return upstreamUnavailableResponse(outcome.detail, correlationId);
  }
  if (outcome.kind === "rejected") {
    await recordRejection({ deps, reason: outcome.reason, identity: null, correlationId });
    return credentialRejectedResponse(outcome.reason, correlationId);
  }
  throw new Error("verify route received a successful outcome without a handler");
}
function reportRateBaseline(input) {
  const { deps, identity, baseline } = input;
  if (baseline === null) {
    deps.log.debug("rate baseline unavailable", { numericUserId: identity.numericUserId });
    return;
  }
  deps.log.info("rate baseline", {
    numericUserId: identity.numericUserId,
    limit: baseline.limit,
    remaining: baseline.remaining,
    resetAt: baseline.resetAt
  });
}
async function recordVerified(input) {
  const { deps, account, correlationId } = input;
  try {
    await appendAudit(deps.store, {
      eventType: "account.verified",
      actorSource: "service",
      entity: { kind: "account", id: account.numericUserId },
      decision: "accept",
      reason: "token verified against GitHub /user",
      correlationId,
      details: {
        login: account.login,
        scopeCheck: account.scopeCheck.results,
        redaction: { redacted: false, fields: [] }
      }
    });
  } catch (error) {
    deps.log.warn("account verified but the audit row could not be appended", {
      numericUserId: account.numericUserId,
      errorKind: error instanceof Error ? error.name : typeof error
    });
  }
}
async function persistVerified(attempt) {
  const { deps, credential, correlationId, outcome } = attempt;
  const at = nowIso();
  const account = {
    numericUserId: outcome.identity.numericUserId,
    login: outcome.identity.login,
    expectedLogin: credential.expectedLogin,
    displayName: null,
    startingPrompt: null,
    credential: { token: credential.token, kind: outcome.credentialKind, verifiedAt: at },
    scopeCheck: outcome.scopeCheck,
    state: "active",
    connectionState: "connected",
    verifiedAt: at,
    errorReason: null,
    createdAt: at,
    updatedAt: at
  };
  await writeAccount(deps.store, account);
  reportRateBaseline({ deps, identity: outcome.identity, baseline: outcome.rateBaseline });
  await recordVerified({ deps, account, correlationId });
  return {
    status: STATUS.created,
    body: {
      numericUserId: account.numericUserId,
      login: account.login,
      state: account.state,
      verifiedAt: account.verifiedAt,
      scopeCheck: account.scopeCheck
    }
  };
}
async function acceptVerified(attempt) {
  const { deps, credential, correlationId, outcome } = attempt;
  const { identity } = outcome;
  const expected = credential.expectedLogin;
  if (expected !== null && expected.toLowerCase() !== identity.login.toLowerCase()) {
    await recordRejection({ deps, reason: "expected-login-mismatch", identity, correlationId });
    return accountRejectedResponse(LOGIN_MISMATCH_MESSAGE, correlationId);
  }
  const existing = await readAccount({
    store: deps.store,
    numericUserId: identity.numericUserId,
    log: deps.log
  });
  if (existing !== null) {
    await recordRejection({ deps, reason: "duplicate-account", identity, correlationId });
    return duplicateAccountResponse(correlationId);
  }
  return await persistVerified(attempt);
}
async function handleVerify(context, request) {
  const { store } = context;
  if (store === null) {
    return storageUnavailableResponse();
  }
  const parsed = parseCredentialBody(request.body, true);
  if (!parsed.ok) {
    return parsed.response;
  }
  const decision = context.throttle.attempt();
  if (!decision.allowed) {
    return throttleRefusal(decision.code, decision.retryAfterSeconds);
  }
  try {
    const outcome = await context.github.verify(parsed.credential.token);
    const attempt = {
      deps: { store, log: context.log },
      credential: parsed.credential,
      outcome,
      correlationId: newCorrelationId()
    };
    if (outcome.kind === "ok") {
      return await acceptVerified({ ...attempt, outcome });
    }
    return await refusalFor(attempt);
  } finally {
    decision.lease.release();
  }
}
var verifyRoute = {
  method: "POST",
  path: VERIFY_PATH,
  handler: guardCredentialRoute(handleVerify)
};

// service/routes/index.ts
var ROUTES = [
  healthRoute,
  configRoute,
  putConfigRoute,
  statusRoute,
  listAccountsRoute,
  bindingsRoute,
  putBindingsRoute,
  eventHistoryRoute,
  pendingEventsRoute,
  auditRoute,
  verifyRoute,
  rotateTokenRoute,
  putAccountProfileRoute,
  accountRemovalRoute,
  reserveRoute,
  dispatchedRoute,
  abandonRoute,
  blockedRoute,
  retryRunRoute,
  requeueRunRoute,
  resolveRunRoute,
  verificationRoute
];

// service/poll/sweep-loop.ts
function isHalted(state) {
  return state.stopped;
}
function sweepIntervalMs(durations) {
  return Math.floor(Math.min(durations.leaseMs, durations.resultDeadlineMs) / 2);
}
async function readSweepDurations(input) {
  try {
    const stored = await input.store.readJson(CONFIG_FILE, parseStoredConfig);
    const { config } = configFromStore(stored, input.log);
    return { leaseMs: config.leaseMs, resultDeadlineMs: config.resultDeadlineMs };
  } catch (cause) {
    input.log.warn("sweep cadence read failed", { errorKind: cause instanceof Error ? cause.name : typeof cause });
    return { leaseMs: DEFAULT_CONFIG.leaseMs, resultDeadlineMs: DEFAULT_CONFIG.resultDeadlineMs };
  }
}
function arm(input, durations) {
  const { state, cycle } = input;
  if (isHalted(state)) {
    return;
  }
  state.timer = setTimeout(() => {
    state.timer = null;
    cycle();
  }, sweepIntervalMs(durations));
  state.timer.unref();
}
async function runPass(input) {
  const { sweep, state } = input;
  if (isHalted(state) || state.inFlight) {
    return;
  }
  state.inFlight = true;
  const durations = await readSweepDurations(sweep);
  try {
    await sweepOnce({ ...sweep, now: nowIso() });
  } catch (cause) {
    sweep.log.warn("dispatch sweep pass failed", {
      errorKind: cause instanceof Error ? cause.name : typeof cause
    });
  } finally {
    state.inFlight = false;
  }
  arm({ state, cycle: input.cycle }, durations);
}
function startSweep(input) {
  const state = { timer: null, stopped: false, inFlight: false };
  const cycle = async () => await runPass({ sweep: input, state, cycle });
  const loop = { state, cycle };
  readSweepDurations(input).then((durations) => arm(loop, durations)).catch((cause) => {
    input.log.warn("sweep cadence read failed", {
      errorKind: cause instanceof Error ? cause.name : typeof cause
    });
    arm(loop, DEFAULT_CONFIG);
  });
  return {
    stop: () => {
      state.stopped = true;
      if (state.timer === null) {
        return;
      }
      clearTimeout(state.timer);
      state.timer = null;
    }
  };
}

// service/poll/sweep.ts
function budgetReason(requeuesUsed) {
  return `automatic requeue budget exhausted after ${requeuesUsed} requeues`;
}
var LEASE_EXPIRED_REASON = "lease expired without a reservation";
var MIGRATION_RECOVERY_REASON = "lease expired on migration recovery after upgrade";
function parkExhaustedRun(input) {
  const { run, lease, now } = input;
  if (run.requeuesUsed < MAX_AUTO_REQUEUES) {
    return null;
  }
  const parked = parkRun({ run, now, reason: budgetReason(run.requeuesUsed) });
  if (parked === null) {
    return null;
  }
  const reason = budgetReason(run.requeuesUsed);
  const details = {
    priorState: run.state,
    leaseId: lease.leaseId,
    leaseExpiry: lease.expiresAt,
    attemptBefore: run.attempt,
    attemptAfter: parked.attempt,
    requeuesUsed: run.requeuesUsed,
    budget: MAX_AUTO_REQUEUES
  };
  return {
    run: parked,
    recovery: {
      run: parked,
      eventType: "run.dead_lettered",
      priorState: run.state,
      reason,
      details,
      intent: {
        eventType: "run.dead_lettered",
        correlationId: parked.correlationId,
        decision: "dead-lettered",
        reason,
        details,
        sequence: `${lease.leaseId}:${parked.attempt}`
      }
    }
  };
}
function recoverExpiredLease(input) {
  const { run, now } = input;
  const { lease } = run;
  if (lease === null) {
    return null;
  }
  const isMigration = lease.provenance === "migration";
  const requeued = expireLease({ run, now, chargeBudget: !isMigration });
  if (requeued === null) {
    return null;
  }
  if (!isMigration) {
    const parked = parkExhaustedRun({ run, lease, now });
    if (parked !== null) {
      return parked;
    }
  }
  const reason = isMigration ? MIGRATION_RECOVERY_REASON : LEASE_EXPIRED_REASON;
  const details = {
    priorState: run.state,
    leaseId: lease.leaseId,
    leaseExpiry: lease.expiresAt,
    attemptBefore: run.attempt,
    attemptAfter: requeued.attempt,
    requeuesBefore: run.requeuesUsed,
    requeuesAfter: requeued.requeuesUsed,
    budget: MAX_AUTO_REQUEUES,
    migrationRecovery: isMigration
  };
  return {
    run: requeued,
    recovery: {
      run: requeued,
      eventType: "dispatch.lease-expired",
      priorState: run.state,
      reason,
      details,
      intent: {
        eventType: "dispatch.lease-expired",
        correlationId: requeued.correlationId,
        decision: "requeued",
        reason,
        details,
        sequence: `${lease.leaseId}:${requeued.attempt}`
      }
    }
  };
}
function recoverLateResult(input) {
  const { run, now } = input;
  const { reservation } = run;
  if (reservation === null || Date.parse(reservation.resultDeadlineAt) > Date.parse(now)) {
    return null;
  }
  const wedged = wedgeUnconfirmed({ run, now });
  if (wedged === null) {
    return null;
  }
  const reason = `no dispatch result by ${reservation.resultDeadlineAt}`;
  const details = {
    priorState: run.state,
    attempt: run.attempt,
    dispatchTokenFingerprint: buildDispatchTokenFingerprint(reservation.dispatchToken),
    deadline: reservation.resultDeadlineAt
  };
  return {
    run: wedged,
    recovery: {
      run: wedged,
      eventType: "dispatch.unconfirmed",
      priorState: run.state,
      reason,
      details,
      intent: {
        eventType: "dispatch.unconfirmed",
        correlationId: wedged.correlationId,
        decision: "unconfirmed",
        reason,
        details,
        sequence: `${run.attempt}:${reservation.resultDeadlineAt}`
      }
    }
  };
}
function planSweep(input) {
  const runs = [...input.document.runs];
  const recoveries = [];
  for (const [index, run] of runs.entries()) {
    const planned = run.state === "claimed" ? recoverExpiredLease({ run, now: input.now }) : recoverLateResult({ run, now: input.now });
    if (planned === null) {
      continue;
    }
    runs[index] = planned.run;
    recoveries.push(planned.recovery);
  }
  return { document: { ...input.document, runs }, recoveries };
}
async function appendSweepAudit(input) {
  const { recovery } = input;
  try {
    await appendAudit(input.store, sweepAuditRow(recovery.intent));
    return true;
  } catch (cause) {
    input.log.warn("dispatch sweep audit row could not be appended", {
      correlationId: recovery.run.correlationId,
      eventType: recovery.eventType,
      errorKind: cause instanceof Error ? cause.name : typeof cause
    });
    return false;
  }
}
function withIntents(input) {
  return {
    ...input.document,
    auditIntents: [...input.document.auditIntents ?? [], ...input.recoveries.map((entry) => entry.intent)]
  };
}
async function sweepOnce(input) {
  const now = input.now ?? nowIso();
  const planned = await inQueueChain(async () => {
    const document = await readRunsDocument({ ...input, now });
    const outcome = planSweep({ document, now });
    if (outcome.recoveries.length === 0) {
      return outcome;
    }
    return {
      ...outcome,
      document: await writeRunsDocument({ ...input, document: withIntents(outcome) })
    };
  });
  const written = [];
  for (const recovery of planned.recoveries) {
    input.log.info("dispatch sweep recovered a run", {
      correlationId: recovery.run.correlationId,
      eventType: recovery.eventType,
      priorState: recovery.priorState,
      newState: recovery.run.state
    });
    written.push(await appendSweepAudit({ ...input, recovery }));
  }
  return { recoveries: planned.recoveries, auditWritten: written.every(Boolean) };
}

// service/poll/trigger-scan.ts
var BODY_EXCERPT_MAX_CHARS = 600;
function bodyExcerptOf(body) {
  if (body === null) {
    return "";
  }
  if (body.length <= BODY_EXCERPT_MAX_CHARS) {
    return body;
  }
  return `${body.slice(0, BODY_EXCERPT_MAX_CHARS - 1)}…`;
}

// service/poll/poller-events.ts
var ITEM_EVENT_MAX_PAGES = 2;
var NO_ACTOR = { login: "", type: "" };
function actorOf(value) {
  if (!isRecord(value)) {
    return NO_ACTOR;
  }
  const { login, type } = value;
  return {
    login: typeof login === "string" ? login : "",
    type: typeof type === "string" ? type : ""
  };
}
function issueNumberOf(value) {
  const record = isRecord(value) ? value : null;
  if (record === null) {
    return null;
  }
  const issueNumber = record.number;
  return typeof issueNumber === "number" && Number.isSafeInteger(issueNumber) && issueNumber > 0 ? issueNumber : null;
}
function createdAtOf(value) {
  if (typeof value !== "string") {
    return null;
  }
  return Number.isNaN(Date.parse(value)) ? null : value;
}
function readItemEventEntry(value) {
  if (!isRecord(value)) {
    return null;
  }
  const createdAt = createdAtOf(value.created_at);
  if (createdAt === null || typeof value.event !== "string" || value.event === "") {
    return null;
  }
  return {
    event: value.event,
    assignee: actorOf(value.assignee),
    assigner: actorOf(value.assigner),
    requestedReviewer: actorOf(value.requested_reviewer),
    reviewRequester: actorOf(value.review_requester),
    issueNumber: issueNumberOf(value.issue),
    createdAt
  };
}
function pageEndsWalk(input) {
  return input.events.length < input.perPage || input.events.every((event) => !stampInWindow(event.createdAt, input.windowStart));
}
function qualifies(input, event) {
  const isAssignment = input.kind === "assignment";
  const subject = isAssignment ? event.assignee : event.requestedReviewer;
  return (isAssignment ? event.event === "assigned" : event.event === "review_requested") && (event.issueNumber === null || event.issueNumber === input.issueNumber) && stampInWindow(event.createdAt, input.windowStart) && subject.login !== "" && subject.login.toLowerCase() === input.boundLogin.toLowerCase();
}
function namingEventOf(events, input) {
  let newest = null;
  for (const event of events) {
    if (!qualifies(input, event)) {
      continue;
    }
    if (newest === null || Date.parse(event.createdAt) > Date.parse(newest.createdAt)) {
      newest = event;
    }
  }
  return newest;
}
function actorOfNamingEvent(input) {
  const named = input.kind === "assignment" ? input.event.assigner : input.event.reviewRequester;
  if (!isAttributableAuthor(named.login, named.type)) {
    return { usable: false, reason: named.login === "" ? "unreadable-actor" : "bot-actor" };
  }
  return { usable: true, login: actorLoginOf(named.login) };
}
function recordNoEvent(input) {
  const { request, reason } = input;
  request.log.warn("matched candidate produced no event this cycle", {
    path: `issues/${request.issueNumber}`,
    kind: request.kind,
    reason,
    maxPages: ITEM_EVENT_MAX_PAGES
  });
}
async function resolveCandidateActor(request) {
  const { repository } = request;
  const listed = await request.poller.listIssueEvents({
    token: request.token,
    owner: repository.owner,
    name: repository.name,
    issueNumber: request.issueNumber,
    windowStart: request.windowStart,
    pace: request.pace
  });
  if (listed.kind !== "ok") {
    return { kind: "failed", failure: listed };
  }
  const event = namingEventOf(listed.events, {
    kind: request.kind,
    boundLogin: request.boundLogin,
    issueNumber: request.issueNumber,
    windowStart: request.windowStart
  });
  if (event === null) {
    if (listed.exhausted) {
      request.log.warn("matched candidate produced no event this cycle", {
        path: `issues/${request.issueNumber}`,
        kind: request.kind,
        reason: "page-bound-reached",
        maxPages: ITEM_EVENT_MAX_PAGES
      });
      return { kind: "exhausted" };
    }
    recordNoEvent({ request, reason: "no-qualifying-event" });
    return { kind: "refused", reason: "no-qualifying-event" };
  }
  const actor = actorOfNamingEvent({ kind: request.kind, event });
  if (!actor.usable) {
    recordNoEvent({ request, reason: actor.reason });
    return { kind: "refused", reason: actor.reason };
  }
  return { kind: "actor", login: actor.login };
}

// service/poll/triggers-assignment.ts
function isIssueAssignment(issue2, bindingLogin) {
  if (issue2.state !== "open") {
    return false;
  }
  return issue2.assignees.some((login) => login.toLowerCase() === bindingLogin.toLowerCase());
}
function assignmentEvent(input) {
  const { binding, issue: issue2, actorLogin, detectedAt } = input;
  const repository = repositoryRefOf(binding.repository);
  return createEvent({
    bindingId: binding.bindingId,
    repository: repositoryLabel(repository),
    accountNumericUserId: binding.accountNumericUserId,
    accountLogin: binding.accountLogin,
    projectId: binding.projectId,
    worktreeOption: binding.worktreeOption,
    kind: "assignment",
    issue: {
      issueNumber: issue2.issueNumber,
      issueTitle: issue2.title,
      issueUrl: issue2.url,
      issueBodyExcerpt: bodyExcerptOf(issue2.body)
    },
    actorLogin,
    actorAttribution: "direct",
    triggerNote: "Issue assigned to the bound account",
    detectedAt,
    subjectType: issue2.isPullRequest ? "pull_request" : "issue"
  });
}
async function assignmentEvents(input) {
  const events = [];
  for (const issue2 of input.issues) {
    if (!stampInWindow(issue2.updatedAt, input.windowStart) || !isIssueAssignment(issue2, input.login)) {
      continue;
    }
    const actor = await resolveCandidateActor({
      poller: input.poller,
      log: input.log,
      token: input.token,
      repository: repositoryRefOf(input.binding.repository),
      issueNumber: issue2.issueNumber,
      kind: "assignment",
      boundLogin: input.login,
      windowStart: input.windowStart,
      pace: input.pace
    });
    if (actor.kind === "failed") {
      return { ok: false, failure: actor.failure };
    }
    if (actor.kind === "actor") {
      events.push(assignmentEvent({
        binding: input.binding,
        issue: issue2,
        actorLogin: actor.login,
        detectedAt: input.detectedAt
      }));
    }
  }
  return { ok: true, events };
}

// service/poll/triggers-review.ts
function isReviewRequestPull(pull, bindingLogin) {
  if (bindingLogin === "") {
    return false;
  }
  const wanted = bindingLogin.toLowerCase();
  return pull.requestedReviewers.some((candidate) => candidate.toLowerCase() === wanted);
}
function reviewEvent(input) {
  const { binding, pull, actorLogin, detectedAt } = input;
  return createEvent({
    bindingId: binding.bindingId,
    repository: repositoryLabel(repositoryRefOf(binding.repository)),
    accountNumericUserId: binding.accountNumericUserId,
    accountLogin: binding.accountLogin,
    projectId: binding.projectId,
    worktreeOption: binding.worktreeOption,
    kind: "review",
    headSha: pull.headSha,
    baseRef: pull.baseRef,
    issue: {
      issueNumber: pull.pullNumber,
      issueTitle: pull.title,
      issueUrl: pull.url,
      issueBodyExcerpt: ""
    },
    actorLogin,
    actorAttribution: "direct",
    triggerNote: `Pull request #${pull.pullNumber} requested the bound account's review`,
    detectedAt,
    subjectType: "pull_request"
  });
}
async function reviewRequestEvents(input) {
  const { binding, poller, token, login, windowStart, detectedAt, pace } = input;
  const repository = repositoryRefOf(binding.repository);
  const listed = await poller.listOpenPulls({
    token,
    owner: repository.owner,
    name: repository.name,
    pace
  });
  if (listed.kind !== "ok") {
    return { ok: false, failure: listed };
  }
  const events = [];
  for (const pull of listed.pulls) {
    if (!stampInWindow(pull.updatedAt, windowStart) || !isReviewRequestPull(pull, login)) {
      continue;
    }
    const actor = await resolveCandidateActor({
      poller,
      log: input.log,
      token,
      repository,
      issueNumber: pull.pullNumber,
      kind: "review",
      boundLogin: login,
      windowStart,
      pace
    });
    if (actor.kind === "failed") {
      return { ok: false, failure: actor.failure };
    }
    if (actor.kind === "actor") {
      events.push(reviewEvent({ binding, pull, actorLogin: actor.login, detectedAt }));
    }
  }
  return { ok: true, events };
}

// service/poll/triggers.ts
function isLoginCharacter(character) {
  return /^[A-Za-z0-9_-]$/.test(character);
}
function mentionsLogin(body, login) {
  if (login === "") {
    return false;
  }
  const haystack = body.toLowerCase();
  const token = `@${login.toLowerCase()}`;
  let from = haystack.indexOf(token);
  while (from !== -1) {
    const before = from === 0 ? "" : haystack.charAt(from - 1);
    const after = haystack.charAt(from + token.length);
    if (!isLoginCharacter(before) && !isLoginCharacter(after)) {
      return true;
    }
    from = haystack.indexOf(token, from + 1);
  }
  return false;
}
function isMentionComment(comment, bindingLogin) {
  if (!isAttributableAuthor(comment.authorLogin, comment.authorType)) {
    return false;
  }
  return mentionsLogin(comment.body, bindingLogin);
}
function isIssueBodyMention(issue2, bindingLogin) {
  if (!isAttributableAuthor(issue2.authorLogin, issue2.authorType)) {
    return false;
  }
  return mentionsLogin(issue2.body ?? "", bindingLogin);
}
function subjectShapeOf2(isPullRequest) {
  return isPullRequest ? "pull_request" : "issue";
}
function mentionEvent(input) {
  const { binding, comment, issue: issue2, detectedAt } = input;
  const repository = repositoryRefOf(binding.repository);
  const commenter = actorLoginOf(comment.authorLogin);
  const fallbackUrl = `https://github.com/${repository.owner}/${repository.name}/issues/${comment.issueNumber}`;
  return createEvent({
    bindingId: binding.bindingId,
    repository: repositoryLabel(repository),
    accountNumericUserId: binding.accountNumericUserId,
    accountLogin: binding.accountLogin,
    projectId: binding.projectId,
    worktreeOption: binding.worktreeOption,
    kind: "mention",
    origin: "comment",
    commentId: comment.commentId,
    issue: {
      issueNumber: comment.issueNumber,
      issueTitle: issue2?.title ?? `Issue #${comment.issueNumber}`,
      issueUrl: issue2?.url ?? fallbackUrl,
      issueBodyExcerpt: bodyExcerptOf(comment.body)
    },
    actorLogin: commenter,
    actorAttribution: "direct",
    triggerNote: `Comment by ${commenter} on issue #${comment.issueNumber} mentioned the bound account`,
    detectedAt,
    ...issue2 !== null && { subjectType: subjectShapeOf2(issue2.isPullRequest) }
  });
}
function mentionEvents(input) {
  const { binding, login, comments, issues, windowStart, detectedAt } = input;
  const known = new Map(issues.map((issue2) => [issue2.issueNumber, issue2]));
  const events = [];
  for (const comment of comments) {
    const isEligible = stampInWindow(comment.updatedAt, windowStart) && isMentionComment(comment, login);
    if (!isEligible) {
      continue;
    }
    const issue2 = known.get(comment.issueNumber) ?? null;
    events.push(mentionEvent({ binding, comment, issue: issue2, detectedAt }));
  }
  return events;
}
function bodyMentionEvents(input) {
  const { binding, login, issues, windowStart, detectedAt } = input;
  const label = repositoryLabel(repositoryRefOf(binding.repository));
  const events = [];
  for (const issue2 of issues) {
    const isEligible = stampInWindow(issue2.updatedAt, windowStart) && isIssueBodyMention(issue2, login);
    if (!isEligible) {
      continue;
    }
    events.push(createEvent({
      bindingId: binding.bindingId,
      repository: label,
      accountNumericUserId: binding.accountNumericUserId,
      accountLogin: binding.accountLogin,
      projectId: binding.projectId,
      worktreeOption: binding.worktreeOption,
      kind: "mention",
      origin: "body",
      issue: {
        issueNumber: issue2.issueNumber,
        issueTitle: issue2.title,
        issueUrl: issue2.url,
        issueBodyExcerpt: bodyExcerptOf(issue2.body)
      },
      actorLogin: actorLoginOf(issue2.authorLogin),
      actorAttribution: "direct",
      triggerNote: "mentioned in issue body",
      detectedAt,
      subjectType: subjectShapeOf2(issue2.isPullRequest)
    }));
  }
  return events;
}
async function mentionEventsOf(input) {
  const { poller, token, binding, login, windowStart, detectedAt, issues, pace } = input;
  const repository = repositoryRefOf(binding.repository);
  const listed = await poller.listIssueComments({
    token,
    owner: repository.owner,
    name: repository.name,
    since: windowStart,
    pace
  });
  if (listed.kind !== "ok") {
    return { ok: false, failure: listed };
  }
  const events = [
    ...bodyMentionEvents({ binding, login, issues, windowStart, detectedAt }),
    ...mentionEvents({ binding, login, comments: listed.comments, issues, windowStart, detectedAt })
  ];
  return { ok: true, events };
}
async function collectTriggerEvents(input) {
  const { binding, poller, token, windowStart, pace } = input;
  const repository = repositoryRefOf(binding.repository);
  const events = [];
  const issues = binding.triggers.assignment || binding.triggers.mention ? await poller.listOpenIssues({
    token,
    owner: repository.owner,
    name: repository.name,
    since: windowStart,
    pace
  }) : { kind: "ok", issues: [] };
  if (issues.kind !== "ok") {
    return { ok: false, failure: issues };
  }
  if (binding.triggers.assignment) {
    const branch = await assignmentEvents({ ...input, issues: issues.issues });
    if (!branch.ok) {
      return branch;
    }
    events.push(...branch.events);
  }
  if (binding.triggers.mention) {
    const branch = await mentionEventsOf({ ...input, issues: issues.issues });
    if (!branch.ok) {
      return branch;
    }
    events.push(...branch.events);
  }
  if (binding.triggers.reviewRequest) {
    const branch = await reviewRequestEvents(input);
    if (!branch.ok) {
      return branch;
    }
    events.push(...branch.events);
  }
  return { ok: true, events };
}

// service/poll/loop.ts
function watchesAnything(binding) {
  const { assignment, mention, reviewRequest } = binding.triggers;
  return assignment || mention || reviewRequest;
}
function skipOf(outcome) {
  if (outcome.kind === "auth-failed") {
    return "auth-failed";
  }
  if (outcome.kind === "rate-limited") {
    return "rate-limited";
  }
  return outcome.detail === "timeout" || outcome.detail === "offline" ? "offline" : "upstream";
}
function blankScan(binding) {
  return {
    bindingId: binding.bindingId,
    repository: binding.repository,
    enqueued: 0,
    windowFrom: null,
    skipped: null
  };
}
async function collectScanEvents(input) {
  const { deps, binding, windowStart, detectedAt, token, login } = input;
  const collected = await collectTriggerEvents({
    poller: deps.poller,
    log: deps.log,
    token,
    binding,
    login,
    windowStart,
    detectedAt,
    pace: deps.pace
  });
  return collected.ok ? { ok: true, events: collected.events } : { ok: false, skipped: skipOf(collected.failure) };
}
async function scanBinding(input) {
  const { deps, scanned, detectedAt, binding } = input;
  const blank = blankScan(binding);
  const { store, log } = deps;
  const account = await readAccount({ store, numericUserId: binding.accountNumericUserId, log });
  if (account === null || account.credential.token === "") {
    return { ...blank, skipped: "missing-account" };
  }
  if (account.state !== "active") {
    return { ...blank, skipped: "inactive-account" };
  }
  const verdict = windowFor({ binding, scanned, overlapMs: deps.config.overlapMs });
  if ("refused" in verdict) {
    return { ...blank, skipped: verdict.refused };
  }
  const listed = await collectScanEvents({
    deps,
    binding,
    windowStart: verdict.window,
    detectedAt,
    token: account.credential.token,
    login: account.login === "" ? binding.accountLogin : account.login
  });
  if (!listed.ok) {
    return { ...blank, skipped: listed.skipped };
  }
  const appended = await enqueueEvents({
    store: deps.store,
    log: deps.log,
    incoming: listed.events,
    prompt: resolvePromptSnapshot({ global: deps.config, account, binding })
  });
  return { ...blank, enqueued: appended.length, windowFrom: detectedAt };
}
async function saveBindingScanState(deps, scan) {
  await serializeScan(async () => {
    const state = await readScanState(deps);
    const prior = bindingScanOf(state, scan.bindingId);
    const didComplete = scan.windowFrom !== null;
    const retained = scan.windowFrom ?? prior.lastScanAt;
    await writeScanState({
      store: deps.store,
      state: withBindingScanState({
        state,
        bindingId: scan.bindingId,
        slot: {
          lastScanAt: retained,
          lastError: scan.skipped,
          baselineAt: prior.baselineAt,
          forceReplay: !didComplete && prior.forceReplay,
          rescanFrom: didComplete ? null : prior.rescanFrom
        }
      })
    });
  });
}
async function ensureBaselines(deps, bindings, state) {
  const needing = bindingsNeedingBaseline({ bindings, slots: state.bindings });
  if (needing.length === 0) {
    return state;
  }
  const stamps = await readStoredCreationStamps({ store: deps.store, log: deps.log, bindingIds: needing });
  const byId = new Map(bindings.map((binding) => [binding.bindingId, binding]));
  let derived = null;
  for (const bindingId of needing) {
    const binding = byId.get(bindingId);
    const stored = stamps.get(bindingId);
    if (binding === undefined || stored === undefined) {
      continue;
    }
    const verdict = baselineFor({ binding, stored, overlapMs: deps.config.overlapMs });
    if ("refused" in verdict) {
      continue;
    }
    const prior = bindingScanOf(derived ?? state, bindingId);
    derived = withBindingScanState({
      state: derived ?? state,
      bindingId,
      slot: { ...prior, baselineAt: verdict.window }
    });
  }
  if (derived === null) {
    return state;
  }
  await writeScanState({ store: deps.store, state: derived });
  return derived;
}
async function cycleContext(input) {
  const config = await readCycleConfig({ store: input.store, log: input.log });
  const pace = {
    perPage: config.perPage,
    retry: {
      maxAttempts: config.retryMaxAttempts,
      baseMs: config.retryBaseMs,
      maxMs: config.retryMaxMs
    }
  };
  return { store: input.store, log: input.log, poller: input.poller, config, pace };
}
async function runScanCycle(deps) {
  if (deps.store === null) {
    return { bindings: [], enqueued: 0 };
  }
  const context = await cycleContext({ store: deps.store, log: deps.log, poller: deps.poller });
  await runRetentionPasses({ store: context.store, log: context.log, config: context.config });
  await readEvents({ store: context.store, log: context.log });
  const [bindings, readState] = await Promise.all([
    readBindings({ store: context.store, log: context.log }),
    readScanState({ store: context.store, log: context.log })
  ]);
  const scannedState = await ensureBaselines(context, bindings, readState);
  const detectedAt = new Date().toISOString();
  const outcomes = [];
  let total = 0;
  for (const binding of bindings) {
    if (binding.state !== "active" || !watchesAnything(binding)) {
      continue;
    }
    const scan = await scanBinding({
      deps: context,
      binding,
      scanned: bindingScanOf(scannedState, binding.bindingId),
      detectedAt
    });
    await saveBindingScanState(context, scan);
    if (scan.windowFrom !== null) {
      total += scan.enqueued;
    }
    outcomes.push(scan);
  }
  if (outcomes.length > 0) {
    context.log.info("poll cycle complete", {
      bindings: outcomes.length,
      enqueued: total,
      skipped: outcomes.filter((scan) => scan.skipped !== null).length
    });
  }
  return { bindings: outcomes, enqueued: total };
}

// service/poll/backoff.ts
function unitFraction(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}
var MILLISECONDS_PER_SECOND = 1000;
function backoffDelayMs(input) {
  const step = Math.max(input.attempt - 2, 0);
  const uncapped = input.policy.baseMs * 2 ** step;
  const capped = Math.min(input.policy.maxMs, uncapped);
  const jitter = 0.5 + 0.5 * unitFraction(input.random());
  return Math.min(input.policy.maxMs, Math.floor(capped * jitter));
}
function nextWait(input) {
  const backoffMs = backoffDelayMs({
    policy: input.policy,
    attempt: input.attempt,
    random: input.random
  });
  if (input.guidanceSeconds === null) {
    return { attempt: input.attempt, delayMs: backoffMs, source: "backoff" };
  }
  const guidedMs = Math.max(0, Math.round(input.guidanceSeconds * MILLISECONDS_PER_SECOND));
  return guidedMs > backoffMs ? { attempt: input.attempt, delayMs: guidedMs, source: "guidance" } : { attempt: input.attempt, delayMs: backoffMs, source: "backoff" };
}
async function waitForRetry(input) {
  const record = nextWait(input);
  input.onWait(record);
  await input.sleep(record.delayMs);
  return record;
}

// service/poll/poller-transport.ts
var STATUS_UNAUTHORIZED2 = 401;
var STATUS_NOT_FOUND2 = 404;
var STATUS_FORBIDDEN2 = 403;
var STATUS_TOO_MANY_REQUESTS2 = 429;
var MAX_LIST_PAGES = 2;
var systemSleep = async (milliseconds) => {
  await new Promise((resolve3) => {
    setTimeout(resolve3, milliseconds);
  });
};
function pollerRuntime(deps, fetchImpl) {
  return {
    fetchImpl,
    log: deps.log,
    sleep: deps.sleep ?? systemSleep,
    random: deps.random ?? (() => Math.random())
  };
}
function listUrl(input) {
  const url = new URL(`${API_ORIGIN}/repos/${input.owner}/${input.name}/${input.path}`);
  for (const [key, value] of Object.entries(input.query)) {
    url.searchParams.set(key, value);
  }
  if (input.since !== null) {
    url.searchParams.set("since", input.since);
  }
  return url;
}
function parseListPage(input) {
  const parsed = parseJsonText(input.text);
  if (!parsed.ok || !Array.isArray(parsed.value)) {
    throw new Error(input.message);
  }
  return parsed.value.flatMap((entry) => {
    const item = input.read(entry);
    return item === null ? [] : [item];
  });
}
async function classifyOutcome(response) {
  if (response.status === STATUS_UNAUTHORIZED2 || response.status === STATUS_NOT_FOUND2) {
    return { kind: "auth-failed" };
  }
  const rateLimitStatuses = [STATUS_FORBIDDEN2, STATUS_TOO_MANY_REQUESTS2];
  if (rateLimitStatuses.includes(response.status) && isRateLimited(response)) {
    return { kind: "rate-limited", retryAfterSeconds: retryAfterOf(response) };
  }
  return { kind: "unavailable", detail: "upstream" };
}
async function waitBeforeNextAttempt(context, wait) {
  const { runtime, pace, url } = context;
  await waitForRetry({
    policy: pace.retry,
    attempt: wait.attempt,
    guidanceSeconds: wait.guidanceSeconds,
    sleep: runtime.sleep,
    random: runtime.random,
    onWait: (record) => {
      runtime.log.info("poll request waiting before its next attempt", {
        path: url.pathname,
        attempt: record.attempt,
        delayMs: record.delayMs,
        source: record.source
      });
    }
  });
}
async function requestPage(input) {
  const policy = input.pace.retry;
  const attempts = Math.max(1, policy.maxAttempts);
  let last = { kind: "unavailable", detail: "upstream" };
  for (let attempt = 1;attempt <= attempts; attempt += 1) {
    let response;
    try {
      response = await input.runtime.fetchImpl(input.url.href, {
        method: "GET",
        headers: requestHeaders(input.token),
        signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS)
      });
    } catch (error) {
      last = { kind: "unavailable", detail: transportDetail(error) };
      if (attempt >= attempts) {
        return { failure: last };
      }
      await waitBeforeNextAttempt(input, { attempt: attempt + 1, guidanceSeconds: null });
      continue;
    }
    if (response.ok) {
      return { response };
    }
    last = await classifyOutcome(response);
    if (last.kind === "auth-failed" || attempt >= attempts) {
      return { failure: last };
    }
    const guidanceSeconds = last.kind === "rate-limited" ? last.retryAfterSeconds : null;
    await waitBeforeNextAttempt(input, { attempt: attempt + 1, guidanceSeconds });
  }
  return { failure: last };
}
async function readOnePage(input) {
  const attempt = await requestPage({
    runtime: input.runtime,
    token: input.token,
    url: input.url,
    pace: input.pace
  });
  if (!("response" in attempt)) {
    return attempt.failure;
  }
  try {
    return {
      kind: "ok",
      items: parseListPage({
        text: await attempt.response.text(),
        message: input.message,
        read: input.read
      })
    };
  } catch {
    return { kind: "unavailable", detail: "upstream" };
  }
}
async function listPages(input) {
  const items = [];
  for (let page = 1;page <= MAX_LIST_PAGES; page += 1) {
    input.url.searchParams.set("page", String(page));
    input.url.searchParams.set("per_page", String(input.pace.perPage));
    const parsed = await readOnePage(input);
    if (parsed.kind !== "ok") {
      return parsed;
    }
    items.push(...parsed.items);
    if (parsed.items.length < input.pace.perPage) {
      break;
    }
  }
  return { kind: "ok", items };
}

// service/poll/poller-entries.ts
function asRecord(value) {
  return isRecord(value) ? value : null;
}
function positiveIntOf2(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}
function textOf(record, field) {
  const value = record[field];
  return typeof value === "string" ? value : null;
}
function readLogins(value) {
  if (!Array.isArray(value)) {
    return null;
  }
  const logins = [];
  for (const entry of value) {
    const login = asRecord(entry);
    const candidate = login === null ? null : login.login;
    if (typeof candidate !== "string" || candidate === "") {
      return null;
    }
    logins.push(candidate);
  }
  return logins;
}
function authorLoginOf(user) {
  return user === null ? "" : textOf(user, "login") ?? "";
}
function authorTypeOf(user) {
  return user === null ? "" : textOf(user, "type") ?? "";
}
function issueNumberOf2(value) {
  if (typeof value !== "string") {
    return null;
  }
  const lastSegment = value.slice(value.lastIndexOf("/") + 1);
  return positiveIntOf2(Number(lastSegment));
}
function readIssueEntry(value) {
  const record = asRecord(value);
  if (record === null) {
    return null;
  }
  const issueNumber = positiveIntOf2(record.number);
  const title = textOf(record, "title");
  const url = textOf(record, "html_url");
  const state = textOf(record, "state");
  const assignees = readLogins(record.assignees);
  if (issueNumber === null || title === null || url === null || state === null || assignees === null) {
    return null;
  }
  const user = asRecord(record.user);
  return {
    issueNumber,
    title,
    url,
    state,
    body: textOf(record, "body"),
    authorLogin: authorLoginOf(user),
    authorType: authorTypeOf(user),
    assignees,
    isPullRequest: "pull_request" in record,
    updatedAt: textOf(record, "updated_at")
  };
}
function readCommentEntry(value) {
  const record = asRecord(value);
  if (record === null) {
    return null;
  }
  const commentId = positiveIntOf2(record.id);
  const issueNumber = issueNumberOf2(record.issue_url);
  const body = textOf(record, "body");
  const url = textOf(record, "html_url");
  const user = asRecord(record.user);
  const authorLogin = authorLoginOf(user);
  if (commentId === null || issueNumber === null || body === null || url === null || authorLogin === "") {
    return null;
  }
  return {
    commentId,
    issueNumber,
    body,
    url,
    authorLogin,
    authorType: authorTypeOf(user),
    updatedAt: textOf(record, "updated_at")
  };
}
function readPullEntry(value) {
  const record = asRecord(value);
  if (record === null) {
    return null;
  }
  const pullNumber = positiveIntOf2(record.number);
  const title = textOf(record, "title");
  const url = textOf(record, "html_url");
  const state = textOf(record, "state");
  const requestedReviewers = readLogins(record.requested_reviewers);
  if (pullNumber === null || title === null || url === null || state === null || requestedReviewers === null) {
    return null;
  }
  const head = asRecord(record.head);
  const base = asRecord(record.base);
  return {
    pullNumber,
    title,
    url,
    state,
    requestedReviewers,
    headSha: head === null ? null : textOf(head, "sha"),
    baseRef: base === null ? null : textOf(base, "ref"),
    updatedAt: textOf(record, "updated_at")
  };
}

// service/poll/poller-github.ts
var NEWEST_UPDATED_FIRST = { sort: "updated", direction: "desc" };
async function issuesList(runtime, query) {
  const result = await listPages({
    runtime,
    pace: query.pace,
    token: query.token,
    url: listUrl({
      owner: query.owner,
      name: query.name,
      path: "issues",
      query: { state: "open", ...NEWEST_UPDATED_FIRST },
      since: query.since
    }),
    message: "issue list response was not an array",
    read: readIssueEntry
  });
  return result.kind === "ok" ? { kind: "ok", issues: result.items } : result;
}
async function commentsList(runtime, query) {
  const result = await listPages({
    runtime,
    pace: query.pace,
    token: query.token,
    url: listUrl({
      owner: query.owner,
      name: query.name,
      path: "issues/comments",
      query: { ...NEWEST_UPDATED_FIRST },
      since: query.since
    }),
    message: "issue comment list response was not an array",
    read: readCommentEntry
  });
  return result.kind === "ok" ? { kind: "ok", comments: result.items } : result;
}
async function pullsList(runtime, query) {
  const result = await listPages({
    runtime,
    pace: query.pace,
    token: query.token,
    url: listUrl({
      owner: query.owner,
      name: query.name,
      path: "pulls",
      query: { state: "open", ...NEWEST_UPDATED_FIRST },
      since: null
    }),
    message: "pull list response was not an array",
    read: readPullEntry
  });
  return result.kind === "ok" ? { kind: "ok", pulls: result.items } : result;
}
function itemEventsUrl(input) {
  return new URL(`${API_ORIGIN}/repos/${input.owner}/${input.name}/issues/${input.issueNumber}/events`);
}
async function itemEventsList(runtime, query) {
  const url = itemEventsUrl({ owner: query.owner, name: query.name, issueNumber: query.issueNumber });
  const input = {
    runtime,
    token: query.token,
    url,
    pace: query.pace,
    message: "issue events response was not an array",
    read: readItemEventEntry
  };
  const events = [];
  for (let page = 1;page <= ITEM_EVENT_MAX_PAGES; page += 1) {
    url.searchParams.set("page", String(page));
    url.searchParams.set("per_page", String(query.pace.perPage));
    const parsed = await readOnePage(input);
    if (parsed.kind !== "ok") {
      return parsed;
    }
    events.push(...parsed.items);
    if (pageEndsWalk({ events: parsed.items, windowStart: query.windowStart, perPage: query.pace.perPage })) {
      return { kind: "ok", events, exhausted: false };
    }
  }
  return { kind: "ok", events, exhausted: true };
}
function createGitHubIssuePoller(deps, fetchImpl = (url, init) => globalThis.fetch(url, init)) {
  const runtime = pollerRuntime(deps, fetchImpl);
  return {
    listOpenIssues: (query) => issuesList(runtime, query),
    listIssueComments: (query) => commentsList(runtime, query),
    listOpenPulls: (query) => pullsList(runtime, query),
    listIssueEvents: (query) => itemEventsList(runtime, query)
  };
}

// service/poll/timer.ts
function startPollLoop(deps) {
  let timer = null;
  let isStopped = false;
  let isInFlight = false;
  let nextAtMs = null;
  const cycle = async () => {
    if (isStopped || isInFlight) {
      return;
    }
    isInFlight = true;
    try {
      await runScanCycle(deps);
    } catch (cause) {
      deps.log.warn("poll cycle failed", { errorKind: describeKind(cause) });
    } finally {
      isInFlight = false;
    }
    await currentIntervalMs(deps.store, deps.log).then((interval) => {
      if (isStopped) {
        return null;
      }
      nextAtMs = Date.now() + interval;
      timer = setTimeout(() => {
        timer = null;
        nextAtMs = null;
        cycle();
      }, interval);
      timer.unref();
      return interval;
    });
  };
  cycle();
  return {
    stop: () => {
      isStopped = true;
      nextAtMs = null;
      if (timer === null) {
        return;
      }
      clearTimeout(timer);
      timer = null;
    },
    state: () => ({ stopped: isStopped, nextPollAtMs: nextAtMs })
  };
}
function createDefaultPoller(log) {
  return createGitHubIssuePoller({ log });
}

// service/throttle.ts
var VERIFY_WINDOW_MS = 5 * 60000;
var VERIFY_MAX_ATTEMPTS = 10;
var MS_PER_SECOND2 = 1000;
function createVerifyThrottle(now = Date.now) {
  const stamps = [];
  let active = 0;
  const prune = (at) => {
    while (stamps.length > 0 && at - (stamps[0] ?? 0) >= VERIFY_WINDOW_MS) {
      stamps.shift();
    }
  };
  return {
    attempt: () => {
      const at = now();
      prune(at);
      if (active > 0) {
        return { allowed: false, code: "verify-busy", retryAfterSeconds: 1 };
      }
      const oldest = stamps[0];
      if (oldest !== undefined && stamps.length >= VERIFY_MAX_ATTEMPTS) {
        const waitMs = VERIFY_WINDOW_MS - (at - oldest);
        return {
          allowed: false,
          code: "rate-limited",
          retryAfterSeconds: Math.max(1, Math.ceil(waitMs / MS_PER_SECOND2))
        };
      }
      stamps.push(at);
      active += 1;
      let isReleased = false;
      return {
        allowed: true,
        lease: {
          release: () => {
            if (isReleased) {
              return;
            }
            isReleased = true;
            active -= 1;
          }
        }
      };
    },
    inFlight: () => active
  };
}

// service/server.ts
var DRAIN_TIMEOUT_MS = 5000;
var CLOSE_TIMEOUT_MS = 5000;
var DRAIN_POLL_MS = 25;
async function openStoreSafe(options) {
  try {
    return await openStore({ dataDir: options.dataDir });
  } catch (error) {
    if (!(error instanceof StorageUnavailableError)) {
      throw error;
    }
    options.log.error("store unavailable", { dataDir: options.dataDir, error: error.message });
    return null;
  }
}
async function adoptStoredLogLevel(store, log) {
  if (store === null) {
    return;
  }
  try {
    const { config } = configFromStore(await store.readJson(CONFIG_FILE, parseStoredConfig), log);
    log.setLevel(config.logLevel);
  } catch (cause) {
    log.warn("stored log level read failed", {
      errorKind: cause instanceof Error ? cause.name : typeof cause
    });
  }
}
function listen(server, port) {
  return new Promise((resolve3, reject) => {
    const onError = (error) => {
      reject(error);
    };
    server.once("error", onError);
    server.listen(port, LOOPBACK_HOST, () => {
      server.removeListener("error", onError);
      resolve3();
    });
  });
}
function boundPort(server) {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("service is not listening on a TCP port");
  }
  return address.port;
}
function sleep(milliseconds) {
  return new Promise((resolve3) => {
    setTimeout(resolve3, milliseconds);
  });
}
async function waitForDrain(state, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (state.inFlight > 0 && Date.now() < deadline) {
    await sleep(DRAIN_POLL_MS);
  }
}
async function withTimeout(promise, timeoutMs) {
  let timer;
  const deadline = new Promise((resolve3) => {
    timer = setTimeout(() => {
      resolve3();
    }, timeoutMs);
  });
  await Promise.race([promise, deadline]);
  if (timer !== undefined) {
    clearTimeout(timer);
  }
}
async function performShutdown(input) {
  const { server, state, poll, sweep, polling } = input;
  polling.beginShutdown();
  poll?.stop();
  sweep?.stop();
  const closed = new Promise((resolve3) => {
    server.close(() => {
      resolve3();
    });
  });
  await waitForDrain(state, DRAIN_TIMEOUT_MS);
  server.closeIdleConnections();
  await withTimeout(closed, CLOSE_TIMEOUT_MS);
  server.closeAllConnections();
  await closed;
}
function createHandle(parts) {
  let closing = null;
  const shutdown = () => {
    closing ??= performShutdown({
      server: parts.server,
      state: parts.state,
      poll: parts.poll ?? null,
      sweep: parts.sweep ?? null,
      polling: parts.polling
    });
    return closing;
  };
  return {
    port: parts.port,
    dataDir: parts.dataDir,
    store: parts.store,
    reconciled: parts.reconciled,
    swept: parts.swept,
    poll: parts.poll ?? null,
    shutdown
  };
}
function startReconciliation(input) {
  return reconcileInterruptedAccounts(input).catch((error) => {
    input.log.error("startup reconciliation failed", {
      errorKind: error instanceof Error ? error.name : typeof error
    });
    return { examined: 0, marked: 0, restored: 0 };
  });
}
function startBootSweep(input) {
  if (input.store === null) {
    return Promise.resolve({ recoveries: [], auditWritten: true });
  }
  return sweepOnce({ store: input.store, log: input.log }).catch((error) => {
    input.log.warn("boot sweep failed", { errorKind: error instanceof Error ? error.name : typeof error });
    return { recoveries: [], auditWritten: false };
  });
}
function startSchedulers(input) {
  const { store, log, poller, polling } = input;
  const poll = store === null ? null : startPollLoop({ store, log, poller });
  polling.observe(poll);
  const sweep = store === null ? null : startSweep({ store, log });
  return { poll, sweep };
}
function buildContext(input) {
  return {
    store: input.store,
    dataDir: input.options.dataDir,
    startedAt: Date.now(),
    log: input.options.log,
    schemaVersion: SERVICE_SCHEMA_VERSION,
    github: input.github,
    throttle: createVerifyThrottle(),
    polling: input.polling.view
  };
}
async function startService(options) {
  const store = await openStoreSafe(options);
  await adoptStoredLogLevel(store, options.log);
  await runRetentionAtOpen({ store, log: options.log });
  const github = options.github ?? createGitHubVerifier();
  const state = { inFlight: 0 };
  const polling = createPollingView();
  const context = buildContext({ options, store, github, polling });
  const deps = { env: options.env, context, routes: ROUTES, log: options.log, state };
  const server = createServer(createRequestHandler(deps));
  const swept = await startBootSweep({ store, log: options.log });
  await listen(server, options.env.port);
  const reconciled = startReconciliation({ store, github, log: options.log });
  const { poll, sweep } = startSchedulers({
    store,
    log: options.log,
    poller: options.poller ?? createDefaultPoller(options.log),
    polling
  });
  return createHandle({
    server,
    state,
    store,
    dataDir: options.dataDir,
    port: boundPort(server),
    reconciled,
    swept: Promise.resolve(swept),
    poll,
    sweep,
    polling
  });
}

// service/main.ts
var FORCE_EXIT_MS = 5000;
function isEntryPoint() {
  const entry = process.argv[1];
  return entry !== undefined && resolve3(entry) === fileURLToPath(import.meta.url);
}
function scheduleForceExit(log) {
  const watchdog = setTimeout(() => {
    log.warn("forcing exit after graceful shutdown");
    process.exit(process.exitCode ?? 0);
  }, FORCE_EXIT_MS);
  watchdog.unref();
}
async function stopService(handle, log) {
  try {
    await handle.shutdown();
    process.exitCode = 0;
    scheduleForceExit(log);
  } catch (error) {
    process.exitCode = 1;
    log.error("shutdown failed", { error: describeError(error) });
  }
}
function createShutdownHandler(handle, log) {
  return (label) => {
    log.info("shutdown requested", { signal: label });
    stopService(handle, log);
  };
}
function installSignalHandlers(handle, log) {
  const onShutdown = createShutdownHandler(handle, log);
  process.once("SIGTERM", () => {
    onShutdown("SIGTERM");
  });
  process.once("SIGINT", () => {
    onShutdown("SIGINT");
  });
}
async function runService(env = process.env) {
  const log = createLogger({ level: "info" });
  try {
    const serviceEnv = readServiceEnv(env);
    const dataDir = resolveDataDir(env);
    const handle = await startService({ env: serviceEnv, dataDir, log });
    installSignalHandlers(handle, log);
    log.info("service listening", { port: handle.port, dataDir: handle.dataDir });
  } catch (error) {
    process.exitCode = 1;
    log.error("service failed to start", { error: describeError(error) });
  }
}
if (isEntryPoint()) {
  runService();
}
export {
  runService
};
