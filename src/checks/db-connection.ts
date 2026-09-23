import type { Check } from '../core/types.js';
import { cap, errMsg, pass, prereq, result, skip } from './util.js';

/** Proves selected database credentials work; deliberately makes no schema or Auth claim. */
export const dbConnectionCheck: Check = {
  id: 'db-connection',
  title: 'Selected database accepts a read-only connection',
  severity: 'high',
  applies: (ctx) => Boolean(cap(ctx, 'db', 'dbConnection')),
  async run(ctx) {
    const connection = cap(ctx, 'db', 'dbConnection');
    if (!connection) return skip('the database provider has no read-only connection probe');
    const pre = await prereq(ctx, 'db');
    if (pre) return pre;
    try {
      const got = await connection.probe(ctx);
      return pass([
        `read-only query succeeded for database ${got.database}, role ${got.role}`,
        'This verifies the selected connection only. App migrations, deployed app access, Auth and user-data isolation need separate app-level tests.',
      ]);
    } catch (e) {
      return result('fail', 'high', [`read-only database probe failed: ${errMsg(e)}`],
        'Confirm the selected project, branch, database and role, then re-run verify. Do not paste connection strings into chat.');
    }
  },
};
