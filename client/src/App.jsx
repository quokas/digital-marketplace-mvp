import { useState, useEffect } from 'react';

const PRODUCTS = [
  { sku: 'STEAM-TOPUP-500', title: 'Steam Пополнение 500 ₽', desc: 'Мгновенный код активации РФ/СНГ', price: 500 },
  { sku: 'KEY-CS2-PRIME', title: 'CS2 Prime Status Upgrade', desc: 'Официальный ключ активации Steam', price: 1490 },
];

export default function App() {
  const [tab, setTab] = useState('store');
  const [selectedSku, setSelectedSku] = useState(PRODUCTS.at(0).sku);
  const [promoCode, setPromoCode] = useState('PROMO3');
  const [discountApplied, setDiscountApplied] = useState(false);
  const [activeOrder, setActiveOrder] = useState(null);
  const [storeState, setStoreState] = useState({ stock: {}, promocodes: [], orders: [], outbox: [] });
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(false);

  const addLog = (msg, reqId = null) => {
    const trace = reqId ? ` [req:${reqId.slice(0, 6)}]` : '';
    setLogs((prev) => [`[${new Date().toLocaleTimeString()}]${trace} ${msg}`, ...prev]);
  };

  const safeJson = async (res) => {
    const reqId = res.headers.get('x-request-id');
    const text = await res.text();
    if (!text) return { data: {}, reqId };
    return { data: JSON.parse(text), reqId };
  };

  const getErrorMessage = (data, status) =>
    data?.message || (typeof data?.error === 'string' ? data.error : `HTTP ${status}`);

  const refreshState = async () => {
    try {
      const res = await fetch('/api/store/state');
      const { data } = await safeJson(res);
      setStoreState({
        stock: data.stock ?? {},
        promocodes: data.promocodes ?? [],
        orders: data.orders ?? [],
        outbox: data.outbox ?? [],
      });
    } catch (e) {
      addLog(`Ошибка синхронизации БД: ${e.message}`);
    }
  };

  useEffect(() => {
    refreshState();
  }, []);

  const applyPromo = async () => {
    try {
      const res = await fetch('/api/promocodes/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: promoCode }),
      });
      const { data, reqId } = await safeJson(res);
      if (res.ok) {
        setDiscountApplied(true);
        addLog(`Промокод ${promoCode} применён (${data.promo.used_count}/${data.promo.max_uses})`, reqId);
        refreshState();
      } else {
        addLog(`Промокод отклонен: ${getErrorMessage(data, res.status)}`, reqId);
      }
    } catch (e) {
      addLog(`Ошибка: ${e.message}`);
    }
  };

  const createOrder = async (sku = selectedSku) => {
    setLoading(true);
    try {
      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sku, idempotency_key: `ui_${crypto.randomUUID()}` }),
      });
      const { data, reqId } = await safeJson(res);
      if (!res.ok) throw new Error(getErrorMessage(data, res.status));
      setActiveOrder(data);
      setDiscountApplied(false);
      addLog(`Создан заказ ${data.id.slice(0, 8)}... (${sku})`, reqId);
      refreshState();
    } catch (e) {
      addLog(`Ошибка: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  const payOrder = async (orderId) => {
    setLoading(true);
    try {
      const payRes = await fetch('/api/mock-gateway/pay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order_id: orderId }),
      });
      const { data: payData, reqId } = await safeJson(payRes);
      if (!payRes.ok) throw new Error(getErrorMessage(payData, payRes.status));

      const orderRes = await fetch(`/api/orders/${orderId}`);
      const { data: updated } = await safeJson(orderRes);
      setActiveOrder(updated);
      addLog(`Оплата завершена -> статус: ${updated.status}`, reqId);
      refreshState();

      setTimeout(() => void refreshState(), 2200);
    } catch (e) {
      addLog(`Ошибка: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  const retryDelivery = async (orderId) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/orders/${orderId}/retry`, { method: 'POST' });
      const { data, reqId } = await safeJson(res);
      if (!res.ok) throw new Error(getErrorMessage(data, res.status));
      addLog(`Повторная выдача (${orderId.slice(0, 8)}): статус ${data.status}`, reqId);
      refreshState();
      setTimeout(() => void refreshState(), 2200);
    } catch (e) {
      addLog(`Ошибка retry: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  const refillPool = async (sku) => {
    try {
      const keys = Array.from({ length: 10 }, () => `KEY-${crypto.randomUUID().slice(0, 8).toUpperCase()}`);
      const res = await fetch('/api/admin/refill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sku, keys }),
      });
      const { data, reqId } = await safeJson(res);
      addLog(`Админ: добавлено ${data.inserted} ключей для ${sku}`, reqId);
      refreshState();
    } catch (e) {
      addLog(`Ошибка пополнения: ${e.message}`);
    }
  };

  const resetPromo = async () => {
    try {
      const res = await fetch('/api/admin/reset-promo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'PROMO3' }),
      });
      const { reqId } = await safeJson(res);
      setDiscountApplied(false);
      addLog('Админ: счётчик промокода PROMO3 сброшен в 0/3', reqId);
      refreshState();
    } catch (e) {
      addLog(`Ошибка сброса: ${e.message}`);
    }
  };

  const simulateFraud = async (orderId) => {
    setLoading(true);
    try {
      addLog(`Запуск фрод-атаки: 20 параллельных оплат на заказ ${orderId.slice(0, 8)}...`);
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          fetch('/api/mock-gateway/pay', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ order_id: orderId }),
          })
        )
      );
      const ok = results.filter((r) => r.status === 200).length;
      const blocked = results.filter((r) => r.status === 409).length;
      const orderRes = await fetch(`/api/orders/${orderId}`);
      const { data: updated } = await safeJson(orderRes);
      setActiveOrder(updated);
      addLog(`Атака отбита! Прошло: ${ok}, заблокировано (409): ${blocked}. Ключ: ${updated.key || 'нет'}`);
      refreshState();
      setTimeout(() => void refreshState(), 2200);
    } catch (e) {
      addLog(`Ошибка атаки: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  const copyKey = (key) => {
    navigator.clipboard.writeText(key);
    addLog(`Ключ ${key} скопирован в буфер обмена`);
  };
  return (
    <div style={{ maxWidth: 920, margin: '32px auto', fontFamily: 'system-ui, sans-serif', color: '#f1f5f9', padding: '0 16px' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24, borderBottom: '1px solid #1e293b', paddingBottom: 16 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 24 }}>GAMEKEY.CORE</h1>
          <span style={{ fontSize: 13, color: '#94a3b8' }}>TypeScript • Clean Architecture • Transactional Outbox • PostgreSQL</span>
        </div>
        <div style={{ display: 'flex', gap: 8, background: '#0f172a', padding: 6, borderRadius: 12, border: '1px solid #1e293b' }}>
          <button
            onClick={() => setTab('store')}
            style={{ padding: '8px 16px', borderRadius: 8, border: 'none', cursor: 'pointer', fontWeight: 600, background: tab === 'store' ? '#2563eb' : 'transparent', color: '#fff' }}
          >
            Витрина и заказы
          </button>
          <button
            onClick={() => setTab('admin')}
            style={{ padding: '8px 16px', borderRadius: 8, border: 'none', cursor: 'pointer', fontWeight: 600, background: tab === 'admin' ? '#2563eb' : 'transparent', color: '#fff' }}
          >
            Админка и Race Lab
          </button>
        </div>
      </header>

      {tab === 'store' ? (
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 24 }}>
            {PRODUCTS.map((p) => {
              const count = storeState.stock[p.sku] ?? 0;
              const finalPrice = discountApplied ? Math.round(p.price * 0.8) : p.price;
              return (
                <div key={p.sku} style={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 14, padding: 20 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 12, padding: '4px 10px', borderRadius: 20, background: count > 0 ? '#064e3b' : '#7f1d1d', color: count > 0 ? '#6ee7b7' : '#fca5a5' }}>
                      В наличии: {count} шт.
                    </span>
                    <span style={{ color: '#64748b', fontSize: 12 }}>{p.sku}</span>
                  </div>
                  <h3 style={{ margin: '14px 0 6px' }}>{p.title}</h3>
                  <p style={{ margin: '0 0 16px', color: '#94a3b8', fontSize: 14 }}>{p.desc}</p>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ fontSize: 22, fontWeight: 700, color: '#38bdf8' }}>
                      {finalPrice} ₽ {discountApplied && <span style={{ fontSize: 13, textDecoration: 'line-through', color: '#64748b' }}>{p.price} ₽</span>}
                    </div>
                    <button
                      onClick={() => { setSelectedSku(p.sku); createOrder(p.sku); }}
                      disabled={loading}
                      style={{ padding: '10px 18px', borderRadius: 10, border: 'none', background: '#2563eb', color: '#fff', fontWeight: 600, cursor: 'pointer' }}
                    >
                      Оформить заказ
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          <div style={{ display: 'flex', gap: 10, background: '#0f172a', padding: 14, borderRadius: 12, border: '1px solid #1e293b', marginBottom: 24 }}>
            <input
              value={promoCode}
              onChange={(e) => setPromoCode(e.target.value)}
              placeholder="Введите промокод (PROMO3)"
              style={{ flex: 1, padding: '10px 14px', borderRadius: 8, border: '1px solid #334155', background: '#020617', color: '#fff' }}
            />
            <button onClick={applyPromo} style={{ padding: '10px 20px', borderRadius: 8, border: 'none', background: '#059669', color: '#fff', fontWeight: 600, cursor: 'pointer' }}>
              Применить скидку 20%
            </button>
          </div>

          <h3 style={{ marginBottom: 12 }}>Последние заказы в PostgreSQL</h3>
          <div style={{ background: '#0f172a', borderRadius: 12, border: '1px solid #1e293b', overflow: 'hidden', marginBottom: 24 }}>
            {storeState.orders.length === 0 ? (
              <div style={{ padding: 20, color: '#64748b' }}>Заказов пока нет — оформите первый выше</div>
            ) : (
              storeState.orders.map((o) => (
                <div key={o.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 18px', borderBottom: '1px solid #1e293b' }}>
                  <div>
                    <div style={{ fontWeight: 600 }}>{o.sku} <span style={{ color: '#64748b', fontSize: 12 }}>#{o.id.slice(0, 8)}</span></div>
                    <div style={{ fontSize: 13, color: o.status === 'delivered' ? '#4ade80' : o.status === 'out_of_stock' ? '#fbbf24' : '#38bdf8' }}>
                      Статус: {o.status}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    {o.key && (
                      <button onClick={() => copyKey(o.key)} style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #334155', background: '#020617', color: '#4ade80', fontFamily: 'monospace', cursor: 'pointer' }}>
                        {o.key} (Копировать)
                      </button>
                    )}
                    {o.status === 'created' && (
                      <button onClick={() => payOrder(o.id)} disabled={loading} style={{ padding: '8px 14px', borderRadius: 8, border: 'none', background: '#16a34a', color: '#fff', fontWeight: 600, cursor: 'pointer' }}>
                        Оплатить
                      </button>
                    )}
                    {o.status === 'out_of_stock' && (
                      <button onClick={() => retryDelivery(o.id)} disabled={loading} style={{ padding: '8px 14px', borderRadius: 8, border: 'none', background: '#d97706', color: '#fff', fontWeight: 600, cursor: 'pointer' }}>
                        Повторить выдачу (Retry)
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <h3 style={{ margin: 0 }}>Transactional Outbox (Очередь событий)</h3>
            <button
              onClick={refreshState}
              style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid #334155', background: '#0f172a', color: '#94a3b8', fontSize: 12, cursor: 'pointer' }}
            >
              Обновить
            </button>
          </div>

          <div style={{ background: '#0f172a', borderRadius: 12, border: '1px solid #1e293b', overflow: 'hidden', marginBottom: 24 }}>
            {storeState.outbox.length === 0 ? (
              <div style={{ padding: 16, color: '#64748b', fontSize: 13 }}>
                Событий пока нет — оплатите заказ, чтобы увидеть работу Outbox-воркера
              </div>
            ) : (
              storeState.outbox.map((ev) => (
                <div key={ev.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 18px', borderBottom: '1px solid #1e293b', fontSize: 13 }}>
                  <div>
                    <span style={{ fontFamily: 'monospace', color: '#e2e8f0', fontWeight: 600 }}>{ev.event_type}</span>
                    <span style={{ color: '#64748b', marginLeft: 8 }}>order #{ev.aggregate_id.slice(0, 8)}</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ color: '#64748b', fontSize: 12 }}>попыток: {ev.attempts}</span>
                    <span
                      style={{
                        padding: '3px 10px',
                        borderRadius: 20,
                        fontSize: 12,
                        fontWeight: 600,
                        background: ev.status === 'processed' ? '#064e3b' : ev.status === 'pending' ? '#451a03' : '#7f1d1d',
                        color: ev.status === 'processed' ? '#6ee7b7' : ev.status === 'pending' ? '#fcd34d' : '#fca5a5',
                      }}
                    >
                      {ev.status}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      ) : (
        <div style={{ background: '#0f172a', padding: 20, borderRadius: 14, border: '1px solid #1e293b', marginBottom: 24 }}>
          <h3 style={{ marginTop: 0 }}>Управление складом и Race Condition Lab</h3>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
            {PRODUCTS.map((p) => (
              <button key={p.sku} onClick={() => refillPool(p.sku)} style={{ padding: '10px 16px', borderRadius: 8, border: 'none', background: '#059669', color: '#fff', cursor: 'pointer' }}>
                +10 ключей: {p.sku} ({storeState.stock[p.sku] ?? 0})
              </button>
            ))}
            <button onClick={resetPromo} style={{ padding: '10px 16px', borderRadius: 8, border: 'none', background: '#475569', color: '#fff', cursor: 'pointer' }}>
              Сбросить лимит PROMO3
            </button>
          </div>

          {activeOrder && activeOrder.status === 'created' ? (
            <button onClick={() => simulateFraud(activeOrder.id)} disabled={loading} style={{ padding: '12px 18px', borderRadius: 8, border: 'none', background: '#dc2626', color: '#fff', fontWeight: 700, cursor: 'pointer' }}>
              Запустить фрод-атаку (20 оплат) на заказ #{activeOrder.id.slice(0, 8)}
            </button>
          ) : (
            <div style={{ color: '#94a3b8', fontSize: 14 }}>Создайте неоплаченный заказ на витрине, чтобы протестировать на нём 20 параллельных оплат.</div>
          )}
        </div>
      )}

      <div style={{ background: '#020617', padding: 14, borderRadius: 12, border: '1px solid #1e293b', fontFamily: 'monospace', fontSize: 13, maxHeight: 180, overflowY: 'auto' }}>
        {logs.length === 0 ? <span style={{ color: '#64748b' }}>Системный журнал операций пуст...</span> : logs.map((l, i) => <div key={i}>{l}</div>)}
      </div>
    </div>
  );
}
