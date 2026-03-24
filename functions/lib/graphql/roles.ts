/**
 * Map between DB snake_case role strings and GraphQL UPPER_SNAKE enum values.
 */

const DB_TO_GQL: Record<string, string> = {
  super_admin: 'SUPER_ADMIN',
  org_admin: 'ORG_ADMIN',
  user: 'USER',
  reader: 'READER',
};

const GQL_TO_DB: Record<string, string> = {
  SUPER_ADMIN: 'super_admin',
  ORG_ADMIN: 'org_admin',
  USER: 'user',
  READER: 'reader',
};

export function roleToGql(dbRole: string): string {
  return DB_TO_GQL[dbRole] || dbRole;
}

export function roleToDB(gqlRole: string): string {
  return GQL_TO_DB[gqlRole] || gqlRole;
}

export function statusToGql(dbStatus: string): string {
  return dbStatus.toUpperCase();
}

export function statusToDB(gqlStatus: string): string {
  return gqlStatus.toLowerCase();
}
