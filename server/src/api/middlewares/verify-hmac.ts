import crypto from 'crypto';
import { NextFunction, Request, Response } from 'express';
import { env } from '../../config/env';
import { UnauthorizedWebhookError } from '../../domain/errors';

export interface RequestWithRawBody extends Request {
    rawBody?: Buffer;
}

export function verifyWebhookSignature(
    req: RequestWithRawBody,
    _res: Response,
    next: NextFunction
): void {
    const signature = req.headers['x-signature'];
    if (!signature || typeof signature !== 'string' || !req.rawBody) {
        throw new UnauthorizedWebhookError('Missing webhook signature');
    }

    const expected = crypto
        .createHmac('sha256', env.WEBHOOK_SECRET)
        .update(req.rawBody)
        .digest('hex');

    const sigBuf = Buffer.from(signature, 'utf8');
    const expBuf = Buffer.from(expected, 'utf8');

    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
        throw new UnauthorizedWebhookError('Invalid webhook signature');
    }

    next();
}
