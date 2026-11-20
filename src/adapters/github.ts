import { AdapterError, type Item, type ProductAdapter } from "../adapter.js";

/**
 * Real-world example: expose one GitHub repository's issues and pull requests.
 * Shows how to wrap an existing product API — authentication, search syntax,
 * mapping records onto `Item`, and turning API failures into safe errors.
 *
 *   MCP_ADAPTER=github GITHUB_REPO=owner/name [GITHUB_TOKEN=...] mcp-server-starter
 *
 * Read-only on purpose: it implements search and get, not create.
 */
export interface GitHubIssuesOptions {
  repo: string; // "owner/name"
  token?: string;
  apiUrl?: string;
  fetchImpl?: typeof fetch;
}

interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  user?: { login: string } | null;
  labels?: Array<{ name?: string } | string>;
  comments?: number;
  pull_request?: unknown;
  updated_at?: string;
}

export class GitHubIssuesAdapter implements ProductAdapter {
  readonly name: string;
  readonly itemDescription = "issues and pull requests";
  private readonly apiUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: GitHubIssuesOptions) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(options.repo)) throw new Error('GITHUB_REPO must look like "owner/name"');
    this.name = `GitHub ${options.repo}`;
    this.apiUrl = (options.apiUrl ?? "https://api.github.com").replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): GitHubIssuesAdapter {
    if (!env.GITHUB_REPO) throw new Error("Set GITHUB_REPO=owner/name to use the GitHub adapter");
    return new GitHubIssuesAdapter({ repo: env.GITHUB_REPO, token: env.GITHUB_TOKEN });
  }

  async search(query: string, limit: number): Promise<Item[]> {
    const url = new URL(`${this.apiUrl}/search/issues`);
    url.searchParams.set("q", `${query} repo:${this.options.repo}`);
    url.searchParams.set("per_page", String(Math.min(limit, 100)));
    const body = (await this.request(url)) as { items?: GitHubIssue[] } | null;
    return (body?.items ?? []).slice(0, limit).map(toItem);
  }

  async get(id: string): Promise<Item | null> {
    if (!/^\d+$/.test(id)) return null; // ids are issue numbers
    const issue = (await this.request(new URL(`${this.apiUrl}/repos/${this.options.repo}/issues/${id}`))) as GitHubIssue | null;
    return issue ? toItem(issue) : null;
  }

  private async request(url: URL): Promise<unknown> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "mcp-server-starter",
    };
    if (this.options.token) headers.Authorization = `Bearer ${this.options.token}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, { headers, signal: AbortSignal.timeout(10_000) });
    } catch {
      throw new AdapterError("GitHub could not be reached");
    }
    if (res.status === 404) return null;
    if (res.status === 401) throw new AdapterError("GitHub rejected the token (HTTP 401)");
    if (res.status === 403 || res.status === 429) {
      throw new AdapterError("GitHub rate limit reached; set GITHUB_TOKEN for a higher limit or try again later");
    }
    if (res.status === 422) throw new AdapterError("GitHub could not parse that search query");
    if (!res.ok) throw new AdapterError(`GitHub returned HTTP ${res.status}`);
    return res.json();
  }
}

function toItem(issue: GitHubIssue): Item {
  const labels = (issue.labels ?? []).map((l) => (typeof l === "string" ? l : l.name)).filter(Boolean);
  return {
    id: String(issue.number),
    title: `#${issue.number} ${issue.title}`,
    content: issue.body?.trim() || "(no description)",
    metadata: {
      kind: issue.pull_request ? "pull request" : "issue",
      state: issue.state,
      author: issue.user?.login ?? null,
      labels: labels.join(", ") || null,
      comments: issue.comments ?? 0,
      url: issue.html_url,
    },
    updatedAt: issue.updated_at,
  };
}
