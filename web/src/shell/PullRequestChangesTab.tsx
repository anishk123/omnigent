// The pull request panel's Changes tab: a toolbar, a jump-to-file sidebar tree
// and every changed file's diff stacked in one scroll view.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  Columns2Icon,
  FolderIcon,
  Loader2Icon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  Rows2Icon,
} from "lucide-react";
import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { TabsContent } from "@/components/ui/tabs";
import { useResolvedThemeMode } from "@/components/theme/useResolvedThemeMode";
import { useIsMobileViewport } from "@/hooks/useIsMobileViewport";
import { useResizableColumn } from "@/hooks/useResizableColumn";
import type { usePullRequestReviewThreads } from "@/hooks/usePullRequestReviewThreads";
import { RunnerOfflineError } from "@/hooks/useWorkspaceChangedFiles";
import {
  fetchPullRequestFileContents,
  type NormalizedPullRequestInfo,
  type PullRequest,
  type PullRequestChangedFile,
  type usePullRequestChangedFiles,
  type usePullRequestDiff,
} from "@/hooks/usePullRequests";
import { readFileViewPreferences, writeFileViewPreferences } from "@/lib/fileViewPreferences";
import { PULL_REQUEST_DIFF_THEME, type ReviewThread } from "@/lib/pullRequestReviewThreads";
import { useViewedFiles, type PullRequestIdentity } from "@/lib/pullRequestViewed";
import { cn } from "@/lib/utils";
import {
  DiffStat,
  IconButton,
  PullRequestFileSection,
  STATUS_META,
  type DiffOptions,
} from "./PullRequestFileSection";
import { PullRequestReviewThread, type ReviewThreadContext } from "./PullRequestReviewThread";
import { PullRequestViewedProgress, PullRequestViewedToggle } from "./PullRequestViewedControls";
import { filterChangedPaths, selectVisibleFiles } from "./pullRequestReview";
import { useChangesViewState } from "./useChangesViewState";

/** Centered muted message filling the panel — the shared loading/transient shell. */
export function PanelMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-ui text-muted-foreground">
      {children}
    </div>
  );
}

// ── Sidebar file tree ────────────────────────────────────────────────────
// The changed files group into a folder tree. A single-child directory chain
// collapses into one row (VS Code "compact folders"): a lone change under
// omnigent/runner/x.py shows an "omnigent/runner" row, not two nested folders.
// Files are leaves that jump the diff scroll to their section; folders toggle.

interface TreeFileNode {
  type: "file";
  name: string;
  file: PullRequestChangedFile;
}
interface TreeDirNode {
  type: "dir";
  /** Display name, possibly a compacted chain like "a/b/c". */
  name: string;
  /** Full path of the deepest folder in the chain — the collapse key. */
  path: string;
  children: SidebarTree[];
}
type SidebarTree = TreeFileNode | TreeDirNode;

/** Directories before files, each group kept in first-encounter order. */
function dirsFirst(nodes: SidebarTree[]): SidebarTree[] {
  return [...nodes.filter((n) => n.type === "dir"), ...nodes.filter((n) => n.type === "file")];
}

/** Fold single-dir-child chains into one node (children are compacted first,
 *  so one merge per level suffices). */
function compactNode(node: SidebarTree): SidebarTree {
  if (node.type === "file") return node;
  const children = node.children.map(compactNode);
  if (children.length === 1 && children[0].type === "dir") {
    const only = children[0];
    return {
      type: "dir",
      name: `${node.name}/${only.name}`,
      path: only.path,
      children: only.children,
    };
  }
  return { type: "dir", name: node.name, path: node.path, children: dirsFirst(children) };
}

/** Build the compacted folder tree for the changed-files sidebar. */
function buildSidebarTree(files: PullRequestChangedFile[]): SidebarTree[] {
  const root: TreeDirNode = { type: "dir", name: "", path: "", children: [] };
  for (const file of files) {
    const parts = file.path.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      let dir = node.children.find((c): c is TreeDirNode => c.type === "dir" && c.name === part);
      if (!dir) {
        dir = { type: "dir", name: part, path: parts.slice(0, i + 1).join("/"), children: [] };
        node.children.push(dir);
      }
      node = dir;
    }
    node.children.push({ type: "file", name: parts[parts.length - 1], file });
  }
  return dirsFirst(root.children.map(compactNode));
}

// VS Code–style tree indentation, tuned for the narrow sidebar.
const TREE_INDENT_STEP = 10;
const TREE_BASE_PAD = 8;
const treeIndent = (depth: number) => depth * TREE_INDENT_STEP + TREE_BASE_PAD;

/**
 * One node in the sidebar file tree — a collapsible folder or a file leaf.
 * Names truncate on the LEFT (rtl) so the end of the path — the most specific
 * part — stays visible; the name isn't `flex-1`, so short names still sit
 * beside their icon rather than drifting right.
 */
function SidebarNode({
  node,
  depth,
  activePath,
  onSelectFile,
  collapsedDirs,
  onToggleDir,
  viewedPaths,
}: {
  node: SidebarTree;
  depth: number;
  activePath: string | null;
  onSelectFile: (path: string) => void;
  collapsedDirs: ReadonlySet<string>;
  onToggleDir: (path: string) => void;
  viewedPaths: ReadonlySet<string>;
}) {
  if (node.type === "file") {
    const meta = STATUS_META[node.file.status];
    const StatusIcon = meta.Icon;
    const viewed = viewedPaths.has(node.file.path);
    return (
      <button
        type="button"
        onClick={() => onSelectFile(node.file.path)}
        title={node.file.path}
        style={{ paddingLeft: `${treeIndent(depth)}px` }}
        className={cn(
          "flex w-full items-center gap-1.5 py-1 pr-2 text-left text-ui hover:bg-muted/60",
          node.file.path === activePath && "bg-muted",
        )}
      >
        {/* The chevron column shows a check for viewed files and stays
            empty otherwise, so the status icon lines up under a folder's icon. */}
        <span className="flex size-3.5 shrink-0 items-center justify-center" aria-hidden>
          {viewed && <CheckIcon className="size-3 text-muted-foreground" />}
        </span>
        {viewed && <span className="sr-only">Viewed, </span>}
        <StatusIcon aria-hidden className={cn("size-3.5 shrink-0", meta.className)} />
        <span className={cn("min-w-0 truncate [direction:rtl]", viewed && "text-muted-foreground")}>
          <bdi>{node.name}</bdi>
        </span>
        <span className="ml-auto flex shrink-0 items-center">
          <DiffStat file={node.file} />
        </span>
      </button>
    );
  }

  const open = !collapsedDirs.has(node.path);
  return (
    <>
      <button
        type="button"
        onClick={() => onToggleDir(node.path)}
        aria-expanded={open}
        title={node.path}
        style={{ paddingLeft: `${treeIndent(depth)}px` }}
        className="flex w-full items-center gap-1.5 py-1 pr-2 text-left text-ui hover:bg-muted/60"
      >
        <ChevronRightIcon
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
        <FolderIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate font-medium [direction:rtl]">
          <bdi>{node.name}</bdi>
        </span>
      </button>
      {open &&
        node.children.map((child) => (
          <SidebarNode
            key={child.type === "file" ? child.file.path : child.path}
            node={child}
            depth={depth + 1}
            activePath={activePath}
            onSelectFile={onSelectFile}
            collapsedDirs={collapsedDirs}
            onToggleDir={onToggleDir}
            viewedPaths={viewedPaths}
          />
        ))}
    </>
  );
}

/** The Changes controls row; `navigation` and `progress` are slots for review tools. */
function ChangesToolbar({
  showFileControls,
  sidebarCollapsed,
  onToggleSidebar,
  canNavigateThreads,
  onNavigateThread,
  loadingThreads,
  diffStyle,
  onToggleDiffStyle,
  allCollapsed,
  onToggleAll,
  navigation,
  progress,
}: {
  showFileControls: boolean;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  canNavigateThreads: boolean;
  onNavigateThread: (direction: number) => void;
  loadingThreads: boolean;
  diffStyle: "unified" | "split";
  onToggleDiffStyle: () => void;
  allCollapsed: boolean;
  onToggleAll: () => void;
  navigation?: React.ReactNode;
  progress?: React.ReactNode;
}) {
  return (
    <div className="flex w-full shrink-0 items-center justify-between gap-2 border-b border-border px-2 py-1">
      <div className="flex items-center gap-0.5">
        {showFileControls && (
          <IconButton
            label={sidebarCollapsed ? "Show file list" : "Hide file list"}
            onClick={onToggleSidebar}
            className="size-5 text-muted-foreground"
          >
            {sidebarCollapsed ? (
              <PanelLeftOpenIcon className="size-3.5" />
            ) : (
              <PanelLeftCloseIcon className="size-3.5" />
            )}
          </IconButton>
        )}
        {canNavigateThreads && (
          <>
            <IconButton
              label="Previous unresolved conversation"
              onClick={() => onNavigateThread(-1)}
              className="size-5 text-muted-foreground"
            >
              <ChevronUpIcon className="size-3.5" />
            </IconButton>
            <IconButton
              label="Next unresolved conversation"
              onClick={() => onNavigateThread(1)}
              className="size-5 text-muted-foreground"
            >
              <ChevronDownIcon className="size-3.5" />
            </IconButton>
          </>
        )}
        {navigation}
      </div>
      <div className="flex items-center gap-0.5">
        {progress}
        {loadingThreads && (
          <span
            role="status"
            className="mr-1 flex items-center gap-1 whitespace-nowrap text-xs text-muted-foreground"
          >
            Loading review threads
            <Loader2Icon className="size-3 animate-spin" aria-hidden="true" />
          </span>
        )}
        {showFileControls && (
          <>
            <IconButton
              label={diffStyle === "split" ? "Switch to unified view" : "Switch to split view"}
              onClick={onToggleDiffStyle}
              className="size-5 text-muted-foreground"
            >
              {diffStyle === "split" ? (
                <Rows2Icon className="size-3.5" />
              ) : (
                <Columns2Icon className="size-3.5" />
              )}
            </IconButton>
            <IconButton
              label={allCollapsed ? "Expand all diffs" : "Collapse all diffs"}
              onClick={onToggleAll}
              className="size-5 text-muted-foreground"
            >
              {allCollapsed ? (
                <ChevronsUpDownIcon className="size-3.5" />
              ) : (
                <ChevronsDownUpIcon className="size-3.5" />
              )}
            </IconButton>
          </>
        )}
      </div>
    </div>
  );
}

/** The resizable file-list column; `filter` is a slot above the tree. */
function ChangesSidebar({
  width,
  handleProps,
  filter,
  children,
}: {
  width: number;
  handleProps: ReturnType<typeof useResizableColumn>["handleProps"];
  filter?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{ width: `${width}px` }}
      className="relative shrink-0 overflow-y-auto border-r border-border pb-1"
    >
      {/* Drag the right edge to resize the file list. */}
      <div
        {...handleProps}
        aria-label="Resize file list"
        className="absolute inset-y-0 right-0 z-10 w-1 cursor-col-resize transition-colors hover:bg-primary/30 active:bg-primary/50"
      />
      {filter}
      {children}
    </div>
  );
}

const NO_HIDDEN_PATHS: ReadonlySet<string> = new Set();

/**
 * The Changes tab content. Mounted beside the other tabs' content (it renders its
 * own TabsContent) so collapse and scroll-spy state survive tab switches.
 */
export function PullRequestChangesTab({
  conversationId,
  data,
  pr,
  prUrl,
  canEdit,
  selected,
  changes,
  prDiff,
  reviews,
  identity,
}: {
  conversationId: string;
  data: NormalizedPullRequestInfo;
  pr: PullRequest;
  /** The PR URL the diff queries use. */
  prUrl: string | undefined;
  canEdit: boolean;
  /** The Changes tab is the active tab. */
  selected: boolean;
  changes: ReturnType<typeof usePullRequestChangedFiles>;
  prDiff: ReturnType<typeof usePullRequestDiff>;
  reviews: ReturnType<typeof usePullRequestReviewThreads>;
  /** The PR's server identity, for the viewed-file key; null when unknown. */
  identity: PullRequestIdentity | null;
}) {
  const baseRef = data.base_ref ?? undefined;
  const headSha = pr.head_sha;
  const baseSha = pr.base_sha;
  const mobile = useIsMobileViewport();
  const view = useChangesViewState(conversationId, data.selected_pr_url ?? pr.url);
  const { revealedPaths, reveal, clearReveal } = view;
  // The head the shown patch was fetched for. Viewed state needs both the list and the diff
  // pinned to the same head; unpinned providers (GitLab, Azure) can't prove it, so marks are withheld.
  const pinnedHead = changes.data?.head_sha ?? null;
  const renderedHead = pinnedHead && prDiff.data?.head_sha === pinnedHead ? pinnedHead : null;
  const viewedFiles = useViewedFiles(identity, renderedHead);

  const themeType = useResolvedThemeMode();
  // Diff layout is the app-global FileViewer preference (unified/split); seed
  // from the persisted value and write toggles back so the choice carries over.
  const [diffStyle, setDiffStyle] = useState<"unified" | "split">(() =>
    !mobile && readFileViewPreferences().diffLayout === "split" ? "split" : "unified",
  );
  const toggleDiffStyle = useCallback(() => {
    setDiffStyle((prev) => {
      const next = prev === "split" ? "unified" : "split";
      writeFileViewPreferences({ ...readFileViewPreferences(), diffLayout: next });
      return next;
    });
  }, []);

  const files = useMemo<PullRequestChangedFile[]>(() => changes.data?.data ?? [], [changes.data]);
  // One filtered list drives the tree, sections, threads and collapse all so they never disagree.
  const hiddenPaths = view.hideViewed ? viewedFiles.viewed : NO_HIDDEN_PATHS;
  const visibleFiles = useMemo(
    () => selectVisibleFiles(files, { pathFilter: view.pathFilter, hiddenPaths }),
    [files, view.pathFilter, hiddenPaths],
  );
  const viewedCount = files.filter((file) => viewedFiles.viewed.has(file.path)).length;
  // Hide viewed has emptied every file the path filter still matches.
  const matchingCount = filterChangedPaths(files, view.pathFilter).length;
  const allViewed = view.hideViewed && visibleFiles.length === 0 && matchingCount > 0;
  // The sidebar groups the flat file list into a compacted folder tree (the
  // diff scroll below stays linear, in file order).
  const fileTree = useMemo(() => buildSidebarTree(visibleFiles), [visibleFiles]);

  // Per-file collapse is lifted here so the toolbar's "expand/collapse all" can
  // drive every section; a path in the set is collapsed unless it is revealed.
  const [collapsedPaths, setCollapsedPaths] = useState<ReadonlySet<string>>(() => new Set());
  const isCollapsed = useCallback(
    (path: string) => collapsedPaths.has(path) && !revealedPaths.has(path),
    [collapsedPaths, revealedPaths],
  );
  // Viewed files start collapsed once per rendered head. A collapse that marks introduced
  // expands again on a new head, since its mark was reset; the reader's own collapses stay.
  const [seed, setSeed] = useState<{ head: string | null; owned: ReadonlySet<string> }>({
    head: null,
    owned: new Set(),
  });
  if (viewedFiles.available && renderedHead !== seed.head) {
    // A path is the reader's own collapse unless the previous head's marks collapsed it.
    const owned = new Set(
      [...viewedFiles.viewed].filter((path) => !collapsedPaths.has(path) || seed.owned.has(path)),
    );
    setSeed({ head: renderedHead, owned });
    setCollapsedPaths(
      (prev) =>
        new Set([...prev].filter((path) => !seed.owned.has(path)).concat([...viewedFiles.viewed])),
    );
  }
  // A manual toggle hands the file's collapse to the reader.
  const releaseMarkCollapse = useCallback((paths: Iterable<string>) => {
    setSeed((prev) => {
      const owned = new Set(prev.owned);
      for (const path of paths) owned.delete(path);
      return { ...prev, owned };
    });
  }, []);
  // Marking a file collapses it; unmarking leaves its current state alone.
  const toggleViewed = useCallback(
    (path: string) => {
      const markViewed = !viewedFiles.viewed.has(path);
      viewedFiles.setMany([path], markViewed);
      if (!markViewed) return;
      if (!collapsedPaths.has(path)) {
        setSeed((prev) => ({ ...prev, owned: new Set(prev.owned).add(path) }));
      }
      clearReveal(path);
      setCollapsedPaths((prev) => (prev.has(path) ? prev : new Set(prev).add(path)));
    },
    [viewedFiles, clearReveal, collapsedPaths],
  );

  // Fixed id keeps repeated failures from stacking toasts.
  useEffect(() => {
    if (!viewedFiles.persisted) {
      toast.error("Viewed files can't be saved on this device.", { id: "pr-viewed-persistence" });
    }
  }, [viewedFiles.persisted]);

  const [sidebarCollapsed, setSidebarCollapsed] = useState(mobile);
  // Collapsed folders in the sidebar tree (empty = all expanded).
  const [collapsedDirs, setCollapsedDirs] = useState<ReadonlySet<string>>(() => new Set());
  const toggleDir = useCallback((path: string) => {
    setCollapsedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  // Drag-to-resize the file sidebar via a handle on its right edge.
  const {
    width: sidebarWidth,
    containerRef: bodyRef,
    handleProps: sidebarHandleProps,
  } = useResizableColumn(192, 140, 560);

  // A revealed file collapses on its first toggle, so the reader can always close it.
  const toggleOne = useCallback(
    (path: string) => {
      const collapse = !isCollapsed(path);
      clearReveal(path);
      releaseMarkCollapse([path]);
      setCollapsedPaths((prev) => {
        if (prev.has(path) === collapse) return prev;
        const next = new Set(prev);
        if (collapse) next.add(path);
        else next.delete(path);
        return next;
      });
    },
    [isCollapsed, clearReveal, releaseMarkCollapse],
  );

  const allCollapsed = visibleFiles.length > 0 && visibleFiles.every((f) => isCollapsed(f.path));
  const toggleAll = useCallback(() => {
    for (const file of visibleFiles) clearReveal(file.path);
    releaseMarkCollapse(visibleFiles.map((file) => file.path));
    setCollapsedPaths((prev) => {
      const next = new Set(prev);
      for (const file of visibleFiles) {
        if (allCollapsed) next.delete(file.path);
        else next.add(file.path);
      }
      return next;
    });
  }, [visibleFiles, allCollapsed, clearReveal, releaseMarkCollapse]);

  // Parse the one whole-PR patch into per-file diffs, keyed by path.
  const { filesByPath, parseError } = useMemo(() => {
    const map = new Map<string, FileDiffMetadata>();
    const patch = prDiff.data?.patch;
    if (patch) {
      try {
        for (const parsed of parsePatchFiles(patch)) {
          for (const f of parsed.files) map.set(f.name, f);
        }
      } catch {
        return {
          filesByPath: map,
          parseError: "Couldn’t read the PR diff. Refresh or open the PR on its provider.",
        };
      }
    }
    return { filesByPath: map, parseError: undefined };
  }, [prDiff.data]);

  // Expand-context loader: fetch a file's full old/new content on demand when
  // the reader expands unchanged regions.
  const loadDiffFiles = useCallback(
    async (fd: FileDiffMetadata) => {
      const { before, after } = prUrl
        ? await fetchPullRequestFileContents(conversationId, fd.name, baseRef, {
            pr_url: prUrl,
            previous_path: fd.prevName,
            head_sha: headSha,
            base_sha: baseSha,
          })
        : await fetchPullRequestFileContents(conversationId, fd.name, baseRef);
      return {
        oldFile: { name: fd.prevName ?? fd.name, contents: before ?? "" },
        newFile: { name: fd.name, contents: after ?? "" },
      };
    },
    [conversationId, baseRef, prUrl, headSha, baseSha],
  );

  const diffOptions = useMemo<DiffOptions>(
    () => ({
      theme: PULL_REQUEST_DIFF_THEME,
      themeType,
      diffStyle,
      unsafeCSS: `
        [data-selected-line] { background-color: var(--sidebar-active); }
        [data-column-number][data-selected-line], [data-gutter-buffer][data-selected-line] {
          color: var(--sidebar-active-foreground);
          box-shadow: inset -3px 0 var(--sidebar-active-foreground);
        }
      `,
      // The section renders its own header; the diff body has none.
      disableFileHeader: true,
      // Expand unchanged context 10 lines at a time (default is 100). The
      // unchanged lines aren't in the patch, so expansion (and the exact
      // trailing-region count) is served by loadDiffFiles on demand.
      expansionLineCount: 10,
      loadDiffFiles,
    }),
    [themeType, diffStyle, loadDiffFiles],
  );

  // The stacked diff scrolls as one; the sidebar highlights the file at the top
  // of the viewport and jumps to a file on click.
  const scrollRef = useRef<HTMLDivElement>(null);
  const sectionEls = useRef<Map<string, HTMLElement>>(new Map());
  const [activePath, setActivePath] = useState<string | null>(null);

  const registerRef = useCallback((path: string, el: HTMLElement | null) => {
    if (el) sectionEls.current.set(path, el);
    else sectionEls.current.delete(path);
  }, []);

  const rafRef = useRef<number | null>(null);
  const recomputeActive = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return;
    const top = container.getBoundingClientRect().top;
    let current: string | null = null;
    for (const [path, el] of sectionEls.current) {
      if (el.getBoundingClientRect().top - top <= 8) current = path;
    }
    setActivePath((prev) => current ?? prev);
  }, []);
  const onScroll = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      recomputeActive();
    });
  }, [recomputeActive]);

  useEffect(() => {
    setActivePath((prev) =>
      prev && visibleFiles.some((f) => f.path === prev) ? prev : (visibleFiles[0]?.path ?? null),
    );
  }, [visibleFiles]);

  // Jumping to a collapsed file also expands it, so the click lands on its diff.
  const jumpTo = useCallback(
    (path: string) => {
      setActivePath(path);
      reveal(path);
      sectionEls.current.get(path)?.scrollIntoView({ block: "start" });
    },
    [reveal],
  );

  const [focusedThread, setFocusedThread] = useState<{ id: string } | null>(null);
  useEffect(() => {
    const container = scrollRef.current;
    if (!container || !focusedThread || !selected) return;
    const focusThread = () => {
      const element = container.querySelector<HTMLElement>(
        `[data-review-thread="${CSS.escape(focusedThread.id)}"]`,
      );
      if (!element || !element.getClientRects().length) return;
      element.scrollIntoView({ block: "center" });
      element.focus({ preventScroll: true });
      observer.disconnect();
    };
    const observer = new MutationObserver(focusThread);
    observer.observe(container, { childList: true, subtree: true });
    focusThread();
    return () => observer.disconnect();
  }, [focusedThread, selected]);

  const threadContext: ReviewThreadContext = {
    conversationId,
    prUrl: data.selected_pr_url ?? pr.url,
    account: data.auth.selected_account,
    canReply: !!(canEdit && data.capabilities.review_thread_replies),
    canCreate: !!(
      canEdit &&
      data.capabilities.review_thread_creation &&
      pr.state === "OPEN" &&
      pr.head_sha &&
      pr.base_sha &&
      pr.head_sha === prDiff.data?.head_sha &&
      pr.base_sha === prDiff.data?.base_sha &&
      reviews.page
    ),
    headSha: pr.head_sha,
    baseSha: pr.base_sha,
    loadComments: reviews.loadComments,
    loadingComments: reviews.loadingComments,
  };
  const threads = reviews.page?.data ?? [];
  const matchingRevision =
    !!reviews.page &&
    reviews.page.head_sha === prDiff.data?.head_sha &&
    reviews.page.base_sha === prDiff.data?.base_sha;
  const canShowFiles =
    !changes.error &&
    !prDiff.error &&
    !parseError &&
    !prDiff.data?.unavailable_reason &&
    files.length > 0 &&
    !prDiff.isLoading;
  const threadsByFile = new Map<string, ReviewThread[]>();
  const earlierThreads: ReviewThread[] = [];
  for (const thread of threads) {
    const file =
      canShowFiles &&
      visibleFiles.find(
        (entry) =>
          entry.path === thread.path || filesByPath.get(entry.path)?.prevName === thread.path,
      );
    if (file) threadsByFile.set(file.path, [...(threadsByFile.get(file.path) ?? []), thread]);
    else earlierThreads.push(thread);
  }
  const unresolved = threads.filter((thread) => !thread.resolved);
  const navigateThread = (direction: number) => {
    const index = unresolved.findIndex((thread) => thread.id === focusedThread?.id);
    const start = index < 0 ? (direction > 0 ? -1 : 0) : index;
    const next = unresolved[(start + direction + unresolved.length) % unresolved.length];
    if (!next) return;
    const file = files.find(
      (entry) => entry.path === next.path || filesByPath.get(entry.path)?.prevName === next.path,
    );
    if (file) {
      // A thread on a filtered-out file has no mounted section, so show it first.
      if (!visibleFiles.includes(file)) {
        if (!filterChangedPaths([file], view.pathFilter).length) view.setPathFilter("");
        if (viewedFiles.viewed.has(file.path)) view.setHideViewed(false);
      }
      jumpTo(file.path);
    }
    setFocusedThread({ id: next.id });
  };

  // A controls row, then the sidebar (jump-to-file) + one scroll of all files' diffs.
  return (
    <TabsContent value="changes" className="flex min-h-0 flex-1 flex-col">
      {data.capabilities.review_threads &&
        (reviews.page?.has_more ||
          reviews.historyStale ||
          reviews.page?.warning ||
          reviews.error) && (
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-1 text-ui">
            {reviews.page?.has_more && (
              <Button
                variant="ghost"
                size="sm"
                disabled={reviews.loadingMore}
                onClick={reviews.loadMore}
              >
                {reviews.loadingMore ? "Loading…" : "Load more conversations"}
              </Button>
            )}
            {reviews.historyStale && (
              <span className="text-muted-foreground">
                Older pages may have changed.{" "}
                <button type="button" className="underline" onClick={reviews.refreshHistory}>
                  Reload conversations
                </button>
              </span>
            )}
            {(reviews.page?.warning || reviews.error) && (
              <span role="status" className="text-destructive">
                {reviews.error ?? reviews.page?.warning}
              </span>
            )}
          </div>
        )}
      {(changes.data?.has_more || changes.data?.warning) && (
        <p
          role="status"
          className="shrink-0 border-b border-border p-2 text-ui text-muted-foreground"
        >
          {changes.data.warning || "The changed-file list is incomplete."}
        </p>
      )}
      {viewedFiles.resetNotice && view.dismissedResetHead !== renderedHead && (
        <div
          role="status"
          className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-1 text-ui text-muted-foreground"
        >
          New commits since you last viewed — viewed marks were reset.
          <Button
            variant="ghost"
            size="sm"
            onClick={() => view.setDismissedResetHead(renderedHead)}
          >
            Dismiss
          </Button>
        </div>
      )}
      {(files.length > 0 || unresolved.length > 0 || reviews.isFetching) && (
        <ChangesToolbar
          showFileControls={files.length > 0}
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebar={() => setSidebarCollapsed((v) => !v)}
          canNavigateThreads={unresolved.length > 0}
          onNavigateThread={navigateThread}
          loadingThreads={reviews.isFetching}
          diffStyle={diffStyle}
          onToggleDiffStyle={toggleDiffStyle}
          allCollapsed={allCollapsed}
          onToggleAll={toggleAll}
          progress={
            files.length > 0 && viewedFiles.available ? (
              <PullRequestViewedProgress
                viewedCount={viewedCount}
                totalCount={files.length}
                partial={!!changes.data?.has_more}
                mobile={mobile}
                hideViewed={view.hideViewed}
                onHideViewedChange={view.setHideViewed}
              />
            ) : undefined
          }
        />
      )}
      <div ref={bodyRef as React.RefObject<HTMLDivElement>} className="flex min-h-0 flex-1">
        {!sidebarCollapsed && (
          <ChangesSidebar width={sidebarWidth} handleProps={sidebarHandleProps}>
            {changes.isLoading ? (
              <div className="flex items-center justify-center p-4 text-muted-foreground">
                <Loader2Icon className="size-4 animate-spin" />
              </div>
            ) : changes.error ? (
              <p className="px-2 py-1 text-ui text-muted-foreground">
                {changes.error instanceof RunnerOfflineError
                  ? "Runner offline."
                  : (changes.error as Error).message}
              </p>
            ) : files.length === 0 ? (
              <p className="px-2 py-1 text-ui text-muted-foreground">
                {changes.data?.available === false ||
                changes.data?.has_more ||
                changes.data?.warning
                  ? "Changed files are unavailable."
                  : "No changes vs base."}
              </p>
            ) : (
              fileTree.map((node) => (
                <SidebarNode
                  key={node.type === "file" ? node.file.path : node.path}
                  node={node}
                  depth={0}
                  activePath={activePath}
                  onSelectFile={jumpTo}
                  collapsedDirs={collapsedDirs}
                  onToggleDir={toggleDir}
                  viewedPaths={viewedFiles.viewed}
                />
              ))
            )}
          </ChangesSidebar>
        )}
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="github-diff-stack min-w-0 flex-1 overflow-y-auto"
        >
          {changes.error || prDiff.error || parseError ? (
            <PanelMessage>
              <p role="alert">{parseError || ((changes.error || prDiff.error) as Error).message}</p>
            </PanelMessage>
          ) : prDiff.data?.unavailable_reason ? (
            <PanelMessage>
              {prDiff.data.message ||
                (prDiff.data.unavailable_reason === "pr_outside_workspace"
                  ? "Diff unavailable for a PR outside this workspace's repository"
                  : "Diff unavailable. Refresh or open the request on its provider.")}
            </PanelMessage>
          ) : files.length === 0 || prDiff.isLoading ? (
            <PanelMessage>
              {changes.isLoading || prDiff.isLoading ? (
                <>
                  <Loader2Icon className="size-5 animate-spin" />
                  Loading changes…
                </>
              ) : changes.data?.available === false ||
                changes.data?.has_more ||
                changes.data?.warning ? (
                "Changed files are unavailable."
              ) : (
                "No changes vs base."
              )}
            </PanelMessage>
          ) : allViewed ? (
            <PanelMessage>
              <span>{`All ${matchingCount} files viewed`}</span>
              <Button variant="outline" size="sm" onClick={() => view.setHideViewed(false)}>
                Show viewed
              </Button>
            </PanelMessage>
          ) : (
            visibleFiles.map((file) => (
              <PullRequestFileSection
                key={file.path}
                file={file}
                fileDiff={filesByPath.get(file.path)}
                options={diffOptions}
                registerRef={registerRef}
                collapsed={collapsedPaths.has(file.path)}
                forceExpanded={revealedPaths.has(file.path)}
                onToggleCollapsed={() => toggleOne(file.path)}
                headerActions={
                  viewedFiles.available ? (
                    <div className="flex items-center gap-1">
                      <PullRequestViewedToggle
                        path={file.path}
                        viewed={viewedFiles.viewed.has(file.path)}
                        onToggle={() => toggleViewed(file.path)}
                      />
                    </div>
                  ) : undefined
                }
                threads={threadsByFile.get(file.path) ?? []}
                threadContext={threadContext}
                matchingRevision={matchingRevision}
              />
            ))
          )}
          {earlierThreads.length > 0 && (
            <div className="p-3">
              <p className="text-ui font-medium">Earlier conversations and unavailable diffs</p>
              {earlierThreads.map((thread) => (
                <div key={thread.id}>
                  <p className="mt-3 break-all text-xs text-muted-foreground">{thread.path}</p>
                  <PullRequestReviewThread thread={thread} context={threadContext} showContext />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </TabsContent>
  );
}
