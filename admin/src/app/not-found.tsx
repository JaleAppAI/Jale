import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="hero stack-gap">
      <span className="badge dismissed">404</span>
      <h1>That admin page does not exist.</h1>
      <p className="muted">Check the queue, go back to the dashboard, or open a valid case/verification ID.</p>
      <Link className="button" href="/">Back to dashboard</Link>
    </main>
  );
}
