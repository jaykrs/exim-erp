'use client';
import { useState, type FormEvent } from 'react';

export default function LoginPage() {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const f = new FormData(e.currentTarget);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: f.get('email'), password: f.get('password') }),
      });
      if (res.ok) {
        window.location.href = '/';
        return;
      }
      setError('Invalid email or password.');
    } catch {
      setError('Could not reach the server.');
    }
    setBusy(false);
  }

  return (
    <main className="login">
      <h2>EXIM ERP</h2>
      <p className="sub">Sign in to continue</p>
      <form onSubmit={submit}>
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" autoComplete="username" required />
        <label htmlFor="password">Password</label>
        <input id="password" name="password" type="password" autoComplete="current-password" required />
        <button type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        <div className="err" role="alert">{error}</div>
      </form>
    </main>
  );
}
