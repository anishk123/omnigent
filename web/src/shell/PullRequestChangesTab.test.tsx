import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Toaster } from "sonner";
import { Tabs } from "@/components/ui/tabs";
import { TooltipProvider } from "@/components/ui/tooltip";
import type * as UsePullRequestsModule from "@/hooks/usePullRequests";
import type { PullRequestChangedFile } from "@/hooks/usePullRequests";
import type * as ClipboardModule from "@/lib/clipboard";
import type { ReviewThread } from "@/lib/pullRequestReviewThreads";
import { PullRequestChangesTab } from "./PullRequestChangesTab";
import { useChangesViewState } from "./useChangesViewState";

const mocks = vi.hoisted(() => ({ copyText: vi.fn(async () => {}), mobile: false }));

vi.mock("@/hooks/usePullRequests", async (importOriginal) => ({
  ...(await importOriginal<typeof UsePullRequestsModule>()),
  usePullRequestReviewThreadComposer: () => ({
    draft: { pending: false, anchor: null },
    stale: false,
    selectLines: vi.fn(),
    cancel: vi.fn(),
  }),
}));
vi.mock("@/components/theme/useResolvedThemeMode", () => ({
  useResolvedThemeMode: () => "light",
}));
vi.mock("@/hooks/useIsMobileViewport", () => ({
  useIsMobileViewport: () => mocks.mobile,
}));
vi.mock("@/lib/clipboard", async (importOriginal) => ({
  ...(await importOriginal<typeof ClipboardModule>()),
  copyText: mocks.copyText,
}));
vi.mock("./PullRequestReviewThread", () => ({
  PullRequestReviewThread: ({ thread }: { thread: ReviewThread }) => (
    <div data-review-thread={thread.id}>{thread.path}</div>
  ),
}));

const changed = (path: string): PullRequestChangedFile => ({
  path,
  name: path,
  status: "modified",
  lines_added: 1,
  lines_removed: 0,
  bytes: null,
  modified_at: null,
});

const PR_URL = "https://github.com/acme/app/pull/1";
const FORK_URL = "https://github.com/fork/app";

/** The Changes tab's props for one PR; each test uses its own conversation id because view state is module-level. */
function tabProps(
  conversationId: string,
  {
    files = [changed("src/app.ts"), changed("src/util.ts"), changed("README.md")],
    pr = {},
    threads = [],
  }: {
    files?: PullRequestChangedFile[];
    pr?: Partial<React.ComponentProps<typeof PullRequestChangesTab>["pr"]>;
    threads?: ReviewThread[];
  } = {},
) {
  return {
    conversationId,
    data: {
      selected_pr_url: PR_URL,
      provider: "github",
      capabilities: {},
      auth: { selected_account: null },
    },
    pr: {
      url: PR_URL,
      head_sha: "head",
      base_sha: "base",
      state: "OPEN",
      head_repository_url: FORK_URL,
      ...pr,
    },
    prUrl: PR_URL,
    canEdit: false,
    selected: true,
    changes: {
      isLoading: false,
      error: null,
      data: { available: true, data: files, head_sha: "head", base_sha: "base" },
    },
    prDiff: { data: { head_sha: "head", base_sha: "base" }, isLoading: false },
    reviews: {
      page: { data: threads, head_sha: "head", base_sha: "base" },
      isFetching: false,
      loadComments: () => {},
      loadingComments: null,
    },
  } as unknown as React.ComponentProps<typeof PullRequestChangesTab>;
}

function tree(props: React.ComponentProps<typeof PullRequestChangesTab>) {
  return (
    <TooltipProvider>
      <Toaster />
      <Tabs value="changes">
        <PullRequestChangesTab {...props} />
      </Tabs>
    </TooltipProvider>
  );
}

/** The stacked list's sections, by path. */
function listedPaths(container: HTMLElement) {
  return [...container.querySelectorAll("[data-github-file]")].map((element) =>
    element.getAttribute("data-github-file"),
  );
}

/** The header button that expands or collapses one file's section. */
function fileToggle(container: HTMLElement, path: string) {
  const toggle = container.querySelector<HTMLElement>(
    `[data-github-file="${path}"] button[aria-expanded]`,
  );
  if (!toggle) throw new Error(`No section for ${path}`);
  return toggle;
}

function openMenu(path: string) {
  fireEvent.pointerDown(screen.getByRole("button", { name: `More actions for ${path}` }), {
    button: 0,
  });
}

describe("PullRequestChangesTab", () => {
  it("clears the path filter to navigate to a thread on a filtered-out file", async () => {
    const conversationId = "changes-tab-nav";
    const store = renderHook(() => useChangesViewState(conversationId, PR_URL));
    act(() => store.result.current.setPathFilter("a.ts"));
    const thread = { id: "t1", path: "b.ts", resolved: false } as ReviewThread;
    const props = tabProps(conversationId, {
      files: [changed("a.ts"), changed("b.ts")],
      threads: [thread],
    });
    render(tree(props));
    expect(screen.queryByRole("button", { name: /b\.ts/, expanded: true })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Next unresolved conversation" }));

    expect(store.result.current.pathFilter).toBe("");
    expect(screen.getByRole("button", { name: /b\.ts/, expanded: true })).toBeInTheDocument();
    expect(await screen.findByText("Filter cleared to show b.ts")).toBeInTheDocument();
  });

  it("filters the tree and list, keeps collapse state, and clears on Escape", () => {
    const conversationId = "changes-tab-filter";
    const { container } = render(tree(tabProps(conversationId)));
    const toggle = () => fileToggle(container, "src/app.ts");
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(toggle());
    expect(toggle()).toHaveAttribute("aria-expanded", "false");

    const filter = screen.getByRole("searchbox", { name: "Filter changed files" });
    fireEvent.change(filter, { target: { value: "UTIL" } });
    expect(listedPaths(container)).toEqual(["src/util.ts"]);
    expect(screen.queryAllByTitle("src/app.ts")).toHaveLength(0);
    expect(screen.getAllByTitle("src/util.ts")).toHaveLength(2);

    fireEvent.change(filter, { target: { value: "src\\" } });
    expect(listedPaths(container)).toEqual(["src/app.ts", "src/util.ts"]);

    fireEvent.keyDown(filter, { key: "Escape" });
    expect(filter).toHaveValue("");
    expect(listedPaths(container)).toEqual(["src/app.ts", "src/util.ts", "README.md"]);
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
  });

  it("shows an empty state for no matches and clears the filter from it", () => {
    const conversationId = "changes-tab-empty";
    const { container } = render(tree(tabProps(conversationId)));
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter changed files" }), {
      target: { value: "nothing-here" },
    });
    expect(screen.getByText('No changed files match "nothing-here"')).toBeInTheDocument();
    expect(listedPaths(container)).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Clear filter" }));
    expect(listedPaths(container)).toEqual(["src/app.ts", "src/util.ts", "README.md"]);
  });

  it("matches the previous path of a renamed file", () => {
    const conversationId = "changes-tab-rename-filter";
    const renamed = {
      ...changed("lib/new.ts"),
      status: "renamed" as const,
      previous_path: "src/old.ts",
    };
    const { container } = render(
      tree(tabProps(conversationId, { files: [renamed, changed("README.md")] })),
    );
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter changed files" }), {
      target: { value: "src/old" },
    });
    expect(listedPaths(container)).toEqual(["lib/new.ts"]);
  });

  it("copies the current path and the previous path of a renamed file", async () => {
    const conversationId = "changes-tab-copy";
    const renamed = {
      ...changed("lib/new.ts"),
      status: "renamed" as const,
      previous_path: "src/old.ts",
    };
    render(tree(tabProps(conversationId, { files: [renamed] })));

    fireEvent.click(screen.getByRole("button", { name: "Copy path lib/new.ts" }));
    expect(mocks.copyText).toHaveBeenLastCalledWith("lib/new.ts");
    expect(await screen.findByText("Copied path")).toBeInTheDocument();

    openMenu("lib/new.ts");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Copy previous path" }));
    expect(mocks.copyText).toHaveBeenLastCalledWith("src/old.ts");
    expect(await screen.findByText("Copied previous path")).toBeInTheDocument();
  });

  it("keeps Open on the rendered head after the polled head moves", () => {
    const conversationId = "changes-tab-open-pinned";
    const props = tabProps(conversationId, { files: [changed("src/app.ts")] });
    const { rerender } = render(tree(props));
    openMenu("src/app.ts");
    expect(screen.getByRole("menuitem", { name: "Open in GitHub" })).toHaveAttribute(
      "href",
      `${FORK_URL}/blob/head/src/app.ts`,
    );

    rerender(
      tree(
        tabProps(conversationId, {
          files: [changed("src/app.ts")],
          pr: { head_sha: "newer" },
        }),
      ),
    );
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    openMenu("src/app.ts");
    expect(screen.getByRole("menuitem", { name: "Open in GitHub" })).toHaveAttribute(
      "href",
      `${FORK_URL}/blob/head/src/app.ts`,
    );
  });

  it.each([
    {
      provider: "gitlab",
      display: {
        id: "gitlab",
        display_name: "GitLab",
        request_name: "merge request",
        number_prefix: "!",
      },
      prUrl: "https://gitlab.com/acme/app/-/merge_requests/1",
      fork: "https://gitlab.com/fork/app",
      label: "Open in GitLab",
      href: "https://gitlab.com/fork/app/-/blob/head/src/app.ts",
    },
    {
      provider: "azure_devops",
      display: {
        id: "azure_devops",
        display_name: "Azure DevOps",
        request_name: "pull request",
        number_prefix: "#",
      },
      prUrl: "https://dev.azure.com/acme/web/_git/app/pullrequest/1",
      fork: "https://dev.azure.com/fork/web/_git/app",
      label: "Open in Azure DevOps",
      href: "https://dev.azure.com/fork/web/_git/app?path=/src/app.ts&version=GChead",
    },
  ])("labels and links Open for $provider", ({ provider, display, prUrl, fork, label, href }) => {
    const props = tabProps(`changes-tab-${provider}`, {
      files: [changed("src/app.ts")],
      pr: { url: prUrl, head_repository_url: fork },
    });
    props.data = { ...props.data, provider, provider_display: display } as typeof props.data;
    render(tree(props));
    openMenu("src/app.ts");
    expect(screen.getByRole("menuitem", { name: label })).toHaveAttribute("href", href);
  });

  it("opens a deleted file at the base revision in the base repository", () => {
    const conversationId = "changes-tab-open-deleted";
    render(
      tree(tabProps(conversationId, { files: [{ ...changed("old.ts"), status: "deleted" }] })),
    );
    openMenu("old.ts");
    expect(screen.getByRole("menuitem", { name: "Open in GitHub" })).toHaveAttribute(
      "href",
      `${PR_URL.split("/pull/")[0]}/blob/base/old.ts`,
    );
  });

  it("disables Open for a non-deleted file when the head repository is absent", () => {
    const conversationId = "changes-tab-open-absent";
    // An explicit undefined reads like a host that predates the field.
    render(
      tree(
        tabProps(conversationId, {
          files: [changed("src/app.ts"), { ...changed("old.ts"), status: "deleted" }],
          pr: { head_repository_url: undefined },
        }),
      ),
    );
    openMenu("src/app.ts");
    const disabled = screen.getByRole("menuitem", { name: /Open in GitHub/ });
    expect(disabled).toHaveAttribute("data-disabled");
    expect(disabled).toHaveTextContent("Source repository unavailable");
    expect(disabled).not.toHaveAttribute("href");

    // A deleted file still opens from the base repository at the base revision.
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    openMenu("old.ts");
    expect(screen.getByRole("menuitem", { name: "Open in GitHub" })).toHaveAttribute(
      "href",
      "https://github.com/acme/app/blob/base/old.ts",
    );
  });

  it("puts every file action in the overflow menu on mobile", () => {
    mocks.mobile = true;
    try {
      const conversationId = "changes-tab-mobile";
      const { container } = render(tree(tabProps(conversationId)));
      expect(screen.queryByRole("button", { name: "Copy path src/app.ts" })).toBeNull();
      openMenu("src/app.ts");
      expect(screen.getByRole("menuitem", { name: "Copy path" })).toBeInTheDocument();
      expect(screen.getByRole("menuitem", { name: "Open in GitHub" })).toBeInTheDocument();
      fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

      // The sidebar starts collapsed on mobile: the filter opens inline above the list.
      expect(screen.queryByRole("searchbox", { name: "Filter changed files" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Show file filter" }));
      fireEvent.change(screen.getByRole("searchbox", { name: "Filter changed files" }), {
        target: { value: "readme" },
      });
      expect(listedPaths(container)).toEqual(["README.md"]);
      // Hiding the inline filter clears it, so the list is never narrowed out of sight.
      fireEvent.click(screen.getByRole("button", { name: "Hide file filter" }));
      expect(screen.queryByRole("searchbox", { name: "Filter changed files" })).toBeNull();
      expect(listedPaths(container)).toEqual(["src/app.ts", "src/util.ts", "README.md"]);
    } finally {
      mocks.mobile = false;
    }
  });

  it("reports a failed copy and keeps the sidebar filter open after collapse", async () => {
    mocks.copyText.mockRejectedValueOnce(new Error("denied"));
    const conversationId = "changes-tab-copy-failure";
    render(tree(tabProps(conversationId)));
    fireEvent.click(screen.getByRole("button", { name: "Copy path src/app.ts" }));
    expect(await screen.findByText("Couldn’t copy path")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: "Filter changed files" }), {
      target: { value: "util" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Hide file list" }));
    const inline = screen.getByRole("searchbox", { name: "Filter changed files" });
    expect(inline).toHaveValue("util");
    // Clearing with Escape must keep the same input mounted, so focus stays in it.
    fireEvent.keyDown(inline, { key: "Escape" });
    expect(screen.getByRole("searchbox", { name: "Filter changed files" })).toBe(inline);
    expect(inline).toHaveValue("");
  });

  it("groups threads on filtered-out files apart from earlier conversations", () => {
    const conversationId = "changes-tab-threads";
    const threadOn = (id: string, path: string) => ({ id, path, resolved: false }) as ReviewThread;
    const threads = [
      threadOn("t-app", "src/app.ts"),
      threadOn("t-util", "src/util.ts"),
      threadOn("t-gone", "deleted-upstream.ts"),
    ];
    const { container } = render(tree(tabProps(conversationId, { threads })));
    expect(container.querySelector('[data-review-thread="t-util"]')).not.toBeNull();
    expect(screen.queryByText("Earlier conversations and unavailable diffs")).not.toBeNull();

    fireEvent.change(screen.getByRole("searchbox", { name: "Filter changed files" }), {
      target: { value: "src/app" },
    });

    expect(container.querySelector('[data-review-thread="t-app"]')).not.toBeNull();
    expect(container.querySelector('[data-review-thread="t-util"]')).toBeNull();
    const earlier = screen.getByText("Earlier conversations and unavailable diffs").parentElement;
    expect(earlier!.querySelector('[data-review-thread="t-gone"]')).not.toBeNull();
    expect(earlier!.querySelector('[data-review-thread="t-util"]')).toBeNull();
  });
});
