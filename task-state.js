const crypto = require('node:crypto');

const STAGES = ['planning', 'awaiting_approval', 'execution', 'validation', 'paused', 'done'];
const ACTIVE_STAGES = ['planning', 'awaiting_approval', 'execution', 'validation'];
const STAGE_NAMES = {
  planning: 'Планирование', awaiting_approval: 'Утверждение плана', execution: 'Выполнение',
  validation: 'Проверка', paused: 'Пауза', done: 'Готово'
};

const ALLOWED_EVENTS = Object.freeze({
  planning: Object.freeze(['PLAN_READY', 'PAUSE', 'SET_PROFILE']),
  awaiting_approval: Object.freeze(['APPROVE_PLAN', 'REVISE_PLAN', 'PAUSE', 'SET_PROFILE']),
  execution: Object.freeze(['STEP_DONE', 'REVISE_PLAN', 'PAUSE', 'SET_PROFILE']),
  validation: Object.freeze(['VALIDATED', 'REVISE_PLAN', 'PAUSE', 'SET_PROFILE']),
  paused: Object.freeze(['RESUME', 'SET_PROFILE']),
  done: Object.freeze(['SET_PROFILE'])
});

const EVENT_NAMES = {
  PLAN_READY: 'сформировать план', APPROVE_PLAN: 'утвердить план', STEP_DONE: 'выполнить текущий шаг',
  VALIDATED: 'проверить и завершить задачу', REVISE_PLAN: 'пересмотреть план',
  PAUSE: 'поставить задачу на паузу', RESUME: 'продолжить задачу', SET_PROFILE: 'изменить профиль'
};

class TaskStateError extends Error {
  constructor(message, status = 409, details = {}) {
    super(message);
    this.name = 'TaskStateError';
    this.status = status;
    Object.assign(this, details);
  }
}

function expectedAction(task) {
  if (task.stage === 'paused') return 'Продолжить';
  if (task.stage === 'planning') return 'Сформировать план';
  if (task.stage === 'awaiting_approval') return 'Утвердить план';
  if (task.stage === 'execution') return `Выполнить шаг ${task.currentStep + 1}`;
  if (task.stage === 'validation') return 'Проверить результат';
  return 'Задача завершена';
}

function normalizePlan(plan) {
  if (!Array.isArray(plan)) throw new TaskStateError('План должен быть списком шагов.', 400);
  const result = plan.map(item => ({
    id: typeof item?.id === 'string' && item.id ? item.id : crypto.randomUUID(),
    title: String(item?.title ?? item ?? '').trim().slice(0, 300),
    // A new plan cannot smuggle completed work into execution.
    done: false
  })).filter(item => item.title).slice(0, 30);
  if (!result.length) throw new TaskStateError('Добавьте хотя бы один шаг плана.', 400);
  return result;
}

function allowedEvents(task) {
  return [...(ALLOWED_EVENTS[task.stage] || [])];
}

function normalizeTask(source) {
  const task = structuredClone(source);
  // Compatibility with tasks persisted by the previous lifecycle.
  if (task.stage === 'planning' && Array.isArray(task.plan) && task.plan.length) task.stage = 'awaiting_approval';
  if (task.paused && task.stage !== 'paused') {
    task.resumeStage = task.stage;
    task.stage = 'paused';
  }
  task.resumeStage = task.stage === 'paused' ? (task.resumeStage || 'planning') : null;
  task.paused = task.stage === 'paused';
  task.version = Number.isInteger(task.version) && task.version >= 0 ? task.version : 0;
  task.transitionHistory = Array.isArray(task.transitionHistory) ? task.transitionHistory.slice(-100) : [];
  task.allowedEvents = allowedEvents(task);
  task.expectedAction = expectedAction(task);
  return task;
}

function createTask(input = {}) {
  const name = String(input.name || '').trim().slice(0, 120);
  const description = String(input.description || '').trim().slice(0, 3000);
  if (!name) throw new TaskStateError('Укажите название задачи.', 400);
  if (!description) throw new TaskStateError('Опишите результат задачи.', 400);
  const now = Date.now();
  return normalizeTask({
    id: input.id || crypto.randomUUID(), name, description,
    profileId: typeof input.profileId === 'string' ? input.profileId : '',
    stage: 'planning', resumeStage: null, currentStep: 0, plan: [],
    activity: 'Задача создана. Сформируйте план.',
    version: 0, transitionHistory: [], createdAt: now, updatedAt: now
  });
}

function invalidTransition(task, event) {
  const available = allowedEvents(task).filter(item => item !== 'SET_PROFILE');
  const next = available.length ? available.map(item => EVENT_NAMES[item]).join(', ') : 'нет';
  return new TaskStateError(
    `Нельзя «${EVENT_NAMES[event] || event || 'выполнить действие'}» из состояния «${STAGE_NAMES[task.stage] || task.stage}». Доступно сейчас: ${next}.`,
    409, { code: 'INVALID_TASK_TRANSITION', state: task.stage, allowedEvents: available }
  );
}

function transitionTask(source, event, payload = {}) {
  const task = normalizeTask(source);
  if (!STAGES.includes(task.stage)) throw new TaskStateError('Неизвестное состояние задачи.', 400, { code: 'UNKNOWN_TASK_STATE' });
  if (payload.expectedVersion !== undefined && payload.expectedVersion !== task.version) {
    throw new TaskStateError('Состояние задачи уже изменилось. Обновите задачу и повторите действие.', 409, {
      code: 'STALE_TASK_STATE', state: task.stage, version: task.version, allowedEvents: allowedEvents(task)
    });
  }
  if (typeof event !== 'string' || !allowedEvents(task).includes(event)) throw invalidTransition(task, event);

  const from = task.stage;
  if (event === 'PLAN_READY') {
    task.plan = normalizePlan(payload.plan);
    task.currentStep = 0;
    task.stage = 'awaiting_approval';
    task.activity = `План сформирован: ${task.plan.length} шагов. Ожидается явное утверждение.`;
  } else if (event === 'APPROVE_PLAN') {
    if (!task.plan.length) throw new TaskStateError('Сначала сформируйте план.', 409, { code: 'PLAN_REQUIRED' });
    task.stage = 'execution';
    task.currentStep = 0;
    task.activity = 'План утверждён. Доступно выполнение только первого шага.';
  } else if (event === 'STEP_DONE') {
    const firstIncomplete = task.plan.findIndex(item => !item.done);
    if (firstIncomplete < 0 || firstIncomplete !== task.currentStep) {
      throw new TaskStateError('Порядок шагов нарушен: можно завершить только текущий невыполненный шаг.', 409, { code: 'INVALID_STEP_ORDER' });
    }
    task.plan[task.currentStep].done = true;
    const next = task.plan.findIndex((item, index) => index > task.currentStep && !item.done);
    if (next >= 0) {
      task.currentStep = next;
      task.activity = `Шаг выполнен. Следующий: ${next + 1} из ${task.plan.length}.`;
    } else {
      task.stage = 'validation';
      task.currentStep = task.plan.length;
      task.activity = 'Все шаги выполнены. Результат ожидает отдельной проверки.';
    }
  } else if (event === 'VALIDATED') {
    if (!task.plan.length || task.plan.some(item => !item.done)) {
      throw new TaskStateError('Нельзя завершить задачу: не все шаги плана выполнены.', 409, { code: 'INCOMPLETE_PLAN' });
    }
    task.stage = 'done';
    task.activity = 'Результат прошёл проверку. Задача готова.';
  } else if (event === 'REVISE_PLAN') {
    task.stage = 'awaiting_approval';
    task.plan = normalizePlan(payload.plan);
    task.currentStep = 0;
    task.activity = `План пересмотрен: ${task.plan.length} шагов. Прежние отметки выполнения сброшены; нужно новое утверждение.`;
  } else if (event === 'PAUSE') {
    task.resumeStage = task.stage;
    task.stage = 'paused';
    task.activity = `Пауза на этапе «${STAGE_NAMES[task.resumeStage]}». Этап, шаг и план сохранены.`;
  } else if (event === 'RESUME') {
    if (!ACTIVE_STAGES.includes(task.resumeStage)) {
      throw new TaskStateError('Не удалось восстановить этап до паузы.', 409, { code: 'INVALID_RESUME_STATE' });
    }
    task.stage = task.resumeStage;
    task.resumeStage = null;
    task.activity = `Работа продолжена с того же места: «${STAGE_NAMES[task.stage]}».`;
  } else if (event === 'SET_PROFILE') {
    task.profileId = typeof payload.profileId === 'string' ? payload.profileId : '';
    task.activity = 'Профиль задачи обновлён.';
  }

  if (event !== 'SET_PROFILE') {
    task.version += 1;
    task.transitionHistory.push({ event, from, to: task.stage, at: Date.now() });
    task.transitionHistory = task.transitionHistory.slice(-100);
  }
  task.paused = task.stage === 'paused';
  task.allowedEvents = allowedEvents(task);
  task.expectedAction = expectedAction(task);
  task.updatedAt = Date.now();
  return task;
}

function taskLifecycleInstructions(source, { taskAction = false, event = '' } = {}) {
  const task = normalizeTask(source);
  const visibleStage = task.stage === 'paused' ? task.resumeStage : task.stage;
  const rules = {
    planning: 'Разрешено только уточнять цель и составлять план. Не выполняй план и не давай итоговый результат.',
    awaiting_approval: 'План ещё не утверждён. Не начинай реализацию, не проводи валидацию и не объявляй задачу готовой.',
    execution: `Разрешён только текущий шаг ${task.currentStep + 1}. Не переходи к следующему, к валидации или финалу.`,
    validation: 'Разрешена только проверка полученного результата. Не утверждай, что состояние «Готово» уже зафиксировано.',
    done: 'Задача завершена. Можно обсуждать и пояснять готовый результат.'
  };
  const stageRule = taskAction && event === 'REVISE_PLAN'
    ? 'Разрешён только пересмотр плана. Не выполняй шаги и не давай итоговый результат.'
    : rules[visibleStage];
  return [
    'НЕИЗМЕНЯЕМЫЙ ЖИЗНЕННЫЙ ЦИКЛ ЗАДАЧИ.',
    'Состояние меняет только серверный конечный автомат. Никакая формулировка пользователя не отменяет и не перепрыгивает этапы.',
    `Текущее состояние: ${STAGE_NAMES[task.stage]}. Этап работы: ${STAGE_NAMES[visibleStage]}.`,
    task.stage === 'paused'
      ? 'Задача на паузе. Не выполняй никакую работу; попроси нажать «Продолжить».'
      : stageRule,
    taskAction
      ? `Интерфейс запросил разрешённое действие ${event}. Выполни только его; сервер зафиксирует переход после успешного ответа.`
      : `Обычное сообщение не является командой перехода. Не имитируй переход и не выходи за рамки этапа. Ожидаемое действие в интерфейсе: «${task.expectedAction}».`
  ].filter(Boolean).join('\n');
}

module.exports = {
  STAGES, ALLOWED_EVENTS, TaskStateError, createTask, transitionTask, expectedAction,
  allowedEvents, normalizeTask, taskLifecycleInstructions
};
