// How a worker gets back to the job feed they were reading.
//
// The feed's filters live in its URL (`/worker/home?q=...&type=...`), so
// "return to the feed" means returning to a URL, not to a path. Two facts are
// remembered for the job page, and they are deliberately separate:
//
//   - THE FEED URL, rewritten whenever the filters change. It outlives a
//     reload, which is what makes the back link work on a job page opened from
//     a shared link, or reloaded, or restored by the browser.
//   - HOW THE JOB PAGE WAS REACHED. Set only when a job is opened FROM the
//     feed, and consumed by the job page on mount, because it is true of
//     exactly one navigation. Only that case may use `history.back()`, which
//     is worth preferring where it applies: it restores the scroll position
//     too, so a worker who was ten rows down does not land back at the top.
//
// Consuming rather than clearing on unmount is what keeps a reload honest: the
// reloaded page finds no marker, falls back to the link, and lands on the feed
// with its filters rather than wherever the browser's history happens to point.
//
// Every access is wrapped: reading or writing web storage THROWS (not returns
// null) in a locked-down browser -- see `lib/session-storage.ts`'s note B.

/** Where the feed was, filters and all. Survives a reload. */
const FEED_URL_KEY = 'jale.worker.feed-url';
/** "This job page was opened from the feed." True of one navigation only. */
const FEED_ORIGIN_KEY = 'jale.worker.feed-origin';

/** The feed with no filters -- what an unremembered return falls back to. */
export const WORKER_FEED_HREF = '/worker/home';

function store(): Storage | undefined {
  try {
    if (typeof window === 'undefined') return undefined;
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

/**
 * `sessionStorage`, not `localStorage`: "where I was reading" is a property of
 * ONE tab. Sharing it across tabs would send a worker back to a feed they are
 * looking at in another window.
 */
function read(key: string): string | null {
  try {
    return store()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    store()?.setItem(key, value);
  } catch {
    // A browser that refuses storage still gets a working back LINK -- it just
    // goes to the unfiltered feed. Nothing here is worth an exception.
  }
}

function remove(key: string): void {
  try {
    store()?.removeItem(key);
  } catch {
    // Same: the caller is clearing state it cannot be sure was ever written.
  }
}

/** The feed's current URL, locale-less (the `Link` adds the locale back). */
export function rememberFeedUrl(href: string): void {
  write(FEED_URL_KEY, href);
}

/** Called as a job is opened FROM the feed, and only then. */
export function markFeedOrigin(): void {
  write(FEED_ORIGIN_KEY, '1');
}

export type FeedReturn = {
  /** Where the back link points. Always a usable feed URL. */
  href: string;
  /**
   * The previous history entry is the feed, so `router.back()` returns to it
   * WITH its scroll position. False for a job page reached any other way
   * (a shared link, a reload, the applications list), where going back would
   * land somewhere else entirely.
   */
  canGoBack: boolean;
};

/**
 * What the job page needs. A pure READ, so it is safe as a `useState`
 * initializer (React may invoke one twice) -- the marker is spent separately,
 * by `consumeFeedOrigin` in a mount effect.
 */
export function readFeedReturn(): FeedReturn {
  return {
    href: read(FEED_URL_KEY) ?? WORKER_FEED_HREF,
    canGoBack: read(FEED_ORIGIN_KEY) !== null,
  };
}

/**
 * Spends the "came from the feed" marker, so it describes ONE navigation.
 *
 * Without this, a worker who later reached a job page from the applications
 * list would get a "back to jobs" link that went back to the applications list
 * -- the marker would still be lying around from the last time they opened a
 * job from the feed. Idempotent: calling it twice removes nothing twice.
 */
export function consumeFeedOrigin(): void {
  remove(FEED_ORIGIN_KEY);
}
