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
    // A repository named like the PR route marker must not cut the URL early.
    ["github", "https://github.com/pull/app/pull/7", "https://github.com/pull/app"],
    ["gitlab", "https://gitlab.com/acme/app/-/merge_requests/7", "https://gitlab.com/acme/app"],
    [
      "azure_devops",
      "https://dev.azure.com/acme/web/_git/app/pullrequest/7",
      "https://dev.azure.com/acme/web/_git/app",
    ],
    [
      "azure_devops",
      "https://dev.azure.com/acme/pullrequest/_git/pullrequest/pullrequest/7",
      "https://dev.azure.com/acme/pullrequest/_git/pullrequest",
    ],
    ["github", "https://github.com/acme/app/issues/7", null],
    ["github", "https://github.com/acme/pull/issues/7", null],
    ["github", "https://github.com/pull/123/pull/7", "https://github.com/pull/123"],
    [
      "azure_devops",
      "https://dev.azure.com/pullrequest/2024/_git/app/pullrequest/9",
      "https://dev.azure.com/pullrequest/2024/_git/app",
    ],
    ["github", "https://github.com/acme/app/pull/7/files", "https://github.com/acme/app"],
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

  // Spaces, `#` and non-ASCII are encoded per segment, and `/` stays.
  it.each([
    [
      "github",
      "https://github.com/fork/app/blob/head1/src/a%20b%23c/%C3%A9.ts",
      "https://github.com/acme/app/blob/head1/README.md",
    ],
    [
      "gitlab",
      "https://gitlab.com/fork/app/-/blob/head1/src/a%20b%23c/%C3%A9.ts",
      "https://gitlab.com/acme/app/-/blob/head1/README.md",
    ],
    [
      "azure_devops",
      "https://dev.azure.com/fork/web/_git/app?path=/src/a%20b%23c/%C3%A9.ts&version=GChead1",
      "https://dev.azure.com/acme/web/_git/app?path=/README.md&version=GChead1",
    ],
  ] as const)(
    "links a %s file from a fork, and a same-repo file, at the head",
    (provider, forkLink, sameRepoLink) => {
      const input = {
        headSha: "head1",
        baseSha: "base1",
        baseRepoUrl: BASE_REPO[provider],
        provider,
        status: "modified" as const,
      };
      expect(
        pullRequestFileUrl({
          ...input,
          headRepoUrl: FORK_REPO[provider],
          path: "src/a b#c/é.ts",
        }),
      ).toBe(forkLink);
      expect(
        pullRequestFileUrl({
          ...input,
          headRepoUrl: BASE_REPO[provider],
          path: "README.md",
          status: "created",
        }),
      ).toBe(sameRepoLink);
    },
  );

  it.each([
    ["github", "https://github.com/fork/app/blob/head1/src/new%20name.ts"],
    ["gitlab", "https://gitlab.com/fork/app/-/blob/head1/src/new%20name.ts"],
    [
      "azure_devops",
      "https://dev.azure.com/fork/web/_git/app?path=/src/new%20name.ts&version=GChead1",
    ],
  ] as const)("links a renamed %s file by its new path", (provider, link) => {
    expect(
      pullRequestFileUrl({
        provider,
        headRepoUrl: FORK_REPO[provider],
        baseRepoUrl: BASE_REPO[provider],
        headSha: "head1",
        baseSha: "base1",
        path: "src/new name.ts",
        previousPath: "old/name.ts",
        status: "renamed",
      }),
    ).toBe(link);
  });

  it.each([
    ["github", "https://github.com/acme/app/blob/base1/old/gone.ts"],
    ["gitlab", "https://gitlab.com/acme/app/-/blob/base1/old/gone.ts"],
    ["azure_devops", "https://dev.azure.com/acme/web/_git/app?path=/old/gone.ts&version=GCbase1"],
  ] as const)(
    "links a deleted %s file to the base repository at the base revision",
    (provider, link) => {
      expect(
        pullRequestFileUrl({
          provider,
          headRepoUrl: FORK_REPO[provider],
          baseRepoUrl: BASE_REPO[provider],
          headSha: "head1",
          baseSha: "base1",
          path: "old/gone.ts",
          status: "deleted",
        }),
      ).toBe(link);
    },
  );

  it("links a deleted file to the base revision when the head repository is absent", () => {
    expect(
      pullRequestFileUrl({
        provider: "github",
        baseRepoUrl: BASE_REPO.github,
        headSha: "head1",
        baseSha: "base1",
        path: "old/gone.ts",
        status: "deleted",
      }),
    ).toBe("https://github.com/acme/app/blob/base1/old/gone.ts");
  });

  it("uses the old path of a deleted file when the list carries one", () => {
    expect(
      pullRequestFileUrl({
        provider: "github",
        headRepoUrl: null,
        baseRepoUrl: BASE_REPO.github,
        headSha: "head1",
        baseSha: "base1",
        path: "new.ts",
        previousPath: "old.ts",
        status: "deleted",
      }),
    ).toBe("https://github.com/acme/app/blob/base1/old.ts");
  });

  it("links a deleted file in a repository named like the PR route marker", () => {
    expect(
      pullRequestFileUrl({
        provider: "github",
        baseRepoUrl: pullRequestRepoUrl("github", "https://github.com/pull/app/pull/7"),
        headSha: "head1",
        baseSha: "base1",
        path: "old/gone.ts",
        status: "deleted",
      }),
    ).toBe("https://github.com/pull/app/blob/base1/old/gone.ts");
  });

  it("keeps a numeric repository path whole for a deleted file", () => {
    expect(
      pullRequestFileUrl({
        provider: "github",
        baseRepoUrl: pullRequestRepoUrl("github", "https://github.com/pull/123/pull/7"),
        headSha: "head1",
        baseSha: "base1",
        path: "old/gone.ts",
        status: "deleted",
      }),
    ).toBe("https://github.com/pull/123/blob/base1/old/gone.ts");
  });

  it.each([
    ["null head repository", { status: "modified" as const, headRepoUrl: null }],
    [
      "absent head repository (older host)",
      { status: "modified" as const, headRepoUrl: undefined },
    ],
    ["an empty head repository", { status: "modified" as const, headRepoUrl: "" }],
    ["an unknown head revision", { status: "modified" as const, headSha: null }],
    ["a missing head revision", { status: "modified" as const, headSha: undefined }],
    [
      "a non-https head repository",
      { status: "modified" as const, headRepoUrl: "http://github.com/fork/app" },
    ],
    ["an unsupported provider", { status: "modified" as const, provider: "bitbucket" }],
    ["no provider", { status: "modified" as const, provider: null }],
    ["a deleted file with no base repository", { status: "deleted" as const, baseRepoUrl: null }],
    ["a deleted file with no base revision", { status: "deleted" as const, baseSha: null }],
    [
      "a deleted file with a non-https base repository",
      { status: "deleted" as const, baseRepoUrl: "http://github.com/acme/app" },
    ],
  ])("returns null for %s", (_label, override) => {
    const link = pullRequestFileUrl({
      provider: "github",
      headRepoUrl: FORK_REPO.github,
      baseRepoUrl: BASE_REPO.github,
      headSha: "head1",
      baseSha: "base1",
      path: "README.md",
      ...override,
    });
    expect(link).toBeNull();
  });
});
