import { createApp } from './api/app';
import { env } from './config/env';
import { pool } from './infrastructure/db/pool';
import { logger } from './infrastructure/logger/logger';

const { app, outboxWorker } = createApp(pool);
outboxWorker.start();

const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, 'Server started');
});

let isShuttingDown = false;

async function shutdown(signal: string): Promise<void> {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info({ signal }, 'Starting graceful shutdown...');

    const forceExitTimer = setTimeout(() => {
        logger.error('Could not close connections in time, forcefully shutting down');
        process.exit(1);
    }, 10_000);
    forceExitTimer.unref();

    server.close(async (err?: Error) => {
        if (err) {
            logger.error({ err }, 'Error closing HTTP server');
            process.exit(1);
        }
        try {
            await outboxWorker.stop();
            await pool.end();
            logger.info('PostgreSQL pool closed. Bye!');
            process.exit(0);
        } catch (dbErr) {
            logger.error({ err: dbErr }, 'Error closing DB pool');
            process.exit(1);
        }
    });
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
