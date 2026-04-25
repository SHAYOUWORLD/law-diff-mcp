#!/usr/bin/env node

const SERVER_NAME = "law-diff-mcp";
const SERVER_VERSION = "0.1.0";
const PROTOCOL_VERSION = "2025-06-18";
const EGOV_BASE_URL = "https://laws.e-gov.go.jp";
const EGOV_DOCUMENT_ORIGINS = new Set([EGOV_BASE_URL, "https://elaws.e-gov.go.jp"]);
const REQUEST_TIMEOUT_MS = (() => {
  const parsed = Number.parseInt(process.env.LAW_DIFF_MCP_TIMEOUT_MS ?? "20000", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 20000;
})();
const MAX_SCAN_DAYS = 31;
const MAX_DIFF_LINES = 2500;

const tools = [
  {
    name: "list_updates",
    description:
      "List laws updated in e-Gov Law Search on a specific date. Returns amendment metadata and law revision IDs when available.",
    inputSchema: {
      type: "object",
      properties: {
        date: {
          type: "string",
          description: "Update date in YYYY-MM-DD or YYYYMMDD. e-Gov supports dates from 2020-11-24 and not future dates.",
        },
        keyword: {
          type: "string",
          description: "Optional keyword matched against law name, old law name, amendment name, amendment number, or law ID.",
        },
        limit: {
          type: "number",
          minimum: 1,
          maximum: 200,
          description: "Maximum number of results. Defaults to 50.",
        },
      },
      required: ["date"],
      additionalProperties: false,
    },
  },
  {
    name: "find_revisions",
    description:
      "Scan e-Gov updated-law lists across a date range and find revision IDs for one law ID or keyword. Use this before diff_revisions when you need candidate law history IDs.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Start date in YYYY-MM-DD or YYYYMMDD." },
        until: { type: "string", description: "End date in YYYY-MM-DD or YYYYMMDD. Maximum scan range is 31 days." },
        lawId: { type: "string", description: "Optional base law ID, e.g. 405AC0000000088." },
        keyword: {
          type: "string",
          description: "Optional keyword matched against law name, amendment name, amendment number, or law ID.",
        },
        limit: {
          type: "number",
          minimum: 1,
          maximum: 500,
          description: "Maximum number of results. Defaults to 100.",
        },
      },
      required: ["from", "until"],
      additionalProperties: false,
    },
  },
  {
    name: "get_revision_text",
    description:
      "Retrieve law text for a current law ID or e-Gov law revision ID. Returns metadata, source URLs, and a plain-text preview.",
    inputSchema: {
      type: "object",
      properties: {
        revisionId: {
          type: "string",
          description:
            "Current law ID or law history ID, e.g. 405AC0000000088 or 405AC0000000088_20231201_505AC0000000056.",
        },
        lawUrl: {
          type: "string",
          description: "Optional e-Gov document URL containing a lawid query parameter. Either revisionId or lawUrl is required.",
        },
        previewChars: {
          type: "number",
          minimum: 500,
          maximum: 30000,
          description: "Maximum preview length. Defaults to 8000.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "diff_revisions",
    description:
      "Fetch two current law IDs or law revision IDs from e-Gov and return a line-level diff of comparable article/paragraph text.",
    inputSchema: {
      type: "object",
      properties: {
        oldRevisionId: {
          type: "string",
          description: "Old current law ID or law history ID.",
        },
        newRevisionId: {
          type: "string",
          description: "New current law ID or law history ID.",
        },
        maxChanges: {
          type: "number",
          minimum: 1,
          maximum: 500,
          description: "Maximum changed lines to return. Defaults to 120.",
        },
      },
      required: ["oldRevisionId", "newRevisionId"],
      additionalProperties: false,
    },
  },
];

function writeJson(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function log(message) {
  process.stderr.write(`[${SERVER_NAME}] ${message}\n`);
}

function rpcResult(id, result) {
  writeJson({ jsonrpc: "2.0", id, result });
}

function rpcError(id, code, message, data) {
  const error = data === undefined ? { code, message } : { code, message, data };
  writeJson({ jsonrpc: "2.0", id, error });
}

function assertString(value, name, opts = {}) {
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${name} must be a non-empty string`);
  }
  const maxLength = opts.maxLength ?? 500;
  if (trimmed.length > maxLength) {
    throw new Error(`${name} exceeds maximum length ${maxLength}`);
  }
  if (opts.pattern && !opts.pattern.test(trimmed)) {
    throw new Error(`${name} does not match expected format`);
  }
  return trimmed;
}

function optionalString(value, name, opts = {}) {
  if (value === undefined || value === null || String(value).trim() === "") return "";
  return assertString(String(value), name, opts);
}

function clampNumber(value, fallback, min, max) {
  const parsed = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function normalizeDate(value, name) {
  const text = assertString(value, name, { maxLength: 10 });
  const compact = text.replace(/-/g, "");
  if (!/^\d{8}$/.test(compact)) {
    throw new Error(`${name} must be YYYY-MM-DD or YYYYMMDD`);
  }
  const year = Number.parseInt(compact.slice(0, 4), 10);
  const month = Number.parseInt(compact.slice(4, 6), 10);
  const day = Number.parseInt(compact.slice(6, 8), 10);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`${name} is not a valid calendar date`);
  }
  if (compact < "20201124") {
    throw new Error(`${name} must be 2020-11-24 or later`);
  }
  const today = new Date();
  const todayCompact = `${today.getUTCFullYear()}${String(today.getUTCMonth() + 1).padStart(2, "0")}${String(
    today.getUTCDate(),
  ).padStart(2, "0")}`;
  if (compact > todayCompact) {
    throw new Error(`${name} must not be a future date`);
  }
  return compact;
}

function dateRange(from, until) {
  const start = normalizeDate(from, "from");
  const end = normalizeDate(until, "until");
  if (start > end) {
    throw new Error("from must be on or before until");
  }
  const dates = [];
  let cursor = new Date(Date.UTC(Number(start.slice(0, 4)), Number(start.slice(4, 6)) - 1, Number(start.slice(6, 8))));
  const endDate = new Date(Date.UTC(Number(end.slice(0, 4)), Number(end.slice(4, 6)) - 1, Number(end.slice(6, 8))));
  while (cursor <= endDate) {
    if (dates.length >= MAX_SCAN_DAYS) {
      throw new Error(`date range is too large; maximum is ${MAX_SCAN_DAYS} days`);
    }
    dates.push(`${cursor.getUTCFullYear()}${String(cursor.getUTCMonth() + 1).padStart(2, "0")}${String(cursor.getUTCDate()).padStart(2, "0")}`);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function revisionIdFromLawUrl(lawUrl) {
  if (!lawUrl) return "";
  try {
    const url = new URL(lawUrl);
    if (!EGOV_DOCUMENT_ORIGINS.has(url.origin)) return "";
    return url.searchParams.get("lawid") ?? "";
  } catch {
    return "";
  }
}

function baseLawId(revisionId) {
  return revisionId.split("_")[0] ?? revisionId;
}

async function fetchText(path, opts = {}) {
  if (!path.startsWith("/api/1/") || path.includes("..") || path.includes("//")) {
    throw new Error("Internal error: refused non-e-Gov API path");
  }

  const url = new URL(path, EGOV_BASE_URL);
  if (url.origin !== EGOV_BASE_URL) {
    throw new Error("Internal error: resolved URL escaped e-Gov origin");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
      headers: {
        "User-Agent": `${SERVER_NAME}/${SERVER_VERSION} (https://codeagent.jp/)`,
        Accept: "application/xml,text/xml,*/*",
      },
    });

    if (response.status === 404 && opts.emptyOn404) {
      return "";
    }

    if (!response.ok) {
      throw new Error(`e-Gov API returned HTTP ${response.status}`);
    }

    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function decodeXml(text) {
  return String(text)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function stripTags(xml) {
  return decodeXml(
    String(xml)
      .replace(/<Ruby>([\s\S]*?)<\/Ruby>/gi, "$1")
      .replace(/<Rt>[\s\S]*?<\/Rt>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " "),
  ).trim();
}

function tagText(xml, tag) {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i").exec(xml);
  return match ? stripTags(match[1]) : "";
}

function sourceInfo(path, revisionId) {
  const url = revisionId
    ? `${EGOV_BASE_URL}/document?lawid=${encodeURIComponent(revisionId)}`
    : `${EGOV_BASE_URL}${path}`;
  return {
    name: "e-Gov法令検索",
    url,
    apiUrl: `${EGOV_BASE_URL}${path}`,
    attribution: "出典: e-Gov法令検索（https://laws.e-gov.go.jp/）",
    retrievedAt: new Date().toISOString(),
  };
}

function parseUpdates(xml) {
  const results = [];
  const pattern = /<LawNameListInfo>([\s\S]*?)<\/LawNameListInfo>/gi;
  for (const match of xml.matchAll(pattern)) {
    const block = match[1];
    const lawUrl = tagText(block, "LawUrl");
    const revisionId = revisionIdFromLawUrl(lawUrl);
    results.push({
      lawTypeName: tagText(block, "LawTypeName"),
      lawNo: tagText(block, "LawNo"),
      lawName: tagText(block, "LawName"),
      lawNameKana: tagText(block, "LawNameKana"),
      oldLawName: tagText(block, "OldLawName"),
      promulgationDate: tagText(block, "PromulgationDate"),
      amendName: tagText(block, "AmendName"),
      amendNo: tagText(block, "AmendNo"),
      amendPromulgationDate: tagText(block, "AmendPromulgationDate"),
      enforcementDate: tagText(block, "EnforcementDate"),
      enforcementComment: tagText(block, "EnforcementComment"),
      lawId: tagText(block, "LawId"),
      revisionId,
      lawUrl,
      enforcementStatus: tagText(block, "EnforcementFlg") === "1" ? "not-yet-enforced" : "enforced",
      authorityStatus: tagText(block, "AuthFlg") === "1" ? "under-authority-review" : "confirmed",
      source: {
        name: "e-Gov法令検索",
        attribution: "出典: e-Gov法令検索（https://laws.e-gov.go.jp/）",
      },
    });
  }
  return results.filter((item) => item.lawId || item.lawName);
}

function matchesKeyword(item, keyword) {
  if (!keyword) return true;
  const haystack = [
    item.lawTypeName,
    item.lawNo,
    item.lawName,
    item.oldLawName,
    item.amendName,
    item.amendNo,
    item.lawId,
    item.revisionId,
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  return haystack.includes(keyword.toLowerCase());
}

async function listUpdates(args) {
  const date = normalizeDate(args?.date, "date");
  const keyword = optionalString(args?.keyword, "keyword", { maxLength: 200 });
  const limit = clampNumber(args?.limit, 50, 1, 200);
  const path = `/api/1/updatelawlists/${date}`;
  const xml = await fetchText(path, { emptyOn404: true });
  const results = parseUpdates(xml)
    .filter((item) => matchesKeyword(item, keyword))
    .slice(0, limit);

  return {
    date,
    keyword,
    count: results.length,
    results,
    source: sourceInfo(path, ""),
    note: "e-Gov update lists identify law revisions, but they are not legal advice. Verify important conclusions against official e-Gov pages.",
  };
}

async function findRevisions(args) {
  const dates = dateRange(args?.from, args?.until);
  const lawId = optionalString(args?.lawId, "lawId", { maxLength: 80 });
  const keyword = optionalString(args?.keyword, "keyword", { maxLength: 200 });
  if (!lawId && !keyword) {
    throw new Error("Either lawId or keyword is required");
  }
  const limit = clampNumber(args?.limit, 100, 1, 500);
  const results = [];

  for (const date of dates) {
    const path = `/api/1/updatelawlists/${date}`;
    const xml = await fetchText(path, { emptyOn404: true });
    for (const item of parseUpdates(xml)) {
      if (lawId && item.lawId !== lawId && item.revisionId && baseLawId(item.revisionId) !== lawId) {
        continue;
      }
      if (!matchesKeyword(item, keyword)) {
        continue;
      }
      results.push({ updateDate: date, ...item });
      if (results.length >= limit) break;
    }
    if (results.length >= limit) break;
  }

  results.sort(
    (a, b) =>
      String(a.lawId).localeCompare(String(b.lawId)) ||
      String(a.enforcementDate).localeCompare(String(b.enforcementDate)) ||
      String(a.updateDate).localeCompare(String(b.updateDate)),
  );

  return {
    from: dates[0],
    until: dates[dates.length - 1],
    scannedDays: dates.length,
    lawId,
    keyword,
    count: results.length,
    results,
    note: `The scan range is capped at ${MAX_SCAN_DAYS} days to avoid excessive requests to e-Gov.`,
  };
}

function resolveRevisionId(args) {
  const explicit = optionalString(args?.revisionId, "revisionId", { maxLength: 120 });
  if (explicit) return explicit;
  const lawUrl = optionalString(args?.lawUrl, "lawUrl", { maxLength: 1000 });
  const fromUrl = revisionIdFromLawUrl(lawUrl);
  if (fromUrl) return fromUrl;
  throw new Error("Either revisionId or lawUrl with a lawid query parameter is required");
}

async function fetchLawXml(revisionId) {
  const safeId = assertString(revisionId, "revisionId", {
    maxLength: 120,
    pattern: /^[0-9A-Z]+(?:_\d{8}_[0-9A-Z]+)?$/,
  });
  const path = `/api/1/lawdata/${encodeURIComponent(safeId)}`;
  const xml = await fetchText(path);
  const code = tagText(xml, "Code");
  if (code && code !== "0") {
    throw new Error(`e-Gov API returned result code ${code}: ${tagText(xml, "Message")}`);
  }
  return { xml, path, revisionId: safeId };
}

function extractLawMetadata(xml, fallbackRevisionId) {
  const lawFullTextXml = /<LawFullText(?:\s[^>]*)?>[\s\S]*?<\/LawFullText>/i.exec(xml)?.[0] ?? "";
  const lawXml = /<Law\b[\s\S]*?<\/Law>/i.exec(lawFullTextXml)?.[0] ?? lawFullTextXml;
  return {
    revisionId: tagText(xml, "LawId") || fallbackRevisionId,
    baseLawId: baseLawId(tagText(xml, "LawId") || fallbackRevisionId),
    lawNum: tagText(lawXml, "LawNum") || tagText(xml, "LawNum"),
    lawTitle: tagText(lawXml, "LawTitle"),
    lawType: /<Law\b[^>]*\bLawType="([^"]+)"/i.exec(lawXml)?.[1] ?? "",
    plainText: stripTags(lawFullTextXml),
    lawFullTextXml,
  };
}

function comparableLines(lawFullTextXml) {
  const lines = [];
  const articlePattern = /<Article\b[^>]*>[\s\S]*?<\/Article>/gi;
  for (const articleMatch of lawFullTextXml.matchAll(articlePattern)) {
    const articleXml = articleMatch[0];
    const articleTitle = tagText(articleXml, "ArticleTitle");
    const articleCaption = tagText(articleXml, "ArticleCaption");
    const paragraphPattern = /<Paragraph\b[^>]*>[\s\S]*?<\/Paragraph>/gi;
    let foundParagraph = false;
    for (const paragraphMatch of articleXml.matchAll(paragraphPattern)) {
      foundParagraph = true;
      const paragraphXml = paragraphMatch[0];
      const paragraphNum = tagText(paragraphXml, "ParagraphNum");
      const paragraphText = stripTags(paragraphXml);
      if (paragraphText) {
        lines.push([articleTitle, articleCaption, paragraphNum, paragraphText].filter(Boolean).join(" "));
      }
    }
    if (!foundParagraph) {
      const text = stripTags(articleXml);
      if (text) lines.push([articleTitle, articleCaption, text].filter(Boolean).join(" "));
    }
    if (lines.length >= MAX_DIFF_LINES) break;
  }

  if (lines.length === 0) {
    const text = stripTags(lawFullTextXml);
    for (let i = 0; i < text.length && lines.length < MAX_DIFF_LINES; i += 400) {
      lines.push(text.slice(i, i + 400));
    }
  }

  return lines.slice(0, MAX_DIFF_LINES);
}

async function getRevisionText(args) {
  const revisionId = resolveRevisionId(args);
  const previewChars = clampNumber(args?.previewChars, 8000, 500, 30000);
  const { xml, path } = await fetchLawXml(revisionId);
  const metadata = extractLawMetadata(xml, revisionId);

  return {
    revisionId: metadata.revisionId,
    baseLawId: metadata.baseLawId,
    lawNum: metadata.lawNum,
    lawTitle: metadata.lawTitle,
    lawType: metadata.lawType,
    preview: metadata.plainText.slice(0, previewChars),
    previewChars,
    truncated: metadata.plainText.length > previewChars,
    source: sourceInfo(path, metadata.revisionId),
    note: "This tool returns source text for reference only and does not provide legal advice.",
  };
}

function lineDiff(oldLines, newLines, maxChanges) {
  const n = oldLines.length;
  const m = newLines.length;
  const totalCells = (n + 1) * (m + 1);
  if (totalCells > 7_000_000) {
    throw new Error(`diff input too large after normalization (${n} x ${m}); narrow the target law or use fewer revisions`);
  }

  const dp = new Uint32Array(totalCells);
  const width = m + 1;
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * width + j] =
        oldLines[i] === newLines[j]
          ? dp[(i + 1) * width + j + 1] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
  }

  const changes = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m && changes.length < maxChanges) {
    if (oldLines[i] === newLines[j]) {
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      changes.push({ type: "delete", oldLine: i + 1, newLine: j + 1, text: oldLines[i] });
      i += 1;
    } else {
      changes.push({ type: "insert", oldLine: i + 1, newLine: j + 1, text: newLines[j] });
      j += 1;
    }
  }
  while (i < n && changes.length < maxChanges) {
    changes.push({ type: "delete", oldLine: i + 1, newLine: j + 1, text: oldLines[i] });
    i += 1;
  }
  while (j < m && changes.length < maxChanges) {
    changes.push({ type: "insert", oldLine: i + 1, newLine: j + 1, text: newLines[j] });
    j += 1;
  }

  const deleted = changes.filter((change) => change.type === "delete").length;
  const inserted = changes.filter((change) => change.type === "insert").length;
  const unified = changes.map((change) => `${change.type === "delete" ? "-" : "+"} ${change.text}`).join("\n");

  return {
    oldLineCount: n,
    newLineCount: m,
    returnedChanges: changes.length,
    truncated: changes.length >= maxChanges,
    summary: { inserted, deleted },
    changes,
    unified,
  };
}

async function diffRevisions(args) {
  const oldRevisionId = assertString(args?.oldRevisionId, "oldRevisionId", {
    maxLength: 120,
    pattern: /^[0-9A-Z]+(?:_\d{8}_[0-9A-Z]+)?$/,
  });
  const newRevisionId = assertString(args?.newRevisionId, "newRevisionId", {
    maxLength: 120,
    pattern: /^[0-9A-Z]+(?:_\d{8}_[0-9A-Z]+)?$/,
  });
  const maxChanges = clampNumber(args?.maxChanges, 120, 1, 500);

  const [oldFetched, newFetched] = await Promise.all([fetchLawXml(oldRevisionId), fetchLawXml(newRevisionId)]);
  const oldMeta = extractLawMetadata(oldFetched.xml, oldRevisionId);
  const newMeta = extractLawMetadata(newFetched.xml, newRevisionId);
  const oldLines = comparableLines(oldMeta.lawFullTextXml);
  const newLines = comparableLines(newMeta.lawFullTextXml);
  const diff = lineDiff(oldLines, newLines, maxChanges);

  return {
    old: {
      revisionId: oldMeta.revisionId,
      baseLawId: oldMeta.baseLawId,
      lawNum: oldMeta.lawNum,
      lawTitle: oldMeta.lawTitle,
      source: sourceInfo(oldFetched.path, oldMeta.revisionId),
    },
    new: {
      revisionId: newMeta.revisionId,
      baseLawId: newMeta.baseLawId,
      lawNum: newMeta.lawNum,
      lawTitle: newMeta.lawTitle,
      source: sourceInfo(newFetched.path, newMeta.revisionId),
    },
    diff,
    note:
      "Line-level diff is generated from normalized article/paragraph text. It is for research triage, not a substitute for official new-old comparison tables or legal advice.",
  };
}

async function callTool(name, args) {
  switch (name) {
    case "list_updates":
      return listUpdates(args);
    case "find_revisions":
      return findRevisions(args);
    case "get_revision_text":
      return getRevisionText(args);
    case "diff_revisions":
      return diffRevisions(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function toolResult(data) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

async function handleRequest(message) {
  if (!message || message.jsonrpc !== "2.0") {
    rpcError(message?.id ?? null, -32600, "Invalid JSON-RPC message");
    return;
  }

  const { id, method, params } = message;

  try {
    switch (method) {
      case "initialize":
        rpcResult(id, {
          protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        });
        break;

      case "notifications/initialized":
        break;

      case "ping":
        rpcResult(id, {});
        break;

      case "tools/list":
        rpcResult(id, { tools });
        break;

      case "tools/call": {
        const toolName = assertString(params?.name, "params.name");
        const data = await callTool(toolName, params?.arguments ?? {});
        rpcResult(id, toolResult(data));
        break;
      }

      default:
        if (id !== undefined) {
          rpcError(id, -32601, `Method not found: ${method}`);
        }
        break;
    }
  } catch (error) {
    log(error?.stack ?? String(error));
    if (id !== undefined) {
      rpcError(id, -32000, error instanceof Error ? error.message : String(error));
    }
  }
}

async function handleLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return;

  let message;
  try {
    message = JSON.parse(trimmed);
  } catch (error) {
    rpcError(null, -32700, "Parse error", error instanceof Error ? error.message : String(error));
    return;
  }

  if (Array.isArray(message)) {
    for (const item of message) {
      await handleRequest(item);
    }
    return;
  }

  await handleRequest(message);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    void handleLine(line);
  }
});

process.stdin.on("end", () => {
  if (buffer.trim()) {
    void handleLine(buffer);
  }
});

process.on("uncaughtException", (error) => {
  log(error?.stack ?? String(error));
});

process.on("unhandledRejection", (error) => {
  log(error?.stack ?? String(error));
});
