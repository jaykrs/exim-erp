import type { ReactNode } from 'react';
import './globals.css';

export const metadata = { title: 'EXIM ERP', description: 'Indian export-import (sea + air) ERP' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
