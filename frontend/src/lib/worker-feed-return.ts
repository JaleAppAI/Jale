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

/**
 * How long that stays true.
 *
 * The marker is written as a job is opened and spent when that job page
 * mounts, so in the ordinary case it lives for one navigation. It can outlive
 * that: a ctrl-click opens the job in a NEW tab and leaves this one on the
 * feed, and `sessionStorage` is COPIED into the new tab, so the marker can be
 * left behind on both sides. (`opensInThisTab` below stops it being written at
 * all for that click; the clock is the backstop for every route to the same
 * state that nobody has thought of.)
 *
 * Two minutes: far longer than any page load, far shorter than the gap before
 * a worker opens some other job from somewhere else -- and the cost of it
 * expiring early is only that the back link is followed instead of the history
 * being walked, which lands on the same feed without the scroll position.
 */
const FEED_ORIGIN_TTL_MS = 2 * 60 * 1000;

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

/**
 * Called as a job is opened FROM the feed, and only then.
 *
 * The value is the moment it happened: see `FEED_ORIGIN_TTL_MS`.
 */
export function markFeedOrigin(): void {
  write(FEED_ORIGIN_KEY, String(Date.now()));
}

/**
 * Whether a click will navigate THIS tab.
 *
 * A middle-click, or a ctrl/cmd/shift-click, opens the destination somewhere
 * else and leaves this page exactly where it is -- so it is not a departure
 * from the feed, and it must not be recorded as one. The same question decides
 * whether the back link may take over a click, which is why both callers ask
 * it here rather than each spelling the modifiers out.
 */
export function opensInThisTab(event: {
  button: number;
  defaultPrevented: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): boolean {
  if (event.defaultPrevented || event.button !== 0) return false;
  return !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey);
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
  const markedAt = Number(read(FEED_ORIGIN_KEY));
  return {
    href: read(FEED_URL_KEY) ?? WORKER_FEED_HREF,
    // A marker with no readable time, or one older than the window, is not
    // evidence about THIS page's arrival -- `Number(null)` is 0 and
    // `Number('x')` is NaN, and neither passes.
    canGoBack: markedAt > 0 && Date.now() - markedAt < FEED_ORIGIN_TTL_MS,
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
