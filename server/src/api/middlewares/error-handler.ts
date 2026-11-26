import { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { DomainError } from '../../domain/errors';

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
    if (err instanceof ZodError) {
        res.status(400).json({
            error: 'VALIDATION_ERROR',
            details: err.flatten(),
        });
        return;
    }

    if (err instanceof DomainError) {
        res.status(err.statusCode).json({
            error: err.code,
            message: err.message,
        });
        return;
    }

    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
}
