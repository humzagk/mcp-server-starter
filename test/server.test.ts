import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { AdapterError, type ProductAdapter } from "../src/adapter.js";
import { MemoryAdapter } from "../src/adapters/memory.js";
import { createServer, type ServerOptions } from "../src/server.js";

async function connect(adapter: ProductAdapter = new MemoryAdapter(), options?: ServerOptions) {
  const server = createServer(adapter, options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const text = (result: { content?: unknown }) =>
  (result.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? "").join("\n");

describe("tools", () => {
  it("is read-only by default", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["get_item", "search_items"]);
    for (const tool of tools) expect(tool.annotations?.readOnlyHint).toBe(true);
  });

  it("registers create_item only when writes are enabled and the adapter supports it", async () => {
    const withWrites = await connect(new MemoryAdapter(), { allowWrites: true });
    expect((await withWrites.listTools()).tools.map((t) => t.name)).toContain("create_item");

    const readOnlyAdapter: ProductAdapter = { name: "RO", itemDescription: "docs", search: async () => [], get: async () => null };
    const noCreate = await connect(readOnlyAdapter, { allowWrites: true });
    expect((await noCreate.listTools()).tools.map((t) => t.name)).not.toContain("create_item");
  });

  it("search_items returns ranked matches as text and structured content", async () => {
    const client = await connect();
    const result = await client.callTool({ name: "search_items", arguments: { query: "password reset" } });
    expect(result.isError).toBeFalsy();
    const { items } = result.structuredContent as { items: Array<{ id: string; uri: string; snippet: string }> };
    expect(items[0]?.id).toBe("reset-password");
    expect(items[0]?.uri).toBe("item://reset-password");
    expect(text(result)).toContain("Resetting your password");
  });

  it("search_items respects the limit and reports no matches clearly", async () => {
    const client = await connect();
    const limited = await client.callTool({ name: "search_items", arguments: { query: "settings", limit: 1 } });
    expect((limited.structuredContent as { items: unknown[] }).items).toHaveLength(1);

    const none = await client.callTool({ name: "search_items", arguments: { query: "kubernetes" } });
    expect((none.structuredContent as { items: unknown[] }).items).toHaveLength(0);
    expect(text(none)).toMatch(/No .* matched/);
  });

  it("rejects invalid arguments", async () => {
    const client = await connect();
    const result = await client.callTool({ name: "search_items", arguments: { query: "", limit: 1000 } });
    expect(result.isError).toBe(true);
  });

  it("get_item returns the full item, and a tool error for unknown ids", async () => {
    const client = await connect();
    const found = await client.callTool({ name: "get_item", arguments: { id: "api-rate-limits" } });
    expect((found.structuredContent as { content: string }).content).toContain("HTTP 429");

    const missing = await client.callTool({ name: "get_item", arguments: { id: "nope" } });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toContain('No item with id "nope"');
  });

  it("create_item adds an item that can then be found", async () => {
    const client = await connect(new MemoryAdapter(), { allowWrites: true });
    const created = await client.callTool({
      name: "create_item",
      arguments: { title: "Billing FAQ", content: "Invoices are sent on the first of the month." },
    });
    const { id } = created.structuredContent as { id: string };
    const found = await client.callTool({ name: "search_items", arguments: { query: "invoices" } });
    expect((found.structuredContent as { items: Array<{ id: string }> }).items[0]?.id).toBe(id);
  });

  it("shows AdapterError messages but hides unexpected errors", async () => {
    const failing = (err: Error): ProductAdapter => ({
      name: "Broken",
      itemDescription: "things",
      search: async () => {
        throw err;
      },
      get: async () => null,
    });
    const friendly = await connect(failing(new AdapterError("Upstream is down for maintenance")));
    const r1 = await friendly.callTool({ name: "search_items", arguments: { query: "x" } });
    expect(r1.isError).toBe(true);
    expect(text(r1)).toBe("Upstream is down for maintenance");

    const errorLog = console.error;
    console.error = () => {};
    try {
      const hidden = await connect(failing(new Error("password=hunter2 at db.internal:5432")));
      const r2 = await hidden.callTool({ name: "search_items", arguments: { query: "x" } });
      expect(r2.isError).toBe(true);
      expect(text(r2)).not.toContain("hunter2");
    } finally {
      console.error = errorLog;
    }
  });
});

describe("resources and prompts", () => {
  it("lists and reads items as resources", async () => {
    const client = await connect();
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toContain("item://sso-setup");

    const { contents } = await client.readResource({ uri: "item://sso-setup" });
    expect(contents[0]?.text).toContain("# Setting up single sign-on (SSO)");
  });

  it("round-trips ids that need URI encoding", async () => {
    const adapter = new MemoryAdapter({ items: [{ id: "a/b c", title: "Odd id", content: "body" }] });
    const client = await connect(adapter);
    const { resources } = await client.listResources();
    expect(resources[0]?.uri).toBe("item://a%2Fb%20c");
    const { contents } = await client.readResource({ uri: resources[0]!.uri });
    expect(contents[0]?.text).toContain("# Odd id");
  });

  it("summarize_item embeds the item and an instruction", async () => {
    const client = await connect();
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(["summarize_item"]);

    const { messages } = await client.getPrompt({ name: "summarize_item", arguments: { id: "export-data" } });
    expect(messages).toHaveLength(2);
    expect(JSON.stringify(messages[0])).toContain("Exporting your data");
  });
});
