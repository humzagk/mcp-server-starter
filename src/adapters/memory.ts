import { randomUUID } from "node:crypto";
import type { Item, NewItem, Page, ProductAdapter } from "../adapter.js";

/**
 * In-memory adapter with a few sample help-centre articles. Useful for trying
 * the server out, for tests, and as the simplest possible reference adapter.
 */
export class MemoryAdapter implements ProductAdapter {
  readonly name: string;
  readonly itemDescription: string;
  private items = new Map<string, Item>();

  constructor(options: { name?: string; itemDescription?: string; items?: Item[] } = {}) {
    this.name = options.name ?? "Example Help Centre";
    this.itemDescription = options.itemDescription ?? "help-centre articles";
    for (const item of options.items ?? SAMPLE_ITEMS) this.items.set(item.id, item);
  }

  async search(query: string, limit: number): Promise<Item[]> {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];
    const scored: Array<[number, Item]> = [];
    for (const item of this.items.values()) {
      const haystack = `${item.title} ${item.title} ${item.content}`.toLowerCase(); // title counts double
      const score = terms.reduce((s, t) => s + countOccurrences(haystack, t), 0);
      if (score > 0) scored.push([score, item]);
    }
    return scored
      .sort((a, b) => b[0] - a[0] || a[1].title.localeCompare(b[1].title))
      .slice(0, limit)
      .map(([, item]) => item);
  }

  async get(id: string): Promise<Item | null> {
    return this.items.get(id) ?? null;
  }

  async list(limit: number, cursor?: string): Promise<Page> {
    const all = [...this.items.values()].sort((a, b) => a.id.localeCompare(b.id));
    const start = cursor ? Number(cursor) : 0;
    const items = all.slice(start, start + limit);
    const next = start + limit;
    return { items, nextCursor: next < all.length ? String(next) : undefined };
  }

  async create(input: NewItem): Promise<Item> {
    const item: Item = { id: randomUUID(), ...input, updatedAt: new Date().toISOString() };
    this.items.set(item.id, item);
    return item;
  }
}

/** Count words in `haystack` that start with `term` ("export" matches "exports", "data" does not match "metadata"). */
function countOccurrences(haystack: string, term: string): number {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return haystack.match(new RegExp(`(?<![\\p{L}\\p{N}])${escaped}`, "gu"))?.length ?? 0;
}

export const SAMPLE_ITEMS: Item[] = [
  {
    id: "reset-password",
    title: "Resetting your password",
    content:
      "Open Settings > Security and choose Reset password. A reset link is emailed to the account address and expires after 30 minutes. If the email does not arrive, check spam or ask an admin to resend it.",
    metadata: { category: "account", views: 1840 },
    updatedAt: "2026-09-02T10:00:00Z",
  },
  {
    id: "export-data",
    title: "Exporting your data",
    content:
      "Admins can export all workspace data from Settings > Data > Export. Exports are generated as a ZIP of CSV files and are available for 7 days. Large workspaces can take up to an hour.",
    metadata: { category: "data", views: 960 },
    updatedAt: "2026-08-14T09:30:00Z",
  },
  {
    id: "api-rate-limits",
    title: "API rate limits",
    content:
      "The REST API allows 600 requests per minute per token. Responses include X-RateLimit-Remaining. When the limit is exceeded the API returns HTTP 429 with a Retry-After header; clients should back off and retry.",
    metadata: { category: "developers", views: 2210 },
    updatedAt: "2026-10-01T15:45:00Z",
  },
  {
    id: "sso-setup",
    title: "Setting up single sign-on (SSO)",
    content:
      "SSO supports SAML 2.0 and OIDC. Add the identity provider metadata under Settings > Security > SSO, test with one account, then enforce SSO for the workspace. Keep one admin with password login as a fallback.",
    metadata: { category: "account", views: 730 },
    updatedAt: "2026-07-20T12:00:00Z",
  },
];
