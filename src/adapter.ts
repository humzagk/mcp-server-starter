/**
 * The adapter is the only thing you need to write to put your own product
 * behind this MCP server. Implement `search` and `get` for a read-only server;
 * add `list` to expose items as browsable resources, and `create` to offer a
 * write tool (only registered when writes are explicitly enabled).
 */

/** A single record in your product: a ticket, a document, an order, a customer... */
export interface Item {
  /** Stable identifier, used in tool calls and in `item://{id}` resource URIs. */
  id: string;
  /** Short human-readable name. */
  title: string;
  /** Main text body. Keep it plain text or Markdown; this is what the model reads. */
  content: string;
  /** Optional structured fields (status, owner, price, ...). */
  metadata?: Record<string, string | number | boolean | null>;
  /** ISO 8601 timestamp of the last change, if your product tracks it. */
  updatedAt?: string;
}

export interface NewItem {
  title: string;
  content: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface Page {
  items: Item[];
  /** Opaque cursor for the next page, or undefined when there are no more items. */
  nextCursor?: string;
}

export interface ProductAdapter {
  /** Name shown to the model, e.g. "Acme Helpdesk". */
  readonly name: string;
  /** One sentence describing what the items are, e.g. "support tickets". Used in tool descriptions. */
  readonly itemDescription: string;

  /** Full-text or keyword search. Return the best matches first, at most `limit`. */
  search(query: string, limit: number): Promise<Item[]>;
  /** Fetch one item, or `null` if it does not exist. */
  get(id: string): Promise<Item | null>;
  /** Optional: page through all items. Enables resource listing. */
  list?(limit: number, cursor?: string): Promise<Page>;
  /** Optional: create an item. Only exposed when the server is started with writes enabled. */
  create?(input: NewItem): Promise<Item>;
}

/**
 * Error type adapters can throw for problems that are safe to show to the model
 * (bad input, not permitted, upstream unavailable). Any other error is reported
 * as a generic failure so stack traces and secrets never reach the client.
 */
export class AdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdapterError";
  }
}
