// The tables AppMaker owns. They are defined here, in code, never in the designed schema: the
// designer shows them with a system badge, refuses to change their structure, and the database
// module creates them - users and sessions when authentication is turned on, api_keys and
// secret_values at every boot. Same shape as a schema.json entry, so reconcile() treats them like
// any other table.
export const ADMIN_ROLE = 'Administrator';

export const SYSTEM_TABLES = [
  {
    name: 'users',
    columns: [
      { name: 'id', type: 'INTEGER', pk: true },
      { name: 'email', type: 'TEXT', notnull: true },
      { name: 'name', type: 'TEXT' },
      { name: 'passwordHash', type: 'TEXT' },
      { name: 'role', type: 'TEXT', notnull: true, dflt: "'User'" },
      { name: 'active', type: 'BOOLEAN', notnull: true, dflt: '1' },
      { name: 'createdAt', type: 'DATETIME', dflt: 'CURRENT_TIMESTAMP' },
      { name: 'lastLoginAt', type: 'DATETIME' },
      { name: 'resetTokenHash', type: 'TEXT' },
      { name: 'resetTokenExpires', type: 'DATETIME' },
      { name: 'inviteTokenHash', type: 'TEXT' },
      { name: 'inviteTokenExpires', type: 'DATETIME' }
    ],
    indexes: [{ name: 'ux_users_email', columns: ['email'], unique: true }]
  },
  {
    name: 'sessions',
    columns: [
      { name: 'id', type: 'INTEGER', pk: true },
      { name: 'tokenHash', type: 'TEXT', notnull: true },
      { name: 'userId', type: 'INTEGER', notnull: true, references: { table: 'users', column: 'id', onDelete: 'cascade' } },
      { name: 'createdAt', type: 'DATETIME', dflt: 'CURRENT_TIMESTAMP' },
      { name: 'expiresAt', type: 'DATETIME', notnull: true },
      { name: 'lastSeenAt', type: 'DATETIME' }
    ],
    indexes: [{ name: 'ux_sessions_token', columns: ['tokenHash'], unique: true }, { name: 'ix_sessions_user', columns: ['userId'] }]
  },
  // API keys are deployment data: issued on the machine that serves the APIs, never part of the
  // project. createdBy is the issuing user's id, or null for a key the designer issued; it is
  // not a foreign key, since the table exists with sign-in off too.
  {
    name: 'api_keys',
    columns: [
      { name: 'id', type: 'INTEGER', pk: true },
      { name: 'name', type: 'TEXT', notnull: true },
      { name: 'prefix', type: 'TEXT', notnull: true },
      { name: 'keyHash', type: 'TEXT', notnull: true },
      { name: 'role', type: 'TEXT', notnull: true },
      { name: 'createdAt', type: 'DATETIME', dflt: 'CURRENT_TIMESTAMP' },
      { name: 'createdBy', type: 'INTEGER' },
      { name: 'lastUsedAt', type: 'DATETIME' }
    ],
    indexes: [{ name: 'ux_api_keys_hash', columns: ['keyHash'], unique: true }]
  },
  // The values of the project's secrets, sealed with the project's own key (secrets.js). The
  // secrets themselves - name and description - are defined in the schema file, with the design;
  // a value is deployment data, set where the app runs, and joins its secret by name.
  {
    name: 'secret_values',
    columns: [
      { name: 'id', type: 'INTEGER', pk: true },
      { name: 'name', type: 'TEXT', notnull: true },
      { name: 'sealedValue', type: 'TEXT' },
      { name: 'valueSetAt', type: 'DATETIME' }
    ],
    indexes: [{ name: 'ux_secret_values_name', columns: ['name'], unique: true }]
  }
];

// The tables sign-in needs, by name: what reconcileSystem creates when it is turned on.
export const AUTH_TABLE_NAMES = ['users', 'sessions'];

export const SYSTEM_TABLE_NAMES = new Set(SYSTEM_TABLES.map((t) => t.name));

// Columns whose values never leave the server in the clear, however they are read.
export const MASKED_COLUMNS = {
  users: new Set(['passwordHash', 'resetTokenHash', 'inviteTokenHash']),
  sessions: new Set(['tokenHash']),
  api_keys: new Set(['keyHash']),
  secret_values: new Set(['sealedValue'])
};

export const MASK = '••••••';

export function isSystemTable(name) {
  return SYSTEM_TABLE_NAMES.has(String(name));
}
