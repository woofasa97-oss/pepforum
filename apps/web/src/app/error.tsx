'use client';

/**
 * Error boundary for route segments. Shows a generic message only: the error
 * object may contain server details, and the digest is enough to correlate
 * with server logs.
 */
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="page">
      <main id="main" className="narrow">
        <div className="card empty" role="alert">
          <b>Something went wrong · Une erreur s’est produite</b>
          {error.digest ? <p className="xs faint">Ref: {error.digest}</p> : null}
          <button type="button" className="btn dark mt16" onClick={reset}>Try again · Réessayer</button>
        </div>
      </main>
    </div>
  );
}
