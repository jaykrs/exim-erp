import type { ReactNode } from 'react';

export const metadata = { title: 'EXIM ERP', description: 'Indian export-import (sea + air) ERP' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: 0, padding: 24 }}>{children}</body>
    </html>
  );
}
