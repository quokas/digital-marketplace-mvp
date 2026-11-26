import { OutboxSummary } from '../repositories/outbox.repository';

export type OrderStatus = 'created' | 'paid' | 'delivered' | 'out_of_stock';

export interface Order {
    id: string;
    sku: string;
    status: OrderStatus;
    createdAt: Date;
    key?: string | null;
}

export interface DeliveryResult {
    status: Extract<OrderStatus, 'delivered' | 'out_of_stock'>;
    key: string | null;
}

export interface Promocode {
    code: string;
    used_count: number;
    max_uses: number;
}

export interface StoreState {
    stock: Record<string, number>;
    promocodes: Promocode[];
    orders: Order[];
    outbox: OutboxSummary[];
}
