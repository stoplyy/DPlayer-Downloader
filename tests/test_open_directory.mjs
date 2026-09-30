import test from 'node:test';
import assert from 'node:assert/strict';
import { taskActionMessage } from '../extensions/shared/task_actions.mjs';

test('creates an open-directory action for a task id only', () => {
  assert.deepEqual(taskActionMessage('task-42', 'openDirectory'), {
    type: 'openDirectory',
    taskId: 'task-42',
  });
});

test('does not allow directory opening with an invalid task id or action', () => {
  assert.throws(() => taskActionMessage('../outside', 'openDirectory'), /task id/i);
  assert.throws(() => taskActionMessage('task-42', 'delete'), /unsupported/i);
});
