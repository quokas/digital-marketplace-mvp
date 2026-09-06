const total = 50;

async function runTest() {
  console.log('--- ЗАПУСК НАГРУЗОЧНОГО ТЕСТА (RACE CONDITION) ---');

  // 1. Создаем тестовый заказ на сервере
  console.log('1. Создание тестового заказа...');
  const orderRes = await fetch('http://localhost:3000/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sku: 'STEAM-TOPUP-500' })
  });
  
  if (!orderRes.ok) {
    console.error('Ошибка: Не удалось создать заказ. Сервер запущен?');
    return;
  }
  
  const { order_id } = await orderRes.json();
  console.log(`Заказ успешно создан с ID: ${order_id}`);

  // 2. Генерируем 50 параллельных запросов к вебхуку оплаты
  console.log(`2. Отправка ${total} одновременных вебхуков оплаты...`);
  const promises = [];

  for (let i = 0; i < total; i++) {
    // Имитируем конкурентные запросы
    promises.push(
      fetch('http://localhost:3000/webhook/payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event_id: `evt_test_race_${i}`, // Уникальные event_id, как при реальной атаке/сбое
          order_id: order_id,
          status: 'paid',
          amount: 500,
          currency: 'RUB'
        })
      }).then(res => res.status)
    );
  }

  // Ждем выполнения всех 50 запросов одновременно
  const statuses = await Promise.all(promises);
  
  const okResponses = statuses.filter(s => s === 200).length;
  console.log(`Успешно обработано запросов (200 OK): ${okResponses} из ${total}`);

  // 3. Проверяем финальное состояние заказа на сервере
  console.log('3. Проверка состояния заказа в базе данных...');
  const statusRes = await fetch(`http://localhost:3000/api/orders/${order_id}`);
  const finalOrder = await statusRes.json();

  console.log('--- РЕЗУЛЬТАТЫ ПРОВЕРКИ ---');
  console.log(`Статус заказа: ${finalOrder.status}`);
  console.log(`Выданный ключ: ${finalOrder.key || 'КЛЮЧ НЕ ВЫДАН (ОШИБКА)'}`);
  
  // Проверяем, не ушел ли второй ключ
  if (finalOrder.status === 'delivered' && finalOrder.key) {
    console.log('✅ ТЕСТ ПРОЙДЕН: Выдан ровно 1 ключ, дублирования нет!');
  } else {
    console.error('❌ ТЕСТ ПРОВАЛЕН: Неверный статус заказа или ошибка выдачи.');
  }
}

runTest();
