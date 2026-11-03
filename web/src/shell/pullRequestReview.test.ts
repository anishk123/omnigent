import { describe, expect, it } from "vitest";
import type { PullRequestChangedFile } from "@/hooks/usePullRequests";
import {
  filterChangedPaths,
  pullRequestFileUrl,
  pullRequestRepoUrl,
  selectVisibleFiles,
} from "./pullRequestReview";

function changed(path: string, previous_path?: string): PullRequestChangedFile {
  return {
    path,
    name: path.split("/").pop()!,
    previous_path,
    status: previous_path ? "renamed" : "modified",
    lines_added: 1,
    lines_removed: 0,
    bytes: null,
    modified_at: null,
  };
}

const FILES = [
  changed("src/shell/PullRequestPanel.tsx"),
  changed("src/lib/clipboard.ts", "src/utils/copy.ts"),
  changed("README.md"),
];
const paths = (files: PullRequestChangedFile[]) => files.map((file) => file.path);

describe("filterChangedPaths", () => {
  it.each([
    ["", FILES.map((file) => file.path)],
    ["   ", FILES.map((file) => file.path)],
    ["pullrequest", ["src/shell/PullRequestPanel.tsx"]],
    [" README ", ["README.md"]],
    ["src\\shell\\", ["src/shell/PullRequestPanel.tsx"]],
    ["src/", ["src/shell/PullRequestPanel.tsx", "src/lib/clipboard.ts"]],
    ["utils/copy", ["src/lib/clipboard.ts"]],
    ["missing", []],
  ])("matches %j", (query, expected) => {
    expect(paths(filterChangedPaths(FILES, query))).toEqual(expected);
  });
});

describe("selectVisibleFiles", () => {
  it("returns every file for empty inputs", () => {
    expect(selectVisibleFiles(FILES, { pathFilter: "", hiddenPaths: new Set() })).toEqual(FILES);
  });

  it("combines the path filter with hidden paths", () => {
    const visible = selectVisibleFiles(FILES, {
      pathFilter: "src",
      hiddenPaths: new Set(["src/lib/clipboard.ts", "README.md"]),
    });
    expect(paths(visible)).toEqual(["src/shell/PullRequestPanel.tsx"]);
  });
});

describe("pullRequestRepoUrl", () => {
  it.each([
    ["github", "https://github.com/acme/app/pull/7", "https://github.com/acme/app"],
    ["github", "https://ghe.example.com/acme/app/pull/7", "https://ghe.example.com/acme/app"],
    ["gitlab", "https://gitlab.com/acme/app/-/merge_requests/7", "https://gitlab.com/acme/app"],
    [
      "azure_devops",
      "https://dev.azure.com/acme/web/_git/app/pullrequest/7",
      "https://dev.azure.com/acme/web/_git/app",
    ],
    ["github", "https://github.com/acme/app/issues/7", null],
    ["unknown", "https://github.com/acme/app/pull/7", null],
    [null, "https://github.com/acme/app/pull/7", null],
  ])("derives the repository for %s from %s", (provider, prUrl, expected) => {
    expect(pullRequestRepoUrl(provider, prUrl)).toBe(expected);
  });
});

describe("pullRequestFileUrl", () => {
  const BASE_REPO = {
    github: "https://github.com/acme/app",
    gitlab: "https://gitlab.com/acme/app",
    azure_devops: "https://dev.azure.com/acme/web/_git/app",
  };
  const FORK_REPO = {
    github: "https://github.com/fork/app",
    gitlab: "https://gitlab.com/fork/app",
    azure_devops: "https://dev.azure.com/fork/web/_git/app",
  };
  // Spaces, `#` and non-ASCII must be encoded segment by segment; `/` stays.
  const PATH = "src/a b#c/é.ts";
  const ENCODED = "src/a%20b%23c/%C3%A9.ts";
  const url = (
    provider: "github" | "gitlab" | "azure_devops",
    repo: string,
    sha: string,
    path: string,
  ) =>
    provider === "github"
      ? `${repo}/blob/${sha}/${path}`
      : provider === "gitlab"
        ? `${repo}/-/blob/${sha}/${path}`
        : `${repo}?path=/${path}&version=GC${sha}`;

  it.each(["github", "gitlab", "azure_devops"] as const)(
    "links a %s file to the head (fork) repository at the pinned head",
    (provider) => {
      const link = pullRequestFileUrl({
        provider,
        headRepoUrl: FORK_REPO[provider],
        baseRepoUrl: BASE_REPO[provider],
        headSha: "head1",
        baseSha: "base1",
        path: PATH,
        status: "modified",
      });
      expect(link).toBe(url(provider, FORK_REPO[provider], "head1", ENCODED));
    },
  );

  it.each(["github", "gitlab", "azure_devops"] as const)(
    "links a same-repo %s file to the head revision",
    (provider) => {
      const link = pullRequestFileUrl({
        provider,
        headRepoUrl: BASE_REPO[provider],
        baseRepoUrl: BASE_REPO[provider],
        headSha: "head1",
        baseSha: "base1",
        path: "README.md",
        status: "created",
      });
      expect(link).toBe(url(provider, BASE_REPO[provider], "head1", "README.md"));
    },
  );

  it.each(["github", "gitlab", "azure_devops"] as const)(
    "links a renamed %s file by its new path",
    (provider) => {
      const link = pullRequestFileUrl({
        provider,
        headRepoUrl: FORK_REPO[provider],
        baseRepoUrl: BASE_REPO[provider],
        headSha: "head1",
        baseSha: "base1",
        path: PATH,
        previousPath: "old/name.ts",
        status: "renamed",
      });
      expect(link).toBe(url(provider, FORK_REPO[provider], "head1", ENCODED));
    },
  );

  it.each(["github", "gitlab", "azure_devops"] as const)(
    "links a deleted %s file to the base repository at the base revision",
    (provider) => {
      const link = pullRequestFileUrl({
        provider,
        headRepoUrl: FORK_REPO[provider],
        baseRepoUrl: BASE_REPO[provider],
        headSha: "head1",
        baseSha: "base1",
        path: "old/gone.ts",
        status: "deleted",
      });
      expect(link).toBe(url(provider, BASE_REPO[provider], "base1", "old/gone.ts"));
    },
  );

  it("links a deleted file to the base revision when the head repository is absent", () => {
    const link = pullRequestFileUrl({
      provider: "github",
      baseRepoUrl: BASE_REPO.github,
      headSha: "head1",
      baseSha: "base1",
      path: "old/gone.ts",
      status: "deleted",
    });
    expect(link).toBe("https://github.com/acme/app/blob/base1/old/gone.ts");
  });

  it("uses the old path of a deleted file when the list carries one", () => {
    const link = pullRequestFileUrl({
      provider: "github",
      headRepoUrl: null,
      baseRepoUrl: BASE_REPO.github,
      headSha: "head1",
      baseSha: "base1",
      path: "new.ts",
      previousPath: "old.ts",
      status: "deleted",
    });
    expect(link).toBe("https://github.com/acme/app/blob/base1/old.ts");
  });

  it.each([
    ["null head repository", { headRepoUrl: null }],
    ["absent head repository (pre-PR-2 host)", { headRepoUrl: undefined }],
    ["an empty head repository", { headRepoUrl: "" }],
    ["an unknown head revision", { headSha: null }],
    ["a missing head revision", { headSha: undefined }],
    ["a non-https repository", { headRepoUrl: "http://github.com/fork/app" }],
    ["an unsupported provider", { provider: "bitbucket" }],
    ["no provider", { provider: null }],
  ])("returns null for %s", (_label, override) => {
    const link = pullRequestFileUrl({
      provider: "github",
      headRepoUrl: FORK_REPO.github,
      baseRepoUrl: BASE_REPO.github,
      headSha: "head1",
      baseSha: "base1",
      path: "README.md",
      status: "modified",
      ...override,
    });
    expect(link).toBeNull();
  });
});
