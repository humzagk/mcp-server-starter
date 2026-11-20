import { AdapterError, type Item, type NewItem, type ProductAdapter } from "../adapter.js";

/**
 * Generic adapter for a JSON REST API. Point it at your product's API with
 * environment variables, then adjust `toItem` (or pass your own) to map your
 * API's records onto the `Item` shape.
 *
 * Expected endpoints (paths are configurable):
 *   GET  {baseUrl}/items?q={query}&limit={limit}  -> array of records, or { items: [...] }
 *   GET  {baseUrl}/items/{id}                     -> one record (404 if missing)
 *   POST {baseUrl}/items                          -> created record (only used with writes enabled)
 */
export interface RestAdapterOptions {
  baseUrl: string;
  /** Sent as `Authorization: Bearer <apiKey>`. Never logged or returned to the client. */
  apiKey?: string;
  name?: string;
  itemDescription?: string;
  searchPath?: string;
  itemPath?: string;
  createPath?: string;
  timeoutMs?: number;
  /** Map one record from your API onto an Item. */
  toItem?: (record: Record<string, unknown>) => Item;
  fetchImpl?: typeof fetch;
}

export class RestAdapter implements ProductAdapter {
  readonly name: string;
  readonly itemDescription: string;
  private readonly opts: Required<Omit<RestAdapterOptions, "apiKey" | "fetchImpl">> & {
    apiKey?: string;
    fetchImpl: typeof fetch;
  };

  constructor(options: RestAdapterOptions) {
    if (!/^https?:\/\//.test(options.baseUrl)) {
      throw new Error("RestAdapter: baseUrl must start with http:// or https://");
    }
    this.name = options.name ?? "REST API";
    this.itemDescription = options.itemDescription ?? "records";
    this.opts = {
      baseUrl: options.baseUrl.replace(/\/+$/, ""),
      apiKey: options.apiKey,
      name: this.name,
      itemDescription: this.itemDescription,
      searchPath: options.searchPath ?? "/items",
      itemPath: options.itemPath ?? "/items/{id}",
      createPath: options.createPath ?? "/items",
      timeoutMs: options.timeoutMs ?? 10_000,
      toItem: options.toItem ?? defaultToItem,
      fetchImpl: options.fetchImpl ?? fetch,
    };
  }

  /** Build an adapter from MCP_REST_* environment variables. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): RestAdapter {
    const baseUrl = env.MCP_REST_BASE_URL;
    if (!baseUrl) throw new Error("Set MCP_REST_BASE_URL to use the REST adapter");
    return new RestAdapter({
      baseUrl,
      apiKey: env.MCP_REST_API_KEY,
      name: env.MCP_PRODUCT_NAME,
      itemDescription: env.MCP_ITEM_DESCRIPTION,
      searchPath: env.MCP_REST_SEARCH_PATH,
      itemPath: env.MCP_REST_ITEM_PATH,
      createPath: env.MCP_REST_CREATE_PATH,
    });
  }

  async search(query: string, limit: number): Promise<Item[]> {
    const url = new URL(this.opts.baseUrl + this.opts.searchPath);
    url.searchParams.set("q", query);
    url.searchParams.set("limit", String(limit));
    const body = await this.request("GET", url);
    const records = Array.isArray(body) ? body : (body as { items?: unknown })?.items;
    if (!Array.isArray(records)) throw new AdapterError("Unexpected search response from the API");
    return records.slice(0, limit).map((r) => this.opts.toItem(r as Record<string, unknown>));
  }

  async get(id: string): Promise<Item | null> {
    const url = new URL(this.opts.baseUrl + this.opts.itemPath.replace("{id}", encodeURIComponent(id)));
    const body = await this.request("GET", url, undefined, { allow404: true });
    return body === null ? null : this.opts.toItem(body as Record<string, unknown>);
  }

  async create(input: NewItem): Promise<Item> {
    const url = new URL(this.opts.baseUrl + this.opts.createPath);
    const body = await this.request("POST", url, input);
    return this.opts.toItem(body as Record<string, unknown>);
  }

  private async request(
    method: string,
    url: URL,
    payload?: unknown,
    { allow404 = false } = {},
  ): Promise<unknown> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (payload !== undefined) headers["Content-Type"] = "application/json";
    if (this.opts.apiKey) headers.Authorization = `Bearer ${this.opts.apiKey}`;

    let res: Response;
    try {
      res = await this.opts.fetchImpl(url, {
        method,
        headers,
        body: payload === undefined ? undefined : JSON.stringify(payload),
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch (err) {
      const reason = err instanceof Error && err.name === "TimeoutError" ? "timed out" : "could not be reached";
      throw new AdapterError(`The ${this.name} API ${reason}`);
    }

    if (allow404 && res.status === 404) return null;
    if (res.status === 401 || res.status === 403) {
      throw new AdapterError(`The ${this.name} API rejected the credentials (HTTP ${res.status})`);
    }
    if (res.status === 429) throw new AdapterError(`The ${this.name} API rate limit was hit; try again shortly`);
    if (!res.ok) throw new AdapterError(`The ${this.name} API returned HTTP ${res.status}`);
    try {
      return await res.json();
    } catch {
      throw new AdapterError(`The ${this.name} API returned a response that is not JSON`);
    }
  }
}

const MAPPED_FIELDS = new Set([
  "id", "uuid", "key", "title", "name", "subject", "content", "body", "description", "text",
  "updatedAt", "updated_at", "modified",
]);

/** Default mapping: accepts common field names (id/title|name/content|body|description). */
export function defaultToItem(record: Record<string, unknown>): Item {
  const id = record.id ?? record.uuid ?? record.key;
  if (id === undefined || id === null) throw new AdapterError("API record has no id field");
  const title = record.title ?? record.name ?? record.subject ?? String(id);
  const content = record.content ?? record.body ?? record.description ?? record.text ?? "";
  const metadata: Item["metadata"] = {};
  for (const [k, v] of Object.entries(record)) {
    if (MAPPED_FIELDS.has(k)) continue;
    if (v === null || ["string", "number", "boolean"].includes(typeof v)) metadata[k] = v as string | number | boolean | null;
  }
  const updated = record.updatedAt ?? record.updated_at ?? record.modified;
  return {
    id: String(id),
    title: String(title),
    content: typeof content === "string" ? content : JSON.stringify(content),
    metadata: Object.keys(metadata).length ? metadata : undefined,
    updatedAt: typeof updated === "string" ? updated : undefined,
  };
}
