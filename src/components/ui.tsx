import type { ReactNode } from 'react';

export const fmtDate = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : '—');
export const fmtDateTime = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 16).replace('T', ' ') : '—');
export const money = (v: { toString(): string } | null | undefined) => (v == null ? '—' : Number(v.toString()).toLocaleString('en-IN', { maximumFractionDigits: 2 }));

const GOOD = /^(DONE|APPROVED|VERIFIED|FINAL|DELIVERED|CLOSED|PASSED|AVAILABLE|RELEASED|ACTIVE|PAID|SETTLED|GRANTED|RECEIVED|COMPLIANT)/;
const BAD = /(FAILED|REJECTED|HOLD|BLOCKED|EXPIRED|EXCEPTION|ON_HOLD)/;
export function Pill({ value }: { value: string | null | undefined }) {
  if (!value) return <span>—</span>;
  const cls = BAD.test(value) && !/RELEASED/.test(value) ? 'bad' : GOOD.test(value) ? 'ok' : 'warn';
  return <span className={`pill ${cls}`}>{value.replaceAll('_', ' ')}</span>;
}

export function Cards({ items }: { items: Array<[string, ReactNode]> }) {
  return (
    <div className="cards">
      {items.map(([label, value]) => (
        <div className="card" key={label}><b>{value}</b><span>{label}</span></div>
      ))}
    </div>
  );
}

export function Table({ head, rows, empty = 'Nothing here yet.' }: { head: string[]; rows: ReactNode[][]; empty?: string }) {
  if (rows.length === 0) return <div className="tablewrap"><div className="empty">{empty}</div></div>;
  return (
    <div className="tablewrap">
      <table>
        <thead><tr>{head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

export function Page({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return (<><h2>{title}</h2>{sub ? <p className="sub">{sub}</p> : null}{children}</>);
}
