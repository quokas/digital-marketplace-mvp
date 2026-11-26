import { QueryExecutor } from '../infrastructure/db/transaction';

export class KeyRepository {
    constructor(private readonly db: QueryExecutor) { }

    async claimAvailableKey(tx: QueryExecutor, sku: string, orderId: string): Promise<string | null> {
        const keyRes = await tx.query<{ id: string; secret_key: string }>(
            `SELECT id, secret_key FROM digital_keys
       WHERE sku = $1 AND order_id IS NULL
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
            [sku]
        );

        const pickedKey = keyRes.rows[0];
        if (!pickedKey) {
            return null;
        }

        await tx.query(
            `UPDATE digital_keys SET order_id = $1, assigned_at = NOW() WHERE id = $2`,
            [orderId, pickedKey.id]
        );

        return pickedKey.secret_key;
    }

    async bulkInsert(sku: string, keys: string[]): Promise<number> {
        const res = await this.db.query(
            `INSERT INTO digital_keys (sku, secret_key)
       SELECT $1, unnest($2::text[])
       ON CONFLICT (secret_key) DO NOTHING`,
            [sku, keys]
        );
        return res.rowCount ?? 0;
    }

    async getAvailableStock(): Promise<Record<string, number>> {
        const res = await this.db.query<{ sku: string; available: number }>(
            `SELECT sku, COUNT(*)::int AS available
       FROM digital_keys
       WHERE order_id IS NULL
       GROUP BY sku`
        );
        return Object.fromEntries(res.rows.map((r) => [r.sku, r.available]));
    }
}
