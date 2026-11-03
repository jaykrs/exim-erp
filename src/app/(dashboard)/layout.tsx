import type { ReactNode } from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import SignOut from '@/components/SignOut';
import { currentUser } from '@/lib/current-user';

export const dynamic = 'force-dynamic';

const LINKS: Array<[string, string]> = [
  ['/', 'Overview'], ['/shipments', 'Shipments'], ['/sourcing', 'Sourcing'], ['/warehouse', 'Warehouse'],
  ['/compliance', 'Compliance'], ['/customs', 'Customs'], ['/finance', 'Finance'],
];

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const user = await currentUser();
  if (!user) redirect('/login');
  return (
    <div className="shell">
      <nav className="nav">
        <h1>EXIM ERP</h1>
        {LINKS.map(([href, label]) => <Link key={href} href={href}>{label}</Link>)}
        <div className="who">
          {user.name}<br />{user.role.replaceAll('_', ' ')}<br />
          <SignOut />
        </div>
      </nav>
      <main className="main">{children}</main>
    </div>
  );
}
