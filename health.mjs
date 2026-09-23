import os from 'node:os';
import * as db from './db.mjs';

/** Run inside a targeted lane. A Maps lane also verifies its actual pg-proxy credentials. */
export async function health(payload = {}, database = db) {
  const result = {
    hostname: os.hostname(),
    pid: process.pid,
    node: process.version,
    uptimeSec: Math.round(process.uptime()),
    at: new Date().toISOString(),
    database: payload?.database ? 'checking' : 'not_required',
  };
  if (!payload?.database) return result;
  if (!database.configured()) throw new Error('Maps worker database is not configured (PG_PROXY_URL, PG_DB_NAME, PG_PROXY_TOKEN)');
  const probe = await database.sql(`select
    has_table_privilege(current_user, 'company_data', 'INSERT') as company_insert,
    has_table_privilege(current_user, 'company_data', 'UPDATE') as company_update,
    has_table_privilege(current_user, 'search_report', 'INSERT') as report_insert,
    has_table_privilege(current_user, 'search_report_company', 'INSERT') as link_insert`);
  const grants = probe.rows?.[0];
  if (!grants || Object.values(grants).some((granted) => granted !== true)) {
    throw new Error('Maps worker database is reachable, but a required scan table write privilege is missing');
  }
  result.database = 'ok';
  return result;
}
