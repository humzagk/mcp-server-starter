import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryAdapter } from "../src/adapters/memory.js";
import { startHttpServer } from "../src/http.js";
import { createServer } from "../src/server.js";

const TOKEN = "test-token";
let server: Server;
let base: string;

beforeAll(async () => {
  const adapter = new MemoryAdapter();
  // port 0 picks a free port; the default allowed hosts follow the bound port
  server = await startHttpServer(() => createServer(adapter), { port: 0, token: TOKEN });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("Streamable HTTP transport", () => {
  it("serves MCP end to end with a bearer token", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    });
    const client = new Client({ name: "http-test", version: "1.0.0" });
    await client.connect(transport);
    const result = await client.callTool({ name: "search_items", arguments: { query: "rate limits" } });
    expect((result.structuredContent as { items: Array<{ id: string }> }).items[0]?.id).toBe("api-rate-limits");
    await client.close();
  });

  it("rejects requests without the token", async () => {
    const res = await fetch(`${base}/mcp`, { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } });
    expect(res.status).toBe(401);
  });

  it("rejects unexpected Host headers (DNS rebinding protection)", async () => {
    const { request } = await import("node:http");
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        `${base}/mcp`,
        {
          method: "POST",
          headers: {
            Host: "evil.example",
            Authorization: `Bearer ${TOKEN}`,
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
        },
        (res) => resolve(res.statusCode ?? 0),
      );
      req.on("error", reject);
      req.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }));
    });
    expect(status).toBe(403);
  });

  it("answers health checks and rejects bad input", async () => {
    expect((await fetch(`${base}/health`)).status).toBe(200);
    const bad = await fetch(`${base}/mcp`, {
      method: "POST",
      body: "not json",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(bad.status).toBe(400);
    const get = await fetch(`${base}/mcp`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(get.status).toBe(405);
  });
});
