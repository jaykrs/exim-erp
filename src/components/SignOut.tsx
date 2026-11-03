'use client';
export default function SignOut() {
  return (
    <button
      type="button"
      style={{ all: 'unset', color: 'var(--accent)', cursor: 'pointer' }}
      onClick={async () => { await fetch('/api/auth/logout', { method: 'POST' }); window.location.href = '/login'; }}
    >
      Sign out
    </button>
  );
}
