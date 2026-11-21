import assert from 'node:assert/strict';

// Test consumers reconstruct the formerly flat projection without importing a
// renderer-side decoder. No production path reads a model prompt as input.
export function readInvocationPrompt(prompt) {
  const controllerMarker = '\n\nController Invocation (sectioned JSON):\n\n';
  const workerMarker = '\n\nInvocation (JSON):\n';
  if (!prompt.startsWith('Return exactly one JSON object')) {
    assert.ok(prompt.includes(workerMarker));
    return JSON.parse(prompt.slice(prompt.indexOf(workerMarker) + workerMarker.length));
  }
  const start = prompt.indexOf(controllerMarker);
  assert.notEqual(start, -1);
  const sections = prompt.slice(start + controllerMarker.length).split('\n\n## ');
  const first = sections.shift();
  assert.ok(first.startsWith('## Invocation identity\n'));
  const identity = JSON.parse(first.slice('## Invocation identity\n'.length));
  function read(label, json = true) {
    const value = sections.shift();
    assert.ok(value?.startsWith(label + '\n'), 'Missing section: ' + label);
    const body = value.slice(label.length + 1);
    return json ? JSON.parse(body) : body;
  }
  const task = read('Original objective and user constraints');
  const before = read('Role instructions before Decision reference');
  const reference = read('Decision v1 reference', false);
  const {instructions: after, ...skills} = read('Remaining role instructions and materialized skills');
  const context = read('Orchestration context and history (RO-managed Catalog is not native capability inventory)');
  if (sections.length) context.push(read('Active technical correction'));
  assert.equal(sections.length, 0);
  return {...identity, ...task, instructions: [...before, reference, ...after], ...skills, context};
}
