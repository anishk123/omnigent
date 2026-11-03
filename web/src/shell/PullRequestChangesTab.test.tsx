import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Tabs } from "@/components/ui/tabs";
import { TooltipProvider } from "@/components/ui/tooltip";
import type * as UsePullRequestsModule from "@/hooks/usePullRequests";
import type { PullRequestChangedFile } from "@/hooks/usePullRequests";
import type { ReviewThread } from "@/lib/pullRequestReviewThreads";
import type { PullRequestIdentity } from "@/lib/pullRequestViewed";
import type * as SonnerModule from "sonner";
import { PullRequestChangesTab } from "./PullRequestChangesTab";
import { useChangesViewState } from "./useChangesViewState";

const toastError = vi.hoisted(() => vi.fn());
vi.mock("sonner", async (importOriginal) => {
  const actual = await importOriginal<typeof SonnerModule>();
  return { ...actual, toast: { ...actual.toast, error: toastError } };
});
vi.mock("@/hooks/useViewerId", () => ({ useViewerId: () => "alice" }));
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

describe("PullRequestChangesTab", () => {
  it("clears the path filter to navigate to a thread on a filtered-out file", () => {
    const conversationId = "changes-tab-nav";
    const prUrl = "https://github.com/o/r/pull/1";
    const store = renderHook(() => useChangesViewState(conversationId, prUrl));
    act(() => store.result.current.setPathFilter("a.ts"));
    const thread = { id: "t1", path: "b.ts", resolved: false } as ReviewThread;
    const props = {
      conversationId,
      data: {
        selected_pr_url: prUrl,
        capabilities: {},
        auth: { selected_account: null },
      },
      pr: { url: prUrl, head_sha: "head", base_sha: "base", state: "OPEN" },
      prUrl,
      canEdit: false,
      selected: true,
      changes: { data: { available: true, data: [changed("a.ts"), changed("b.ts")] } },
      prDiff: { data: { head_sha: "head", base_sha: "base" }, isLoading: false },
      reviews: {
        page: { data: [thread], head_sha: "head", base_sha: "base" },
        isFetching: false,
        loadComments: () => {},
        loadingComments: null,
      },
    } as unknown as React.ComponentProps<typeof PullRequestChangesTab>;
    render(
      <TooltipProvider>
        <Tabs value="changes">
          <PullRequestChangesTab {...props} />
        </Tabs>
      </TooltipProvider>,
    );
    expect(screen.queryByRole("button", { name: /b\.ts/, expanded: true })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Next unresolved conversation" }));

    expect(store.result.current.pathFilter).toBe("");
    expect(screen.getByRole("button", { name: /b\.ts/, expanded: true })).toBeInTheDocument();
  });
});

const PR_URL = "https://github.com/o/r/pull/1";
const IDENTITY: PullRequestIdentity = {
  provider: "github",
  host: "github.com",
  repository: "o/r",
  number: 1,
};

function viewedTab({
  conversationId,
  head = "head1",
  files = [changed("a.ts"), changed("b.ts")],
  hasMore = false,
  identity = IDENTITY,
  threads = [],
  diffHead = head,
  listHead = head,
}: {
  conversationId: string;
  head?: string;
  files?: PullRequestChangedFile[];
  hasMore?: boolean;
  identity?: PullRequestIdentity | null;
  threads?: ReviewThread[];
  /** The head the loaded patch was fetched for, when it differs from the list's. */
  diffHead?: string;
  /** The list's pinned head; null models a provider that doesn't pin revisions. */
  listHead?: string | null;
}) {
  const props = {
    conversationId,
    data: {
      selected_pr_url: PR_URL,
      base_ref: "main",
      capabilities: {},
      auth: { selected_account: null },
    },
    pr: { url: PR_URL, number: 1, head_sha: head, base_sha: "base", state: "OPEN" },
    prUrl: PR_URL,
    canEdit: false,
    selected: true,
    changes: { data: { available: true, data: files, has_more: hasMore, head_sha: listHead } },
    prDiff: { data: { head_sha: diffHead, base_sha: "base" }, isLoading: false },
    reviews: {
      page: { data: threads, head_sha: head, base_sha: "base" },
      isFetching: false,
      loadComments: () => {},
      loadingComments: null,
    },
    identity,
  } as unknown as React.ComponentProps<typeof PullRequestChangesTab>;
  return (
    <TooltipProvider>
      <Tabs value="changes">
        <PullRequestChangesTab {...props} />
      </Tabs>
    </TooltipProvider>
  );
}

/** The file's section root; its first button is the header's collapse toggle. */
function fileSection(path: string): HTMLElement {
  const section = document.querySelector<HTMLElement>(`[data-github-file="${path}"]`);
  if (!section) throw new Error(`No section for ${path}`);
  return section;
}

function isCollapsed(path: string): boolean {
  return fileSection(path).querySelector("button")?.getAttribute("aria-expanded") === "false";
}

/** Whether the file has a section in the diff list (titles also match the sidebar row). */
function isListed(path: string): boolean {
  return document.querySelector(`[data-github-file="${path}"]`) !== null;
}

const viewedBox = (path: string) => screen.getByRole("checkbox", { name: `Viewed ${path}` });

describe("PullRequestChangesTab viewed files", () => {
  beforeEach(() => {
    localStorage.clear();
    // A cleared-storage event also drops in-memory fallback values from earlier tests.
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
    toastError.mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("collapses a file when it is marked viewed and keeps the mark after a reload", () => {
    const first = render(viewedTab({ conversationId: "viewed-reload" }));
    fireEvent.click(viewedBox("a.ts"));

    expect(viewedBox("a.ts")).toBeChecked();
    expect(isCollapsed("a.ts")).toBe(true);
    expect(screen.getByText("Viewed,", { exact: true })).toBeInTheDocument();
    expect(screen.getByText("1 / 2 files viewed")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Files viewed" })).toHaveAttribute(
      "aria-valuenow",
      "50",
    );
    first.unmount();

    // A fresh render reads the same localStorage, as a reload would.
    render(viewedTab({ conversationId: "viewed-reload" }));
    expect(viewedBox("a.ts")).toBeChecked();
    expect(isCollapsed("a.ts")).toBe(true);
    expect(screen.getByText("1 / 2 files viewed")).toBeInTheDocument();
  });

  it("leaves a file collapsed when its mark is removed", () => {
    render(viewedTab({ conversationId: "viewed-unmark" }));
    fireEvent.click(viewedBox("a.ts"));
    fireEvent.click(viewedBox("a.ts"));

    expect(viewedBox("a.ts")).not.toBeChecked();
    expect(isCollapsed("a.ts")).toBe(true);
    expect(screen.getByText("0 / 2 files viewed")).toBeInTheDocument();
  });

  it("hides viewed files together with the path filter", () => {
    const store = renderHook(() => useChangesViewState("viewed-hide", PR_URL));
    const files = [changed("src/a.ts"), changed("src/b.ts"), changed("docs/a.md")];
    render(viewedTab({ conversationId: "viewed-hide", files }));
    fireEvent.click(viewedBox("src/a.ts"));
    fireEvent.click(screen.getByRole("checkbox", { name: "Hide viewed" }));

    expect(isListed("src/a.ts")).toBe(false);
    expect(isListed("src/b.ts")).toBe(true);
    expect(isListed("docs/a.md")).toBe(true);

    act(() => store.result.current.setPathFilter("src"));
    expect(isListed("docs/a.md")).toBe(false);
    expect(isListed("src/b.ts")).toBe(true);
    expect(isListed("src/a.ts")).toBe(false);
  });

  it("shows an all-viewed state when hiding viewed files leaves nothing", () => {
    render(viewedTab({ conversationId: "viewed-all" }));
    fireEvent.click(viewedBox("a.ts"));
    fireEvent.click(viewedBox("b.ts"));
    fireEvent.click(screen.getByRole("checkbox", { name: "Hide viewed" }));

    expect(screen.getByText("All 2 files viewed")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show viewed" }));

    expect(screen.getByRole("checkbox", { name: "Hide viewed" })).not.toBeChecked();
    expect(isListed("a.ts")).toBe(true);
  });

  it("resets viewed marks on a new head and shows a dismissible notice", () => {
    const { rerender } = render(viewedTab({ conversationId: "viewed-head", head: "head1" }));
    fireEvent.click(viewedBox("a.ts"));

    rerender(viewedTab({ conversationId: "viewed-head", head: "head2" }));
    expect(viewedBox("a.ts")).not.toBeChecked();
    expect(screen.getByText("0 / 2 files viewed")).toBeInTheDocument();
    expect(screen.getByText(/viewed marks were reset/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(/viewed marks were reset/)).toBeNull();
    rerender(viewedTab({ conversationId: "viewed-head", head: "head2" }));
    expect(screen.queryByText(/viewed marks were reset/)).toBeNull();
  });

  it("withholds viewed state when the list is not pinned to a head", () => {
    // A provider that ignores revision pinning can serve a newer patch than the polled head.
    render(viewedTab({ conversationId: "viewed-unpinned", listHead: null }));

    expect(viewedBox("a.ts")).toBeDisabled();
    expect(screen.queryByText(/files viewed/)).toBeNull();
  });

  it("waits for the list and the patch to agree on a head", () => {
    const { rerender } = render(viewedTab({ conversationId: "viewed-mismatch", head: "head1" }));
    fireEvent.click(viewedBox("a.ts"));

    // The list moved to head2 while the patch on screen is still head1.
    rerender(viewedTab({ conversationId: "viewed-mismatch", head: "head2", diffHead: "head1" }));
    expect(viewedBox("a.ts")).toBeDisabled();
    expect(screen.queryByText(/viewed marks were reset/)).toBeNull();

    rerender(viewedTab({ conversationId: "viewed-mismatch", head: "head2" }));
    expect(viewedBox("a.ts")).not.toBeChecked();
    expect(screen.getByText(/viewed marks were reset/)).toBeInTheDocument();
  });

  it("clears the reset notice once a file is marked on the new head", () => {
    const { rerender } = render(viewedTab({ conversationId: "viewed-new-mark", head: "head1" }));
    fireEvent.click(viewedBox("a.ts"));
    rerender(viewedTab({ conversationId: "viewed-new-mark", head: "head2" }));
    expect(screen.getByText(/viewed marks were reset/)).toBeInTheDocument();

    fireEvent.click(viewedBox("b.ts"));
    expect(screen.queryByText(/viewed marks were reset/)).toBeNull();
    expect(screen.getByText("1 / 2 files viewed")).toBeInTheDocument();
  });

  it("keeps viewed marks when a poll returns the same head", () => {
    const { rerender } = render(viewedTab({ conversationId: "viewed-same", head: "head1" }));
    fireEvent.click(viewedBox("a.ts"));

    rerender(viewedTab({ conversationId: "viewed-same", head: "head1" }));
    expect(viewedBox("a.ts")).toBeChecked();
    expect(screen.queryByText(/viewed marks were reset/)).toBeNull();
    expect(screen.getByText("1 / 2 files viewed")).toBeInTheDocument();
  });

  it("keeps marks in memory and warns once when storage fails", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    render(viewedTab({ conversationId: "viewed-storage" }));
    fireEvent.click(viewedBox("a.ts"));
    fireEvent.click(viewedBox("b.ts"));

    expect(viewedBox("a.ts")).toBeChecked();
    expect(viewedBox("b.ts")).toBeChecked();
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith(
      "Viewed files can't be saved on this device.",
      expect.objectContaining({ id: "pr-viewed-persistence" }),
    );
  });

  it("disables the viewed controls until the PR identity is known", () => {
    render(viewedTab({ conversationId: "viewed-unknown", identity: null }));

    expect(viewedBox("a.ts")).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Hide viewed" })).toBeDisabled();
    expect(screen.queryByText(/files viewed/)).toBeNull();
  });

  it("marks the progress as partial when the file list is truncated", () => {
    render(viewedTab({ conversationId: "viewed-partial", hasMore: true }));

    expect(screen.getByText("0 / 2 files viewed (partial)")).toBeInTheDocument();
  });

  it("un-hides a viewed file when navigating to its conversation", () => {
    const store = renderHook(() => useChangesViewState("viewed-thread", PR_URL));
    const thread = { id: "t1", path: "a.ts", resolved: false } as ReviewThread;
    render(viewedTab({ conversationId: "viewed-thread", threads: [thread] }));
    fireEvent.click(viewedBox("a.ts"));
    act(() => store.result.current.setHideViewed(true));
    expect(isListed("a.ts")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Next unresolved conversation" }));

    expect(store.result.current.hideViewed).toBe(false);
    expect(isListed("a.ts")).toBe(true);
  });
});
