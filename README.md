# @codeagentjp/law-diff-mcp

Local stdio MCP server for finding Japanese e-Gov law revisions and diffing law text by law history ID.

This server does not call an LLM. It only returns source-backed e-Gov data and a mechanical text diff so your MCP client can cite the original source.

## Status

MVP. The API surface is intentionally small:

- `list_updates` — list laws updated on a specific date via the e-Gov updated-law list API.
- `find_revisions` — scan updated-law lists across a short date range and find revision IDs for a law or keyword.
- `get_revision_text` — retrieve current law text or historical revision text by law ID / law history ID.
- `diff_revisions` — compare two current law IDs or law history IDs and return a normalized article/paragraph text diff.

## What this is for

`egov-law-mcp` answers "what does the current law say?"

`law-diff-mcp` answers "what changed between these two e-Gov law revisions?"

The tool is useful for:

- triaging legal amendments before reading the official text manually;
- checking whether a later revision changed a specific law area;
- giving Claude Code / Claude Desktop / Cursor source-backed amendment context.

## Requirements

- Node.js 20 or later
- Network access to `https://laws.e-gov.go.jp`

## Install

From npm, after publish:

```json
{
  "mcpServers": {
    "law-diff": {
      "command": "npx",
      "args": ["-y", "@codeagentjp/law-diff-mcp"]
    }
  }
}
```

From source for development:

```bash
git clone https://github.com/SHAYOUWORLD/law-diff-mcp.git
cd law-diff-mcp
node bin/law-diff-mcp.mjs
```

```json
{
  "mcpServers": {
    "law-diff": {
      "command": "node",
      "args": ["/absolute/path/to/law-diff-mcp/bin/law-diff-mcp.mjs"]
    }
  }
}
```

## Tools

### `list_updates`

Lists e-Gov updated-law records for one date.

```json
{
  "date": "2023-02-01",
  "keyword": "液化石油ガス",
  "limit": 10
}
```

Returns amendment metadata such as `amendName`, `amendNo`, `enforcementDate`, `lawId`, `revisionId`, and `lawUrl`.

### `find_revisions`

Scans updated-law lists for up to 31 days.

```json
{
  "from": "2023-02-01",
  "until": "2023-02-28",
  "keyword": "液化石油ガス",
  "limit": 20
}
```

Use this to find candidate revision IDs before calling `diff_revisions`.

### `get_revision_text`

Retrieves current or historical e-Gov law text.

```json
{
  "revisionId": "343CO0000000014_20230401_505CO0000000007",
  "previewChars": 8000
}
```

You can also pass a `lawUrl` returned by `list_updates` or `find_revisions`.

### `diff_revisions`

Compares two e-Gov law IDs or law history IDs.

```json
{
  "oldRevisionId": "343CO0000000014_20230401_505CO0000000007",
  "newRevisionId": "343CO0000000014",
  "maxChanges": 120
}
```

The diff is line-level and generated from normalized article/paragraph text. It is meant for research triage. Always verify important conclusions against official e-Gov pages and, where necessary, official new-old comparison tables.

## Data Source and Attribution

This package uses the e-Gov Law Search API:

- e-Gov Law Search: <https://laws.e-gov.go.jp/>
- Law API documentation: <https://laws.e-gov.go.jp/docs/law-data-basic/8529371-law-api-v1/>
- Law revisions documentation: <https://laws.e-gov.go.jp/docs/law-data-basic/da91fe9-law-revisions/>
- e-Gov terms: <https://developer.e-gov.go.jp/contents/terms>
- MCP stdio transport: <https://modelcontextprotocol.io/specification/2025-06-18/basic/transports>

Tool results include source attribution. When you publish or redistribute output based on this package, include an appropriate e-Gov source attribution.

Suggested attribution:

> 出典: e-Gov法令検索（<https://laws.e-gov.go.jp/>）

## Safety Notes

- This package is a **law reference and diff triage tool, not legal advice**.
- The generated diff is mechanical. It does not interpret transitional provisions, delayed enforcement, "なお効力を有する" clauses, or amendment intent.
- It does not execute shell commands.
- It writes JSON-RPC messages only to stdout and logs only to stderr.
- It fetches only e-Gov Law Search endpoints.

## Related

- [@codeagentjp/egov-law-mcp](https://github.com/SHAYOUWORLD/egov-law-mcp)
- [@codeagentjp/houan-mcp](https://github.com/SHAYOUWORLD/houan-mcp)
- Amendment watch with e-Gov `law_revisions` (Japanese): [法令改正チェックを定期実行する (codeagent.jp)](https://codeagent.jp/posts/egov-law-amendment-watch-with-claude-code/)
- Other Japanese public-data APIs and MCP servers: [codeagent.jp/guides/public-data-api/](https://codeagent.jp/guides/public-data-api/)

## License

[MIT](./LICENSE) © codeagent.jp
