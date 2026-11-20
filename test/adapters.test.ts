import { describe, expect, it } from "vitest";
import { AdapterError } from "../src/adapter.js";
import { GitHubIssuesAdapter } from "../src/adapters/github.js";
import { MemoryAdapter } from "../src/adapters/memory.js";

describe("MemoryAdapter search", () => {
  it("matches word prefixes, not substrings inside other words", async () => {
    const a = new MemoryAdapter();
    expect((await a.search("data", 10)).map((i) => i.id)).toEqual(["export-data"]); // not "metadata" in sso-setup
    expect((await a.search("export", 10)).map((i) => i.id)).toEqual(["export-data"]); // "Exports" counts
  });

  it("treats regex characters in queries literally", async () => {
    expect(await new MemoryAdapter().search("(.*", 10)).toEqual([]);
  });

  it("pages through items with a cursor", async () => {
    const a = new MemoryAdapter();
    const first = await a.list(3);
    expect(first.items).toHaveLength(3);
    const second = await a.list(3, first.nextCursor);
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeUndefined();
  });
});

describe("GitHubIssuesAdapter", () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fakeFetch = (status: number, body: unknown): typeof fetch =>
    (async (url: URL | string, init?: RequestInit) => {
      calls.push({ url: String(url), headers: init?.headers as Record<string, string> });
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch;

  const issue = {
    number: 42,
    title: "Crash on start",
    body: "Steps to reproduce...",
    state: "open",
    html_url: "https://github.com/o/r/issues/42",
    user: { login: "alice" },
    labels: [{ name: "bug" }],
    comments: 3,
    updated_at: "2026-10-01T00:00:00Z",
  };

  it("scopes search to the repo and maps issues onto items", async () => {
    const a = new GitHubIssuesAdapter({ repo: "o/r", token: "t", fetchImpl: fakeFetch(200, { items: [issue] }) });
    const [item] = await a.search("crash", 5);
    expect(new URL(calls.at(-1)!.url).searchParams.get("q")).toBe("crash repo:o/r");
    expect(calls.at(-1)!.headers.Authorization).toBe("Bearer t");
    expect(item).toMatchObject({ id: "42", title: "#42 Crash on start", metadata: { kind: "issue", labels: "bug", author: "alice" } });
  });

  it("returns null for unknown or non-numeric ids", async () => {
    const a = new GitHubIssuesAdapter({ repo: "o/r", fetchImpl: fakeFetch(404, {}) });
    expect(await a.get("7")).toBeNull();
    expect(await a.get("not-a-number")).toBeNull();
  });

  it("explains rate limiting without leaking the token", async () => {
    const a = new GitHubIssuesAdapter({ repo: "o/r", token: "secret", fetchImpl: fakeFetch(403, {}) });
    const err = await a.search("x", 5).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdapterError);
    expect(String(err)).toMatch(/rate limit/);
    expect(String(err)).not.toContain("secret");
  });

  it("validates the repo name", () => {
    expect(() => new GitHubIssuesAdapter({ repo: "not a repo" })).toThrow(/owner\/name/);
    expect(() => GitHubIssuesAdapter.fromEnv({})).toThrow(/GITHUB_REPO/);
  });
});
