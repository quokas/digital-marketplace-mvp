export abstract class DomainError extends Error {
    abstract readonly statusCode: number;
    abstract readonly code: string;

    constructor(message: string) {
        super(message);
        this.name = this.constructor.name;
        Error.captureStackTrace(this, this.constructor);
    }
}

export class OrderNotFoundError extends DomainError {
    readonly statusCode = 404;
    readonly code = 'ORDER_NOT_FOUND';
    constructor(orderId: string) {
        super(`Order ${orderId} not found`);
    }
}

export class OrderAlreadyProcessedError extends DomainError {
    readonly statusCode = 409;
    readonly code = 'ORDER_ALREADY_PROCESSED';
    constructor(orderId: string, currentStatus: string) {
        super(`Order ${orderId} is already in status: ${currentStatus}`);
    }
}

export class IdempotencyConflictError extends DomainError {
    readonly statusCode = 409;
    readonly code = 'IDEMPOTENCY_CONFLICT';
    constructor() {
        super('Idempotency key already used with different request payload');
    }
}

export class InvalidOrderStateError extends DomainError {
    readonly statusCode = 400;
    readonly code = 'INVALID_ORDER_STATE';
}

export class PromoUnavailableError extends DomainError {
    readonly statusCode = 400;
    readonly code = 'PROMO_UNAVAILABLE';
    constructor(code: string) {
        super(`Promocode "${code}" not found or usage limit exceeded`);
    }
}

export class UnauthorizedWebhookError extends DomainError {
    readonly statusCode = 401;
    readonly code = 'INVALID_WEBHOOK_SIGNATURE';
}
