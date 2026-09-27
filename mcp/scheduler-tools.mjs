import { z } from 'zod';
import { ScheduleStore } from '../scheduler.js';

export function registerSchedulerTools(server) {
  // Short-lived MCP connections share durable state with the long-running worker.
  const handler = action => async input => {
    const store = new ScheduleStore();
    try {
      const output = action(store, input);
      return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error.message }] };
    } finally { store.close(); }
  };
  server.registerTool('schedule_task', {
    title: 'Создать расписание',
    description: 'Сохраняет отложенное или периодическое задание в SQLite. Сервер приложения выполняет его в фоне. Для погоды первый сбор сразу, далее по интервалу. Результаты во вкладке «Мониторинг» и get_schedule_results.',
    inputSchema: z.object({
      kind: z.enum(['weather', 'reminder']), title: z.string().max(160).optional(),
      location: z.string().min(1).max(120).optional(), message: z.string().min(1).max(2000).optional(),
      intervalSeconds: z.number().int().min(30).max(2592000).optional().describe('Период, минимум 30 секунд'),
      delaySeconds: z.number().int().min(0).max(31536000).optional().describe('Задержка первого запуска; без периода задание одноразовое')
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, handler((store, input) => ({ job: store.create(input) })));
  server.registerTool('list_schedules', {
    title: 'Расписания', description: 'Возвращает сохранённые расписания и их статусы.',
    inputSchema: z.object({}), annotations: { readOnlyHint: true, openWorldHint: false }
  }, handler(store => ({ jobs: store.list() })));
  server.registerTool('get_schedule_results', {
    title: 'Сводка по расписанию', description: 'Возвращает историю и агрегированную сводку последних 1000 запусков: минимум, максимум и среднюю температуру; общие счётчики успехов и ошибок.',
    inputSchema: z.object({ id: z.string().uuid(), limit: z.number().int().min(1).max(100).default(30) }),
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, handler((store, input) => store.results(input.id, input.limit)));
  server.registerTool('set_schedule_status', {
    title: 'Управление расписанием', description: 'Приостановить, возобновить или окончательно отменить расписание.',
    inputSchema: z.object({ id: z.string().uuid(), status: z.enum(['active', 'paused', 'cancelled']) }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, handler((store, input) => ({ job: store.setStatus(input.id, input.status) })));
  server.registerTool('delete_schedule', {
    title: 'Удалить мониторинг', description: 'Удаляет выбранное расписание и всю его историю. Незавершённый результат не будет сохранён.',
    inputSchema: z.object({ id: z.string().uuid() }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
  }, handler((store, input) => store.remove(input.id)));
}
