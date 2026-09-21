const crypto = require('node:crypto');

const STAGES = ['planning', 'execution', 'validation', 'done'];
const STAGE_NAMES = { planning: 'Планирование', execution: 'Выполнение', validation: 'Проверка', done: 'Готово' };

class TaskStateError extends Error {
  constructor(message, status = 409) {
    super(message);
    this.name = 'TaskStateError';
    this.status = status;
  }
}

function expectedAction(task) {
  if (task.paused) return 'Продолжить';
  if (task.stage === 'planning') return task.plan.length ? 'Утвердить план' : 'Сформировать план';
  if (task.stage === 'execution') return `Выполнить шаг ${task.currentStep + 1}`;
  if (task.stage === 'validation') return 'Проверить результат';
  return 'Задача завершена';
}

function normalizePlan(plan) {
  if (!Array.isArray(plan)) throw new TaskStateError('План должен быть списком шагов.', 400);
  const result = plan.map((item, index) => ({
    id: typeof item?.id === 'string' && item.id ? item.id : crypto.randomUUID(),
    title: String(item?.title ?? item ?? '').trim().slice(0, 300),
    done: Boolean(item?.done)
  })).filter(item => item.title).slice(0, 30);
  if (!result.length) throw new TaskStateError('Добавьте хотя бы один шаг плана.', 400);
  return result;
}

function createTask(input = {}) {
  const name = String(input.name || '').trim().slice(0, 120);
  const description = String(input.description || '').trim().slice(0, 3000);
  if (!name) throw new TaskStateError('Укажите название задачи.', 400);
  if (!description) throw new TaskStateError('Опишите результат задачи.', 400);
  const now = Date.now();
  const task = {
    id: input.id || crypto.randomUUID(),
    name,
    description,
    profileId: typeof input.profileId === 'string' ? input.profileId : '',
    stage: 'planning',
    currentStep: 0,
    expectedAction: 'Сформировать план',
    paused: false,
    plan: [],
    activity: 'Задача создана. Сформируйте план.',
    createdAt: now,
    updatedAt: now
  };
  return task;
}

function transitionTask(source, event, payload = {}) {
  const task = structuredClone(source);
  if (!STAGES.includes(task.stage)) throw new TaskStateError('Неизвестный этап задачи.', 400);

  if (event === 'PAUSE') {
    if (task.stage === 'done') throw new TaskStateError('Завершённую задачу нельзя поставить на паузу.');
    if (task.paused) throw new TaskStateError('Задача уже на паузе.');
    task.paused = true;
    task.activity = `Пауза на этапе «${STAGE_NAMES[task.stage]}», шаг ${task.currentStep + 1}.`;
  } else if (event === 'RESUME') {
    if (!task.paused) throw new TaskStateError('Задача не находится на паузе.');
    task.paused = false;
    task.activity = `Работа продолжена без сброса контекста: этап «${STAGE_NAMES[task.stage]}», шаг ${task.currentStep + 1}.`;
  } else {
    if (task.paused) throw new TaskStateError('Сначала продолжите задачу.');
    if (event === 'PLAN_READY') {
      if (task.stage !== 'planning') throw new TaskStateError('План можно сформировать только на этапе планирования.');
      task.plan = normalizePlan(payload.plan);
      task.currentStep = 0;
      task.activity = `План сформирован: ${task.plan.length} шагов. Ожидается утверждение.`;
    } else if (event === 'APPROVE_PLAN') {
      if (task.stage !== 'planning' || !task.plan.length) throw new TaskStateError('Сначала сформируйте план.');
      task.stage = 'execution';
      task.currentStep = task.plan.findIndex(item => !item.done);
      if (task.currentStep < 0) task.currentStep = 0;
      task.activity = `План утверждён. Готов к шагу ${task.currentStep + 1}.`;
    } else if (event === 'STEP_DONE') {
      if (task.stage !== 'execution') throw new TaskStateError('Сейчас задача не находится на этапе выполнения.');
      if (!task.plan[task.currentStep]) throw new TaskStateError('Текущий шаг плана не найден.', 400);
      task.plan[task.currentStep].done = true;
      const next = task.plan.findIndex((item, index) => index > task.currentStep && !item.done);
      if (next >= 0) {
        task.currentStep = next;
        task.activity = `Шаг выполнен. Следующий: ${next + 1} из ${task.plan.length}.`;
      } else {
        task.stage = 'validation';
        task.currentStep = task.plan.length;
        task.activity = 'Все шаги выполнены. Результат ожидает проверки.';
      }
    } else if (event === 'VALIDATED') {
      if (task.stage !== 'validation') throw new TaskStateError('Проверка доступна после выполнения всех шагов.');
      task.stage = 'done';
      task.activity = 'Результат проверен. Задача готова.';
    } else if (event === 'REVISE_PLAN') {
      if (task.stage === 'done') throw new TaskStateError('Завершённую задачу нельзя вернуть к планированию.');
      task.stage = 'planning';
      task.plan = normalizePlan(payload.plan);
      task.currentStep = 0;
      task.activity = `План пересмотрен: ${task.plan.length} шагов. Ожидается утверждение.`;
    } else if (event === 'SET_PROFILE') {
      task.profileId = typeof payload.profileId === 'string' ? payload.profileId : '';
      task.activity = 'Профиль задачи обновлён.';
    } else {
      throw new TaskStateError('Неизвестное действие задачи.', 400);
    }
  }
  task.expectedAction = expectedAction(task);
  task.updatedAt = Date.now();
  return task;
}

module.exports = { STAGES, TaskStateError, createTask, transitionTask, expectedAction };
