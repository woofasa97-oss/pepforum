'use client';

import '@/styles/globals.css';

/**
 * Last-resort boundary for errors in the root layout itself (e.g. the
 * database is unreachable while rendering the header). Must render its own
 * <html>/<body>. Generic text only; the digest correlates with server logs.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en-CA">
      <body>
        <main id="main" className="page narrow" style={{ width: '100%' }}>
          <div className="card empty" role="alert">
            <b>Pepforum is temporarily unavailable · Pepforum est temporairement indisponible</b>
            {error.digest ? <p className="xs faint">Ref: {error.digest}</p> : null}
            <button type="button" className="btn dark mt16" onClick={reset}>Try again · Réessayer</button>
          </div>
        </main>
      </body>
    </html>
  );
}
