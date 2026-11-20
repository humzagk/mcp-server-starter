import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod";
import { AdapterError, type Item, type ProductAdapter } from "./adapter.js";

export interface ServerOptions {
  /** Register write tools (create_item). Off by default so a server is read-only unless you opt in. */
  allowWrites?: boolean;
  /** Maximum results a search may return. */
  maxResults?: number;
  /** Characters of content included per search result. */
  snippetLength?: number;
  version?: string;
}

const itemSummary = z.object({
  id: z.string(),
  title: z.string(),
  snippet: z.string(),
  uri: z.string(),
});

const itemFull = z.object({
  id: z.string(),
  title: z.string(),
  content: z.string(),
  metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  updatedAt: z.string().optional(),
  uri: z.string(),
});

export const itemUri = (id: string) => `item://${encodeURIComponent(id)}`;

/**
 * Build an MCP server for any product, given an adapter.
 *
 * Exposes:
 *   tools      search_items, get_item, and (opt-in) create_item
 *   resources  item://{id}  (listable when the adapter implements `list`)
 *   prompts    summarize_item
 */
export function createServer(adapter: ProductAdapter, options: ServerOptions = {}): McpServer {
  const { allowWrites = false, maxResults = 25, snippetLength = 200, version = "0.1.0" } = options;

  const server = new McpServer(
    { name: slug(adapter.name), title: adapter.name, version },
    {
      instructions:
        `Tools for searching and reading ${adapter.itemDescription} in ${adapter.name}. ` +
        "Use search_items to find relevant items, then get_item to read one in full.",
    },
  );

  server.registerTool(
    "search_items",
    {
      title: `Search ${adapter.name}`,
      description: `Search ${adapter.itemDescription} in ${adapter.name}. Returns the best matches with a short snippet; call get_item for the full text.`,
      inputSchema: {
        query: z.string().trim().min(1).max(500).describe("Keywords or a natural-language question"),
        limit: z.number().int().min(1).max(maxResults).default(10).describe(`Maximum results (1-${maxResults})`),
      },
      outputSchema: { items: z.array(itemSummary) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, limit }) =>
      guard(async () => {
        const items = (await adapter.search(query, limit)).slice(0, limit).map((item) => ({
          id: item.id,
          title: item.title,
          snippet: truncate(item.content, snippetLength),
          uri: itemUri(item.id),
        }));
        const text = items.length
          ? items.map((i) => `- ${i.title} (id: ${i.id})\n  ${i.snippet}`).join("\n")
          : `No ${adapter.itemDescription} matched "${query}".`;
        return { content: [{ type: "text", text }], structuredContent: { items } };
      }),
  );

  server.registerTool(
    "get_item",
    {
      title: "Get item",
      description: `Read one of the ${adapter.itemDescription} in full, by id.`,
      inputSchema: { id: z.string().min(1).max(200).describe("The item id, as returned by search_items") },
      outputSchema: itemFull.shape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id }) =>
      guard(async () => {
        const item = await adapter.get(id);
        if (!item) return errorResult(`No item with id "${id}" exists.`);
        return { content: [{ type: "text", text: formatItem(item) }], structuredContent: toFull(item) };
      }),
  );

  if (allowWrites && adapter.create) {
    const create = adapter.create.bind(adapter);
    server.registerTool(
      "create_item",
      {
        title: "Create item",
        description: `Create a new item among the ${adapter.itemDescription} in ${adapter.name}.`,
        inputSchema: {
          title: z.string().trim().min(1).max(300),
          content: z.string().max(50_000),
        },
        outputSchema: itemFull.shape,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      async ({ title, content }) =>
        guard(async () => {
          const item = await create({ title, content });
          return {
            content: [{ type: "text", text: `Created "${item.title}" (id: ${item.id}).` }],
            structuredContent: toFull(item),
          };
        }),
    );
  }

  const list = adapter.list?.bind(adapter);
  server.registerResource(
    "item",
    new ResourceTemplate("item://{id}", {
      list: list
        ? async () => {
            const { items } = await list(100);
            return {
              resources: items.map((item) => ({
                uri: itemUri(item.id),
                name: item.title,
                mimeType: "text/markdown",
              })),
            };
          }
        : undefined,
    }),
    { title: `${adapter.name} item`, description: `One of the ${adapter.itemDescription}`, mimeType: "text/markdown" },
    async (uri, variables) => {
      const id = decodeURIComponent(String(variables.id));
      const item = await adapter.get(id);
      if (!item) throw new Error(`No item with id "${id}" exists.`);
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: formatItem(item) }] };
    },
  );

  server.registerPrompt(
    "summarize_item",
    {
      title: "Summarise an item",
      description: `Summarise one of the ${adapter.itemDescription} for a busy reader.`,
      argsSchema: { id: z.string().min(1).describe("The item id") },
    },
    async ({ id }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "resource",
            resource: { uri: itemUri(id), mimeType: "text/markdown", text: await itemTextOrNotice(adapter, id) },
          },
        },
        {
          role: "user",
          content: { type: "text", text: "Summarise the item above in three bullet points, then list any action items." },
        },
      ],
    }),
  );

  return server;
}

/** Run a tool body, turning adapter failures into MCP tool errors the model can see and react to. */
async function guard(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AdapterError) return errorResult(err.message);
    console.error("Unexpected adapter error:", err); // stderr only: stdout carries the MCP protocol
    return errorResult("The request failed due to an internal error.");
  }
}

function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

async function itemTextOrNotice(adapter: ProductAdapter, id: string): Promise<string> {
  const item = await adapter.get(id);
  return item ? formatItem(item) : `(No item with id "${id}" exists.)`;
}

function toFull(item: Item) {
  return { ...item, uri: itemUri(item.id) };
}

export function formatItem(item: Item): string {
  const meta = Object.entries(item.metadata ?? {}).map(([k, v]) => `- **${k}:** ${v}`);
  if (item.updatedAt) meta.push(`- **updated:** ${item.updatedAt}`);
  return [`# ${item.title}`, "", item.content, ...(meta.length ? ["", ...meta] : []), "", `id: ${item.id}`].join("\n");
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "mcp-server";
}
