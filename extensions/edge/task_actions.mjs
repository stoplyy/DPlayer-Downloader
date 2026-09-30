const TASK_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

export function taskActionMessage(taskId, action) {
  if (typeof taskId !== 'string' || !TASK_ID_PATTERN.test(taskId)) {
    throw new Error('Invalid task id');
  }
  if (action !== 'openDirectory') throw new Error('Unsupported task action');
  return { type: action, taskId };
}
