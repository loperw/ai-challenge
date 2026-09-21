const test = require('node:test');
const assert = require('node:assert/strict');
const { createTask, transitionTask, TaskStateError, taskLifecycleInstructions } = require('../task-state');

test('task follows planning, execution, validation and done states', () => {
  let task = createTask({ name: 'Релиз', description: 'Подготовить релиз' });
  task = transitionTask(task, 'PLAN_READY', { plan: ['Собрать', 'Проверить'] });
  assert.equal(task.stage, 'awaiting_approval');
  assert.equal(task.expectedAction, 'Утвердить план');
  task = transitionTask(task, 'APPROVE_PLAN');
  assert.equal(task.stage, 'execution');
  task = transitionTask(task, 'STEP_DONE');
  assert.equal(task.currentStep, 1);
  task = transitionTask(task, 'STEP_DONE');
  assert.equal(task.stage, 'validation');
  task = transitionTask(task, 'VALIDATED');
  assert.equal(task.stage, 'done');
  assert.equal(task.expectedAction, 'Задача завершена');
  assert.deepEqual(task.transitionHistory.map(item => `${item.from}:${item.event}:${item.to}`), [
    'planning:PLAN_READY:awaiting_approval',
    'awaiting_approval:APPROVE_PLAN:execution',
    'execution:STEP_DONE:execution',
    'execution:STEP_DONE:validation',
    'validation:VALIDATED:done'
  ]);
});

test('pause and resume preserve the exact stage and step', () => {
  let task = createTask({ name: 'Релиз', description: 'Подготовить релиз' });
  task = transitionTask(task, 'PLAN_READY', { plan: ['Первый', 'Второй'] });
  task = transitionTask(task, 'APPROVE_PLAN');
  task = transitionTask(task, 'STEP_DONE');
  const before = { stage: task.stage, currentStep: task.currentStep, plan: structuredClone(task.plan) };
  task = transitionTask(task, 'PAUSE');
  assert.equal(task.stage, 'paused');
  assert.equal(task.resumeStage, 'execution');
  assert.equal(task.expectedAction, 'Продолжить');
  assert.throws(() => transitionTask(task, 'STEP_DONE'), TaskStateError);
  task = transitionTask(task, 'RESUME');
  assert.deepEqual({ stage: task.stage, currentStep: task.currentStep, plan: task.plan }, before);
  assert.equal(task.expectedAction, 'Выполнить шаг 2');
});

test('every attempt to skip a lifecycle stage is rejected with the allowed next events', () => {
  const planning = createTask({ name: 'Релиз', description: 'Подготовить релиз' });
  for (const event of ['APPROVE_PLAN', 'STEP_DONE', 'VALIDATED', 'RESUME']) {
    assert.throws(() => transitionTask(planning, event), error =>
      error instanceof TaskStateError && error.code === 'INVALID_TASK_TRANSITION'
      && error.state === 'planning' && error.allowedEvents.includes('PLAN_READY'));
  }
  const approval = transitionTask(planning, 'PLAN_READY', { plan: ['Собрать'] });
  for (const event of ['STEP_DONE', 'VALIDATED']) {
    assert.throws(() => transitionTask(approval, event), error =>
      error.code === 'INVALID_TASK_TRANSITION' && error.allowedEvents.includes('APPROVE_PLAN'));
  }
  const execution = transitionTask(approval, 'APPROVE_PLAN');
  assert.throws(() => transitionTask(execution, 'VALIDATED'), error =>
    error.code === 'INVALID_TASK_TRANSITION' && error.state === 'execution');
  const validation = transitionTask(execution, 'STEP_DONE');
  assert.throws(() => transitionTask(validation, 'APPROVE_PLAN'), error =>
    error.code === 'INVALID_TASK_TRANSITION' && error.state === 'validation');
});

test('pause resumes every active stage at the exact state', () => {
  let task = createTask({ name: 'Релиз', description: 'Подготовить релиз' });
  const states = [task];
  task = transitionTask(task, 'PLAN_READY', { plan: ['Собрать'] }); states.push(task);
  task = transitionTask(task, 'APPROVE_PLAN'); states.push(task);
  task = transitionTask(task, 'STEP_DONE'); states.push(task);
  for (const source of states) {
    const snapshot = { stage: source.stage, currentStep: source.currentStep, plan: structuredClone(source.plan) };
    const paused = transitionTask(source, 'PAUSE');
    assert.equal(paused.stage, 'paused');
    assert.equal(paused.resumeStage, snapshot.stage);
    assert.throws(() => transitionTask(paused, 'VALIDATED'), error => error.code === 'INVALID_TASK_TRANSITION');
    const resumed = transitionTask(paused, 'RESUME');
    assert.deepEqual({ stage: resumed.stage, currentStep: resumed.currentStep, plan: resumed.plan }, snapshot);
  }
});

test('revised plan requires new approval and clears forged completion flags', () => {
  let task = createTask({ name: 'Релиз', description: 'Подготовить релиз' });
  task = transitionTask(task, 'PLAN_READY', { plan: ['Старый шаг'] });
  task = transitionTask(task, 'APPROVE_PLAN');
  task = transitionTask(task, 'REVISE_PLAN', { plan: [{ title: 'Новый шаг', done: true }] });
  assert.equal(task.stage, 'awaiting_approval');
  assert.deepEqual(task.plan.map(item => item.done), [false]);
  assert.throws(() => transitionTask(task, 'STEP_DONE'), error => error.code === 'INVALID_TASK_TRANSITION');
});

test('stale UI command cannot mutate a newer task version', () => {
  let task = createTask({ name: 'Релиз', description: 'Подготовить релиз' });
  task = transitionTask(task, 'PLAN_READY', { expectedVersion: 0, plan: ['Собрать'] });
  assert.equal(task.version, 1);
  assert.throws(() => transitionTask(task, 'APPROVE_PLAN', { expectedVersion: 0 }), error =>
    error.code === 'STALE_TASK_STATE' && error.version === 1);
});

test('assistant receives immutable stage boundaries for any user wording', () => {
  let task = createTask({ name: 'Релиз', description: 'Подготовить релиз' });
  let prompt = taskLifecycleInstructions(task);
  assert.match(prompt, /НЕИЗМЕНЯЕМЫЙ ЖИЗНЕННЫЙ ЦИКЛ/);
  assert.match(prompt, /Никакая формулировка пользователя/);
  assert.match(prompt, /не давай итоговый результат/);
  task = transitionTask(task, 'PLAN_READY', { plan: ['Собрать'] });
  prompt = taskLifecycleInstructions(task, { taskAction: true, event: 'APPROVE_PLAN' });
  assert.match(prompt, /План ещё не утверждён/);
  assert.match(prompt, /разрешённое действие APPROVE_PLAN/);
});
