const test = require('node:test');
const assert = require('node:assert/strict');
const { createTask, transitionTask, TaskStateError } = require('../task-state');

test('task follows planning, execution, validation and done states', () => {
  let task = createTask({ name: 'Релиз', description: 'Подготовить релиз' });
  task = transitionTask(task, 'PLAN_READY', { plan: ['Собрать', 'Проверить'] });
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
});

test('pause and resume preserve the exact stage and step', () => {
  let task = createTask({ name: 'Релиз', description: 'Подготовить релиз' });
  task = transitionTask(task, 'PLAN_READY', { plan: ['Первый', 'Второй'] });
  task = transitionTask(task, 'APPROVE_PLAN');
  task = transitionTask(task, 'STEP_DONE');
  const before = { stage: task.stage, currentStep: task.currentStep, plan: structuredClone(task.plan) };
  task = transitionTask(task, 'PAUSE');
  assert.equal(task.expectedAction, 'Продолжить');
  assert.throws(() => transitionTask(task, 'STEP_DONE'), TaskStateError);
  task = transitionTask(task, 'RESUME');
  assert.deepEqual({ stage: task.stage, currentStep: task.currentStep, plan: task.plan }, before);
  assert.equal(task.expectedAction, 'Выполнить шаг 2');
});
