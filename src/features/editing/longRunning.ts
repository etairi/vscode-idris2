/**
 * `longRunning`: a request that can take long (M4's searches and long edits, List Holes), run under
 * the window's progress with Cancel offered in a notification once it has run `cancelOfferMs`
 * (`CANCEL_OFFER_MS`, as Evaluate Selection does: most requests take far less, and a notification for
 * each would come and go). At Cancel the token is cancelled and `longRunning` returns at once,
 * `cancelled`, without waiting for `run`: a load that `run` makes before its request is not stopped
 * by the token (UX review of M4), and until it ended the notification, the window's progress and the
 * caller's "still running" state stayed. `run`'s late result is dropped. `checksFirst`: `run` may check
 * the file before its request, and the notification says that such a check finishes.
 *
 * Only type imports from `vscode`.
 */
import type * as vscode from 'vscode';
import { plainText } from '../../core/notificationText';

/** The part of the `vscode` namespace `longRunning` uses. */
export type LongRunningApi = Pick<typeof vscode, 'window' | 'ProgressLocation' | 'CancellationTokenSource'>;

/** What `longRunning` returns: `run`'s value, or that the user cancelled it. */
export type LongRunningOutcome<T> = { readonly cancelled: false; readonly value: T } | { readonly cancelled: true };

/** `run` under the window's progress titled `name` (module comment); Cancel offered after `cancelOfferMs`. */
export async function longRunning<T>(
  api: LongRunningApi,
  name: string,
  run: (token: vscode.CancellationToken) => Promise<T>,
  cancelOfferMs: number,
  checksFirst = false,
): Promise<LongRunningOutcome<T>> {
  const source = new api.CancellationTokenSource();
  const running = run(source.token);
  let cancel = (): void => undefined;
  const cancelled = new Promise<{ readonly cancelled: true }>((resolve) => (cancel = () => resolve({ cancelled: true })));
  let finished = false;
  const offer = setTimeout(() => {
    if (finished) {
      return;
    }
    void api.window.withProgress(
      {
        location: api.ProgressLocation.Notification,
        title: plainText(`Idris 2: ${name} is still running. Cancel stops it${checksFirst ? '; a check of the file already running finishes first' : ''}.`),
        cancellable: true,
      },
      (_progress, token) =>
        new Promise<void>((resolve) => {
          token.onCancellationRequested(() => {
            source.cancel();
            cancel();
            resolve();
          });
          void running.then(
            () => resolve(),
            () => resolve(),
          );
        }),
    );
  }, cancelOfferMs);
  try {
    const answered = running.then((value) => ({ cancelled: false, value }) as const);
    return await Promise.resolve(
      api.window.withProgress({ location: api.ProgressLocation.Window, title: plainText(`Idris 2: ${name}…`) }, () => Promise.race([answered, cancelled])),
    );
  } finally {
    finished = true;
    clearTimeout(offer);
    source.dispose();
  }
}
