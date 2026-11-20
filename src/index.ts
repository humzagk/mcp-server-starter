#!/usr/bin/env node
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ProductAdapter } from "./adapter.js";
import { GitHubIssuesAdapter } from "./adapters/github.js";
import { MemoryAdapter } from "./adapters/memory.js";
import { RestAdapter } from "./adapters/rest.js";
import { startHttpServer } from "./http.js";
import { createServer } from "./server.js";

const HELP = `mcp-server-starter: expose your product to AI assistants over MCP

Usage:
  mcp-server-starter [--http] [--port 3000] [--host 127.0.0.1]

Transports:
  (default)   stdio, for Claude Desktop, Claude Code and other local clients
  --http      Streamable HTTP at http://HOST:PORT/mcp

Environment:
  MCP_ADAPTER          memory (default), rest or github
  MCP_ALLOW_WRITES     set to "true" to register the create_item tool
  MCP_HTTP_TOKEN       require "Authorization: Bearer <token>" on HTTP requests
  MCP_ALLOWED_HOSTS    comma-separated Host headers to accept over HTTP, e.g. "mcp.example.com"
                       (default: localhost and 127.0.0.1 on the chosen port)
  MCP_REST_BASE_URL    REST adapter: API base URL (required for rest)
  MCP_REST_API_KEY     REST adapter: bearer token sent to your API
  GITHUB_REPO          GitHub adapter: "owner/name"; GITHUB_TOKEN optional
  MCP_PRODUCT_NAME     display name, e.g. "Acme Helpdesk"
  MCP_ITEM_DESCRIPTION what the items are, e.g. "support tickets"
`;

function buildAdapter(env: NodeJS.ProcessEnv): ProductAdapter {
  switch (env.MCP_ADAPTER ?? "memory") {
    case "memory":
      return new MemoryAdapter();
    case "rest":
      return RestAdapter.fromEnv(env);
    case "github":
      return GitHubIssuesAdapter.fromEnv(env);
    default:
      throw new Error(`Unknown MCP_ADAPTER "${env.MCP_ADAPTER}" (expected "memory", "rest" or "github")`);
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      http: { type: "boolean", default: false },
      port: { type: "string", default: process.env.PORT ?? "3000" },
      host: { type: "string", default: "127.0.0.1" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }

  const adapter = buildAdapter(process.env);
  const allowWrites = process.env.MCP_ALLOW_WRITES === "true";
  const makeServer = () => createServer(adapter, { allowWrites });

  if (values.http) {
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid --port "${values.port}"`);
    const token = process.env.MCP_HTTP_TOKEN;
    if (values.host !== "127.0.0.1" && values.host !== "localhost" && !token) {
      console.error("Warning: listening on a non-local interface without MCP_HTTP_TOKEN set.");
    }
    const allowedHosts = process.env.MCP_ALLOWED_HOSTS?.split(",").map((h) => h.trim()).filter(Boolean);
    await startHttpServer(makeServer, { port, host: values.host, token, allowedHosts });
    console.error(`MCP server (${adapter.name}) listening on http://${values.host}:${port}/mcp`);
  } else {
    await makeServer().connect(new StdioServerTransport());
    console.error(`MCP server (${adapter.name}) running on stdio`); // never write logs to stdout in stdio mode
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
