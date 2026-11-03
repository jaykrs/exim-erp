/** Role → permission matrix. One place to change who may do what. ADMIN may do everything. */
export const ROLES = [
  'ADMIN',
  'SOURCING_MANAGER',
  'WAREHOUSE_MANAGER',
  'LOGISTICS_MANAGER',
  'COMPLIANCE_OFFICER',
  'FINANCE_CONTROLLER',
  'VIEWER',
] as const;
export type Role = (typeof ROLES)[number];

export type Permission =
  | 'read'
  | 'sourcing:write' //       vendor verification, Incoterm/PI
  | 'trade-finance:write' //  forward contracts, LC, bank guarantees
  | 'warehouse:write' //      inward, grading, trace tags
  | 'compliance:write' //     ISPM 15, lab tests, labels, PGA clearances
  | 'logistics:write' //      port arrival, loading, departure, manifest, last mile
  | 'customs:write' //        shipping bill, LEO, bill of entry, OOC
  | 'finance:write'; //       incentives, landed-cost finalisation, reconciliation

export const PERMISSIONS: Record<Permission, readonly Role[]> = {
  read: ROLES,
  'sourcing:write': ['ADMIN', 'SOURCING_MANAGER'],
  'trade-finance:write': ['ADMIN', 'SOURCING_MANAGER', 'FINANCE_CONTROLLER'],
  'warehouse:write': ['ADMIN', 'WAREHOUSE_MANAGER'],
  'compliance:write': ['ADMIN', 'COMPLIANCE_OFFICER'],
  'logistics:write': ['ADMIN', 'LOGISTICS_MANAGER'],
  'customs:write': ['ADMIN', 'LOGISTICS_MANAGER', 'COMPLIANCE_OFFICER'],
  'finance:write': ['ADMIN', 'FINANCE_CONTROLLER'],
};

export function isRole(v: string): v is Role {
  return (ROLES as readonly string[]).includes(v);
}

export function can(role: string, permission: Permission): boolean {
  return isRole(role) && PERMISSIONS[permission].includes(role);
}
