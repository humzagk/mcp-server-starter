import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdapterError } from "../src/adapter.js";
import { RestAdapter, defaultToItem } from "../src/adapters/rest.js";

/** A tiny fake product API: GET /items?q=, GET /items/:id, POST /items. */
let api: Server;
let baseUrl: string;
const seen: Array<{ method?: string; url?: string; auth?: string }> = [];

beforeAll(async () => {
  const records = [
    { id: 1, name: "Order #1001", description: "2 x widget, shipped", status: "shipped", total: 19.98 },
    { id: 2, name: "Order #1002", description: "1 x gadget, pending", status: "pending", total: 42 },
  ];
  api = createHttpServer((req, res) => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    const url = new URL(req.url!, "http://x");
    if (req.headers.authorization !== "Bearer secret-key") return void res.writeHead(401).end();
    if (req.method === "GET" && url.pathname === "/items") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const hits = records.filter((r) => JSON.stringify(r).toLowerCase().includes(q));
      return void res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ items: hits }));
    }
    const m = url.pathname.match(/^\/items\/(.+)$/);
    if (req.method === "GET" && m) {
      const rec = records.find((r) => String(r.id) === decodeURIComponent(m[1]!));
      return void (rec ? res.writeHead(200).end(JSON.stringify(rec)) : res.writeHead(404).end());
    }
    if (req.method === "POST" && url.pathname === "/items") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => res.writeHead(201).end(JSON.stringify({ id: 3, ...JSON.parse(body) })));
      return;
    }
    if (url.pathname === "/broken") return void res.writeHead(500).end();
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => api.close(() => r())));

describe("RestAdapter", () => {
  const adapter = () => new RestAdapter({ baseUrl, apiKey: "secret-key", name: "Shop" });

  it("searches, maps records and sends the API key", async () => {
    const items = await adapter().search("pending", 10);
    expect(items).toEqual([
      { id: "2", title: "Order #1002", content: "1 x gadget, pending", metadata: { status: "pending", total: 42 }, updatedAt: undefined },
    ]);
    expect(seen.at(-1)?.auth).toBe("Bearer secret-key");
    expect(seen.at(-1)?.url).toBe("/items?q=pending&limit=10");
  });

  it("returns null for a missing item", async () => {
    expect(await adapter().get("999")).toBeNull();
    expect((await adapter().get("1"))?.title).toBe("Order #1001");
  });

  it("creates items with POST", async () => {
    const item = await adapter().create({ title: "Order #1003", content: "new" });
    expect(item.id).toBe("3");
  });

  it("turns auth and server failures into safe AdapterErrors", async () => {
    const wrongKey = new RestAdapter({ baseUrl, apiKey: "wrong", name: "Shop" });
    await expect(wrongKey.search("x", 5)).rejects.toThrow(/rejected the credentials \(HTTP 401\)/);

    const broken = new RestAdapter({ baseUrl, apiKey: "secret-key", searchPath: "/broken", name: "Shop" });
    await expect(broken.search("x", 5)).rejects.toBeInstanceOf(AdapterError);

    const unreachable = new RestAdapter({ baseUrl: "http://127.0.0.1:1", apiKey: "secret-key", name: "Shop" });
    const err = await unreachable.search("x", 5).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdapterError);
    expect(String(err)).not.toContain("secret-key");
  });

  it("is configured from environment variables", () => {
    expect(() => RestAdapter.fromEnv({})).toThrow(/MCP_REST_BASE_URL/);
    const a = RestAdapter.fromEnv({ MCP_REST_BASE_URL: baseUrl, MCP_PRODUCT_NAME: "Acme", MCP_ITEM_DESCRIPTION: "orders" });
    expect(a.name).toBe("Acme");
    expect(a.itemDescription).toBe("orders");
  });
});

describe("defaultToItem", () => {
  it("accepts common field names and keeps scalar fields as metadata", () => {
    expect(defaultToItem({ uuid: "u1", subject: "Hi", body: "Text", priority: 2, tags: ["a"], updated_at: "2026-01-01" })).toEqual({
      id: "u1",
      title: "Hi",
      content: "Text",
      metadata: { priority: 2 },
      updatedAt: "2026-01-01",
    });
  });

  it("requires an id", () => {
    expect(() => defaultToItem({ title: "no id" })).toThrow(AdapterError);
  });
});
