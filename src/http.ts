import { createServer as createHttpServer, type IncomingMessage, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface HttpOptions {
  port?: number;
  /** Interface to bind. Defaults to 127.0.0.1 so the server is not exposed to the network by accident. */
  host?: string;
  /** If set, every request must send `Authorization: Bearer <token>`. */
  token?: string;
  /** Hostnames accepted in the Host header (DNS-rebinding protection). */
  allowedHosts?: string[];
  maxBodyBytes?: number;
}

/**
 * Serve MCP over Streamable HTTP at POST /mcp, in stateless mode: each request
 * gets a fresh server and transport, so it scales horizontally with no session store.
 * GET /health returns 200 for load balancers.
 */
export async function startHttpServer(makeServer: () => McpServer, options: HttpOptions = {}): Promise<Server> {
  const { port = 3000, host = "127.0.0.1", token, maxBodyBytes = 1_000_000 } = options;
  // Filled in after binding, so the actual port is used (port 0 picks a free one).
  let allowedHosts: string[] = options.allowedHosts ?? [];

  const httpServer = createHttpServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;

    if (req.method === "GET" && path === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" }).end('{"status":"ok"}');
      return;
    }
    if (path !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    if (token && !hasValidToken(req, token)) {
      res.writeHead(401, { "WWW-Authenticate": "Bearer" }).end(jsonRpcError("Unauthorized"));
      return;
    }
    if (req.method !== "POST") {
      // Stateless mode has no server-initiated stream or session to delete.
      res.writeHead(405, { Allow: "POST" }).end(jsonRpcError("Method not allowed"));
      return;
    }

    let body: unknown;
    try {
      body = JSON.parse(await readBody(req, maxBodyBytes));
    } catch (err) {
      const tooLarge = err instanceof Error && err.message === "too large";
      res.writeHead(tooLarge ? 413 : 400).end(jsonRpcError(tooLarge ? "Request too large" : "Invalid JSON", -32700));
      return;
    }

    const server = makeServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      enableDnsRebindingProtection: true,
      allowedHosts,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      console.error("Error handling MCP request:", err);
      if (!res.headersSent) res.writeHead(500).end(jsonRpcError("Internal server error", -32603));
    }
  });

  await new Promise<void>((resolve) => httpServer.listen(port, host, resolve));
  if (!options.allowedHosts) {
    const bound = (httpServer.address() as AddressInfo).port;
    allowedHosts = [`localhost:${bound}`, `127.0.0.1:${bound}`];
  }
  return httpServer;
}

function hasValidToken(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? "";
  const given = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "");
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function jsonRpcError(message: string, code = -32000): string {
  return JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null });
}
