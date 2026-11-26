import { Promocode } from '../domain/entities';
import { QueryExecutor } from '../infrastructure/db/transaction';

export class PromoRepository {
    constructor(private readonly db: QueryExecutor) { }

    async incrementUsageAtomic(code: string): Promise<Promocode | null> {
        const res = await this.db.query<Promocode>(
            `UPDATE promocodes
       SET used_count = used_count + 1
       WHERE code = $1 AND used_count < max_uses
       RETURNING code, used_count, max_uses`,
            [code]
        );
        return res.rows[0] ?? null;
    }

    async resetUsage(code: string): Promise<void> {
        await this.db.query(`UPDATE promocodes SET used_count = 0 WHERE code = $1`, [code]);
    }

    async findAll(): Promise<Promocode[]> {
        const res = await this.db.query<Promocode>(
            `SELECT code, used_count, max_uses FROM promocodes ORDER BY code ASC`
        );
        return res.rows;
    }
}
