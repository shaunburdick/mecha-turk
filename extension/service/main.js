// service/main.ts
import { resolve as resolve3 } from "node:path";
import { fileURLToPath } from "node:url";

// service/env.ts
var PORT_VARIABLE = "OPENCHAMBER_SERVICE_PORT";
var TOKEN_VARIABLE = "OPENCHAMBER_SERVICE_TOKEN";
var MAX_PORT = 65535;
var MIN_TOKEN_LENGTH = 16;

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
    result = result.replaceAll(pattern, `[redacted:${label}]`);
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
  const threshold = SEVERITY[options.level];
  const emit = (entry) => {
    if (SEVERITY[entry.level] < threshold) {
      return;
    }
    sink(serialize(entry));
  };
  return {
    debug: (message, fields = {}) => emit({ level: "debug", message, fields }),
    info: (message, fields = {}) => emit({ level: "info", message, fields }),
    warn: (message, fields = {}) => emit({ level: "warn", message, fields }),
    error: (message, fields = {}) => emit({ level: "error", message, fields })
  };
}

// service/server.ts
import { createServer } from "node:http";

// service/http.ts
var LOOPBACK_HOST = "127.0.0.1";
var MAX_TARGET_CHARS = 2000;
var REQUEST_BODY_MAX_CHARS = 60000;
var RESPONSE_BODY_MAX_CHARS = 256000;
var JSON_CONTENT_TYPE = "application/json; charset=utf-8";
var STATUS = {
  ok: 200,
  badRequest: 400,
  unauthorized: 401,
  notFound: 404,
  methodNotAllowed: 405,
  payloadTooLarge: 413,
  validation: 422,
  internal: 500,
  storageUnavailable: 503
};
function errorBody(details) {
  if (details.correlationId === undefined) {
    return { error: { code: details.code, message: details.message } };
  }
  return { error: { code: details.code, message: details.message, correlationId: details.correlationId } };
}
function errorResponse(status, details) {
  return { status, body: errorBody(details) };
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

// service/auth.ts
import { createHash, timingSafeEqual } from "node:crypto";
var BEARER_PREFIX = "Bearer ";
var DIGEST_ALGORITHM = "sha256";
function bearerCredential(header) {
  if (header === undefined) {
    return "";
  }
  return header.startsWith(BEARER_PREFIX) ? header.slice(BEARER_PREFIX.length) : "";
}
function digestsMatch(presented, expected) {
  const left = createHash(DIGEST_ALGORITHM).update(presented).digest();
  const right = createHash(DIGEST_ALGORITHM).update(expected).digest();
  return timingSafeEqual(left, right);
}
function isAuthorized(header, token) {
  return digestsMatch(bearerCredential(header), token);
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

// service/body.ts
var BYTES_PER_UTF16_UNIT = 3;
var REQUEST_BODY_MAX_BYTES = REQUEST_BODY_MAX_CHARS * BYTES_PER_UTF16_UNIT;
function readBytes(request) {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const finish = (outcome) => {
      if (settled) {
        return;
      }
      settled = true;
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
import { isAbsolute, resolve as resolve2 } from "node:path";

// service/store/dir.ts
import { promises as fs } from "node:fs";
import { resolve } from "node:path";

// service/store/errors.ts
var STORAGE_UNAVAILABLE_CODE = "storage-unavailable";

class StorageUnavailableError extends Error {
  name = "StorageUnavailableError";
  code = STORAGE_UNAVAILABLE_CODE;
  constructor(message, cause) {
    super(message, cause === undefined ? undefined : { cause });
  }
}

// service/store/dir.ts
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
import { dirname } from "node:path";

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
async function writeAndSync(tempPath, text) {
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
    throw new StorageUnavailableError(`unusable store file cannot be set aside: ${filePath}`, error);
  }
  return { status: "quarantined", quarantinePath };
}
async function writeJsonAtomic(filePath, value) {
  const text = `${JSON.stringify(value, null, JSON_INDENT)}
`;
  const tempPath = `${filePath}${TEMP_SUFFIX}${randomUUID()}`;
  await fs3.mkdir(dirname(filePath), { recursive: true, mode: DATA_DIR_MODE });
  try {
    await writeAndSync(tempPath, text);
    await fs3.rename(tempPath, filePath);
  } catch (error) {
    await removeIfPresent(tempPath);
    throw new StorageUnavailableError(`store file cannot be written: ${filePath}`, error);
  }
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
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
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
function createStore(dataDir, schemaVersion) {
  const locate = (relativePath) => resolveStorePath(dataDir, relativePath);
  return {
    dataDir,
    schemaVersion,
    readJson: async (relativePath, validate) => await readJsonFile(locate(relativePath), validate),
    writeJson: async (relativePath, value) => await writeJsonAtomic(locate(relativePath), value),
    appendLine: async (relativePath, entry) => await appendJsonLine(locate(relativePath), entry),
    readLines: async (relativePath, parse) => await readJsonLines(locate(relativePath), parse)
  };
}
async function openStore(options) {
  const { dataDir } = options;
  await ensureDir(dataDir);
  const schemaVersion = await readOrCreateSchemaVersion(dataDir);
  return createStore(dataDir, schemaVersion);
}

// service/pipeline.ts
var CONTENT_TYPE_HEADER = "content-type";
var CONTENT_LENGTH_HEADER = "content-length";
var CONNECTION_HEADER = "connection";
function writeResponse(call, response) {
  const outgoing = call.response;
  if (call.sent || outgoing.headersSent) {
    call.deps.log.warn("response already committed");
    return;
  }
  call.sent = true;
  const serialized = serializeBody(response.body);
  const status = serialized.ok ? response.status : STATUS.internal;
  const text = serialized.ok ? serialized.text : JSON.stringify(serialized.fallback.body);
  const headers = {
    [CONTENT_TYPE_HEADER]: JSON_CONTENT_TYPE,
    [CONTENT_LENGTH_HEADER]: String(Buffer.byteLength(text))
  };
  for (const [name, value] of Object.entries(response.headers ?? {})) {
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
function matchRoute(call, url) {
  const method = call.request.method ?? "";
  const atPath = call.deps.routes.filter((route2) => route2.path === url.pathname);
  if (atPath.length === 0) {
    return { kind: "not-found" };
  }
  const route = atPath.find((candidate) => candidate.method === method);
  if (route === undefined) {
    return { kind: "method-not-allowed", allow: atPath.map((candidate) => candidate.method) };
  }
  return { kind: "matched", route };
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
  return { url, route: match.route };
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
  const request = { method: call.request.method ?? "GET", url: matched.url, body };
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
  let settled = false;
  const complete = () => {
    if (settled) {
      return;
    }
    settled = true;
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

// service/config.ts
var CONFIG_FILE = "config.json";
var MAX_ECHOED_FIELD_CHARS = 64;
var LOG_LEVELS = new Set(["debug", "info", "warn", "error"]);
var NUMERIC_BOUNDS = {
  intervalMs: { min: 15000, max: 300000, unit: "milliseconds" },
  overlapMs: { min: 60000, max: 7200000, unit: "milliseconds" },
  perPage: { min: 1, max: 30, unit: "items per page" },
  retryMaxAttempts: { min: 1, max: 10, unit: "attempts" },
  retryBaseMs: { min: 1000, max: 60000, unit: "milliseconds" },
  retryMaxMs: { min: 5000, max: 300000, unit: "milliseconds" },
  auditRetentionDays: { min: 7, max: 3650, unit: "days" },
  auditMaxEntries: { min: 1000, max: 1e6, unit: "entries" },
  excerptRetentionDays: { min: 1, max: 365, unit: "days" }
};
var NUMERIC_FIELDS = Object.keys(NUMERIC_BOUNDS);
var DEFAULT_CONFIG = {
  intervalMs: 60000,
  overlapMs: 600000,
  perPage: 30,
  retryMaxAttempts: 5,
  retryBaseMs: 5000,
  retryMaxMs: 60000,
  auditRetentionDays: 180,
  auditMaxEntries: 50000,
  excerptRetentionDays: 30,
  logLevel: "info"
};
function isLogLevel(value) {
  return typeof value === "string" && LOG_LEVELS.has(value);
}
function numericIssue(raw, field) {
  const bounds = NUMERIC_BOUNDS[field];
  const value = raw[field];
  if (typeof value === "number" && Number.isInteger(value) && value >= bounds.min && value <= bounds.max) {
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
  const name = key.length > MAX_ECHOED_FIELD_CHARS ? `${key.slice(0, MAX_ECHOED_FIELD_CHARS)}…` : key;
  return {
    field: name,
    remediation: "remove this key; only the documented ServiceConfig fields are accepted"
  };
}
function isKnownField(key) {
  return key === "logLevel" || Object.hasOwn(NUMERIC_BOUNDS, key);
}
function collectIssues(raw) {
  const issues = [];
  for (const field of NUMERIC_FIELDS) {
    issues.push(...numericIssue(raw, field));
  }
  if (!isLogLevel(raw.logLevel)) {
    issues.push({
      field: "logLevel",
      remediation: "set logLevel to one of debug, info, warn, error"
    });
  }
  issues.push(...retryOrderIssue(raw));
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
    throw new Error(`validated configuration is missing ${field}`);
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
    logLevel: readLogLevel(raw)
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
  const validation = validateConfig(raw);
  return validation.ok ? validation.config : null;
}
function configFromStore(result, log) {
  if (result.status === "ok") {
    return result.value;
  }
  if (result.status === "quarantined") {
    log.warn("stored configuration was unusable and has been set aside", {
      quarantinePath: result.quarantinePath
    });
  }
  return DEFAULT_CONFIG;
}
function validationResponse(issues) {
  return {
    status: STATUS.validation,
    body: {
      error: {
        code: "validation",
        message: issues.map((issue) => `${issue.field}: ${issue.remediation}`).join("; "),
        issues
      }
    }
  };
}

// service/routes/config.ts
var CONFIG_PATH = "/v1/config";
async function handleGetConfig(context) {
  if (context.store === null) {
    return storageUnavailableResponse();
  }
  const result = await context.store.readJson(CONFIG_FILE, parseStoredConfig);
  const config = configFromStore(result, context.log);
  return { status: STATUS.ok, body: { config } };
}
async function handlePutConfig(context, request) {
  const validation = validateConfig(request.body);
  if (!validation.ok) {
    return validationResponse(validation.issues);
  }
  if (context.store === null) {
    return storageUnavailableResponse();
  }
  await context.store.writeJson(CONFIG_FILE, validation.config);
  return { status: STATUS.ok, body: { config: validation.config } };
}
var getConfigRoute = {
  method: "GET",
  path: CONFIG_PATH,
  handler: (context) => handleGetConfig(context)
};
var putConfigRoute = {
  method: "PUT",
  path: CONFIG_PATH,
  handler: (context, request) => handlePutConfig(context, request)
};

// service/routes/health.ts
var SERVICE_VERSION = "1.0.0";
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

// service/routes/status.ts
var STATUS_PATH = "/v1/status";
var PAUSED_REASON = "config-incomplete";
async function readConfig(context) {
  if (context.store === null) {
    return DEFAULT_CONFIG;
  }
  const result = await context.store.readJson(CONFIG_FILE, parseStoredConfig);
  return configFromStore(result, context.log);
}
async function buildStatusBody(context) {
  const config = await readConfig(context);
  const { store } = context;
  return {
    service: {
      status: store === null ? "degraded" : "ok",
      uptimeMs: Date.now() - context.startedAt,
      dataDir: context.dataDir,
      schemaVersion: store?.schemaVersion ?? null
    },
    accounts: [],
    repositories: [],
    agentPin: { expectedAgent: null, lastVerification: null },
    polling: {
      intervalMs: config.intervalMs,
      nextPollAt: null,
      paused: true,
      pausedReason: PAUSED_REASON
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

// service/routes/index.ts
var ROUTES = [healthRoute, getConfigRoute, putConfigRoute, statusRoute];

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
async function performShutdown(server, state) {
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
    closing ??= performShutdown(parts.server, parts.state);
    return closing;
  };
  return { port: parts.port, dataDir: parts.dataDir, store: parts.store, shutdown };
}
async function startService(options) {
  const store = await openStoreSafe(options);
  const state = { inFlight: 0 };
  const context = {
    store,
    dataDir: options.dataDir,
    startedAt: Date.now(),
    log: options.log,
    schemaVersion: SERVICE_SCHEMA_VERSION
  };
  const deps = { env: options.env, context, routes: ROUTES, log: options.log, state };
  const server = createServer(createRequestHandler(deps));
  await listen(server, options.env.port);
  return createHandle({
    server,
    state,
    store,
    dataDir: options.dataDir,
    port: boundPort(server)
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
