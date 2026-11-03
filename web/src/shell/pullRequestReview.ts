// Pure helpers for the pull request Changes tab's review navigation.

import type { PullRequestChangedFile } from "@/hooks/usePullRequests";

/** Files whose path or previous path contains `query`, ignoring case and slash direction. */
export function filterChangedPaths(
  files: PullRequestChangedFile[],
  query: string,
): PullRequestChangedFile[] {
  const needle = query.trim().replaceAll("\\", "/").toLowerCase();
  if (!needle) return files;
  return files.filter((file) =>
    [file.path, file.previous_path].some((path) =>
      path?.replaceAll("\\", "/").toLowerCase().includes(needle),
    ),
  );
}

/** Files matching the path filter, excluding those whose current `path` is in `hiddenPaths`. */
export function selectVisibleFiles(
  files: PullRequestChangedFile[],
  opts: { pathFilter: string; hiddenPaths: ReadonlySet<string> },
): PullRequestChangedFile[] {
  const matching = filterChangedPaths(files, opts.pathFilter);
  return opts.hiddenPaths.size
    ? matching.filter((file) => !opts.hiddenPaths.has(file.path))
    : matching;
}

const PR_PATH_MARKERS: Record<string, string> = {
  github: "/pull/",
  gitlab: "/-/merge_requests/",
  azure_devops: "/pullrequest/",
};

/** The web URL of the repository a PR URL belongs to, or null when the PR URL doesn't match the provider. */
export function pullRequestRepoUrl(provider: string | null, prUrl: string): string | null {
  const marker =
    provider && Object.hasOwn(PR_PATH_MARKERS, provider) ? PR_PATH_MARKERS[provider] : "";
  if (!marker) return null;
  // The marker must be followed by the PR number at the end, so a repository path
  // that contains the marker (e.g. `pull/issues/7`) doesn't match.
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^(https?://.+?)${escaped}\\d+(?:[/?#].*)?$`).exec(prUrl);
  return match ? match[1] : null;
}

/**
 * The provider page for a changed file at the revision the list shows. Deleted files
 * link to the base repository at the base revision; others use the head (fork)
 * repository. Null when the repository or revision is unknown or the provider is unsupported.
 */
export function pullRequestFileUrl({
  provider,
  headRepoUrl,
  baseRepoUrl,
  headSha,
  baseSha,
  path,
  previousPath,
  status,
}: {
  provider: string | null;
  /** Absent from hosts that predate the field, so treat it as unknown. */
  headRepoUrl?: string | null;
  baseRepoUrl: string | null;
  headSha: string | null | undefined;
  baseSha: string | null | undefined;
  path: string;
  previousPath?: string | null;
  status: PullRequestChangedFile["status"];
}): string | null {
  const deleted = status === "deleted";
  const repo = deleted ? baseRepoUrl : headRepoUrl;
  const sha = deleted ? baseSha : headSha;
  if (!repo || !sha || !repo.startsWith("https://")) return null;
  const filePath = deleted ? (previousPath ?? path) : path;
  const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
  switch (provider) {
    case "github":
      return `${repo}/blob/${sha}/${encodedPath}`;
    case "gitlab":
      return `${repo}/-/blob/${sha}/${encodedPath}`;
    case "azure_devops":
      return `${repo}?path=/${encodedPath}&version=GC${sha}`;
    default:
      return null;
  }
}
