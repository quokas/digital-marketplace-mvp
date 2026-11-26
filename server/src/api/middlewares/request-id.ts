import crypto from 'crypto';
import { NextFunction, Request, Response } from 'express';
import { requestContext } from '../../infrastructure/logger/context';

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
    const incomingId = req.headers['x-request-id'];
    const requestId =
        typeof incomingId === 'string' && incomingId.length > 0 ? incomingId : crypto.randomUUID();

    res.setHeader('x-request-id', requestId);
    requestContext.run({ requestId }, () => next());
}
    