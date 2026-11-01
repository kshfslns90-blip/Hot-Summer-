// The sql`...` tag of server scripts: a template literal becomes a statement for dbQuery and
// dbRun, each ${value} a ? in the text and its value bound as a parameter - never pasted into
// the SQL. Kept apart from db.js, which the runner loads lazily, because a tag answers at once.
import { StoreError } from './store.js';

export class SqlStatement {
  constructor(text, values) {
    this.text = text;
    this.values = Object.freeze(values);
    Object.freeze(this);
  }
}

// sql`SELECT * FROM guests WHERE id = ${id}` -> { text: 'SELECT * FROM guests WHERE id = ?', values: [id] }.
// The strings come from the script's own realm, so Array.isArray rather than instanceof.
export function sql(strings, ...values) {
  if (!Array.isArray(strings) || !Array.isArray(strings.raw)) {
    throw new StoreError('sql is a tag, written in front of a template literal: sql`SELECT * FROM guests WHERE id = ${id}`.');
  }
  return new SqlStatement(strings.join('?'), values);
}
