import pino from 'pino';
import { env } from '../../config/env';
import { requestContext } from './context';

export const logger = pino({
    level: env.NODE_ENV === 'production' ? 'info' : 'debug',
    transport:
        env.NODE_ENV !== 'production'
            ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } }
            : undefined,
    mixin() {
        const ctx = requestContext.getStore();
        return ctx ? { requestId: ctx.requestId } : {};
    },
});
