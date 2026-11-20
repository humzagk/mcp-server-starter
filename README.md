# mcp-server-starter

[![tests](https://github.com/humzagk/mcp-server-starter/actions/workflows/ci.yml/badge.svg)](https://github.com/humzagk/mcp-server-starter/actions/workflows/ci.yml)

**A production-minded template for putting your own product behind an [MCP](https://modelcontextprotocol.io) server**, so AI assistants such as Claude can search and read your data (and, if you allow it, write to it).

You implement one small interface, `ProductAdapter`, for your product. The template handles the MCP side:

- tools, resources and a prompt
- input validation and structured output
- error handling that never leaks secrets
- stdio and Streamable HTTP transports
- read-only by default
- tests

```
 AI assistant  ──MCP──▶  createServer()  ──▶  ProductAdapter  ──▶  your product
 (Claude, ...)           tools/resources       search / get        (DB, REST API,
                         prompts, errors       list / create        SaaS, files)
```

It ships with three adapters:

| Adapter | Use it for |
|---|---|
| `memory` | Trying it out, tests, and as the smallest reference implementation |
| `rest` | Any JSON REST API, configured with environment variables |
| `github` | A real-world example that exposes one GitHub repo's issues and PRs |

## Quick start

Requires Node.js 22+.

```bash
git clone https://github.com/humzagk/mcp-server-starter.git
cd mcp-server-starter
npm install
npm run build
npm test
```

Try it in the [MCP Inspector](https://github.com/modelcontextprotocol/inspector):

```bash
npm run inspect
```

### Connect it to Claude Code

```bash
claude mcp add help-centre -- node /absolute/path/to/mcp-server-starter/dist/index.js
```

### Connect it to Claude Desktop

Add this to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "help-centre": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server-starter/dist/index.js"],
      "env": { "MCP_ADAPTER": "memory" }
    }
  }
}
```

Then ask something like *"How do I reset my password?"*. The assistant calls `search_items` and then `get_item`.

## What the server exposes

| Kind | Name | Description |
|---|---|---|
| Tool | `search_items` | Search with `query` and `limit`. Returns ranked matches with snippets, as text and as structured content. Marked read-only. |
| Tool | `get_item` | Read one item in full by `id`. Unknown ids return a tool error the model can recover from. Marked read-only. |
| Tool | `create_item` | Create an item. **Only registered when `MCP_ALLOW_WRITES=true`** and the adapter implements `create`. |
| Resource | `item://{id}` | Each item as Markdown. Listable when the adapter implements `list`. |
| Prompt | `summarize_item` | Embeds an item and asks for a three-bullet summary plus action items. |

## Adapting it to your product

### 1. Implement the adapter

`search` and `get` are all you need for a read-only server:

```ts
// src/adapters/acme.ts
import { AdapterError, type Item, type ProductAdapter } from "../adapter.js";

export class AcmeTicketsAdapter implements ProductAdapter {
  readonly name = "Acme Helpdesk";
  readonly itemDescription = "support tickets";

  constructor(private apiKey: string) {}

  async search(query: string, limit: number): Promise<Item[]> {
    const res = await fetch(`https://api.acme.example/tickets?q=${encodeURIComponent(query)}&limit=${limit}`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    if (!res.ok) throw new AdapterError(`Acme API returned HTTP ${res.status}`); // shown to the model
    const tickets = await res.json();
    return tickets.map((t: any) => ({
      id: String(t.id),
      title: t.subject,
      content: t.description,
      metadata: { status: t.status, priority: t.priority },
      updatedAt: t.updated_at,
    }));
  }

  async get(id: string): Promise<Item | null> {
    /* fetch one ticket; return null if it does not exist */
    return null;
  }
}
```

Optional methods:

- `list(limit, cursor)` lets clients browse items as resources.
- `create(input)` adds the `create_item` tool, but only when writes are enabled.

### 2. Register it

Add a case to `buildAdapter()` in [`src/index.ts`](src/index.ts):

```ts
case "acme":
  return new AcmeTicketsAdapter(env.ACME_API_KEY ?? "");
```

Or use the library directly in your own entry point:

```ts
import { createServer } from "mcp-server-starter";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

await createServer(new AcmeTicketsAdapter(process.env.ACME_API_KEY!)).connect(new StdioServerTransport());
```

### 3. Test it

[`test/server.test.ts`](test/server.test.ts) shows how to drive the server through a real MCP client over an in-memory transport. Copy one of those tests and point it at your adapter.

### No code: the REST adapter

If your product already has a JSON API shaped like `GET /items?q=`, `GET /items/{id}` and `POST /items`, configure it instead of writing code:

```bash
MCP_ADAPTER=rest \
MCP_REST_BASE_URL=https://api.example.com/v1 \
MCP_REST_API_KEY=... \
MCP_PRODUCT_NAME="Example CRM" \
MCP_ITEM_DESCRIPTION="customer records" \
node dist/index.js
```

You can change the paths with `MCP_REST_SEARCH_PATH`, `MCP_REST_ITEM_PATH` and `MCP_REST_CREATE_PATH`. Records are mapped by `defaultToItem`, which recognises common field names (`id`/`uuid`, `title`/`name`/`subject`, `content`/`body`/`description`). Pass your own `toItem` for anything else.

### Real-world example: GitHub issues

```bash
MCP_ADAPTER=github GITHUB_REPO=modelcontextprotocol/typescript-sdk node dist/index.js
```

See [`src/adapters/github.ts`](src/adapters/github.ts) for how it scopes searches, maps issues onto items and handles rate limits. Set `GITHUB_TOKEN` for higher rate limits or private repos.

## Running over HTTP

```bash
MCP_HTTP_TOKEN=change-me node dist/index.js --http --port 3000
# MCP endpoint: http://127.0.0.1:3000/mcp   health check: GET /health
```

- **Stateless** Streamable HTTP: each request gets a fresh server, so you can run several instances behind a load balancer with no session store.
- **Binds to 127.0.0.1 by default.** Pass `--host 0.0.0.0` to expose it on the network, and set a token when you do.
- **Bearer token** (`MCP_HTTP_TOKEN`), compared in constant time.
- **DNS-rebinding protection**: only `localhost` and `127.0.0.1` are accepted as `Host` by default. Set `MCP_ALLOWED_HOSTS=mcp.example.com` behind a real hostname.
- **Request body limit** (1 MB) and JSON-RPC error responses.

Connect Claude Code to it:

```bash
claude mcp add --transport http help-centre http://127.0.0.1:3000/mcp --header "Authorization: Bearer change-me"
```

For multi-user deployments, put the server behind your existing auth (OAuth or an API gateway) and pass the user's identity into your adapter. A shared bearer token is a starting point, not per-user access control.

## Security notes

- **Read-only unless you opt in.** Write tools only exist when `MCP_ALLOW_WRITES=true`. Tools carry `readOnlyHint` and `destructiveHint` annotations so clients can ask the user before calling them.
- **Errors are safe by default.** Only `AdapterError` messages reach the model. Anything else becomes "internal error" and is logged to stderr, so stack traces, connection strings and API keys stay on the server.
- **Inputs are validated** with zod schemas (lengths, ranges) before your adapter sees them.
- **stdout is reserved for the protocol** in stdio mode. Log with `console.error`.
- Treat everything your product returns as untrusted text. It goes into a model's context, so don't expose data the connected user shouldn't see.

## Project structure

```
src/
  adapter.ts          the ProductAdapter interface, Item type and AdapterError
  server.ts           createServer(): tools, resources, prompt, error handling
  http.ts             Streamable HTTP transport (auth, host checks, limits)
  index.ts            CLI entry point: picks the adapter and transport from env/flags
  lib.ts              library exports
  adapters/
    memory.ts         in-memory sample data
    rest.ts           configurable JSON REST adapter
    github.ts         GitHub issues and pull requests
test/                 vitest suites (in-memory MCP client, mock APIs, real HTTP server)
```

## Scripts

| Command | What it does |
|---|---|
| `npm run build` | Compile TypeScript to `dist/` |
| `npm test` | Run the test suite |
| `npm run dev` | Run from source with `tsx` |
| `npm run inspect` | Build and open the MCP Inspector |
| `npm run typecheck` | Type-check without emitting |

## License

[MIT](LICENSE)
