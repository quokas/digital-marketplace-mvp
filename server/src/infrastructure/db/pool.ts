import { Pool } from 'pg';
import { env } from '../../config/env';

export const pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000, // Защита от долгих зависших запросов
});

pool.on('error', (err) => {
    console.error('Unexpected PostgreSQL idle client error:', err);
});
