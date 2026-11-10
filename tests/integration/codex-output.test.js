import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareCodexLaunch } from '../../src/adapters/cli/codex-launch.js';
import { createCodexOutputCapture, startCodexProcess } from '../../src/adapters/cli/codex-output.js';

const frame = event => Buffer.from(JSON.stringify(event) + '\n');
const diagnostic = (reason, firstLine, count = 1) => ({
  code: 'PROTOCOL_ERROR', stream: 'stdout', reason, count, firstLine,
});

test('JSONL framing survives every byte boundary including split UTF-8 and CRLF', () => {
  const thread = { type: 'thread.started', thread_id: 'thread-1' };
  const message = { type: 'item.completed', item: { type: 'agent_message', id: 'item_1', text: 'Привет 🧪' } };
  const bytes = Buffer.concat([Buffer.from(JSON.stringify(thread) + '\r\n'), frame(message)]);
  const warnings = Buffer.from('warning 🧪\n{"type":"error"}\n');
  const capture = createCodexOutputCapture();

  for (let i = 0; i < bytes.length; i++) {
    capture.write('stdout', bytes.subarray(i, i + 1));
    if (i < warnings.length) capture.write('stderr', warnings.subarray(i, i + 1));
  }

  const result = capture.finish();
  assert.deepEqual(result.frames, [{ line: 1, event: thread }, { line: 2, event: message }]);
  assert.deepEqual(result.stdout, { bytes, receivedBytes: bytes.length, truncated: false });
  assert.deepEqual(result.stderr, { bytes: warnings, receivedBytes: warnings.length, truncated: false });
  assert.deepEqual(result.diagnostics, []);
});

test('malformed frames are reported in bounded diagnostics and following events remain available', () => {
  const capture = createCodexOutputCapture();
  const invalidUtf8 = Buffer.concat([Buffer.from('{"type":"'), Buffer.from([0xff]), Buffer.from('"}\n')]);
  const valid = { type: 'future.event', payload: { id: 1 } };
  capture.write('stdout', Buffer.concat([
    invalidUtf8,
    Buffer.from('{invalid}\n[{"type":"x"}]\n{"type":7}\n{"type":"  "}\nnull\n{}\n\n'),
    frame(valid),
    Buffer.from('{"type":"unterminated"}'),
  ]));

  const result = capture.finish();
  assert.deepEqual(result.frames, [{ line: 9, event: valid }]);
  assert.deepEqual(result.diagnostics, [
    diagnostic('INVALID_UTF8', 1),
    diagnostic('INVALID_JSON', 2, 2),
    diagnostic('INVALID_ENVELOPE', 3, 5),
    diagnostic('INCOMPLETE_FRAME', 10),
  ]);
  assert.equal(result.stdout.bytes.includes(invalidUtf8), true);
});

test('oversized JSONL frames do not consume the next frame or masquerade as accepted events', () => {
  const before = { type: 'turn.started' };
  const atLimit = { type: 'item.completed', text: '🧪' };
  const overLimit = { ...atLimit, text: atLimit.text + '!' };
  const after = { type: 'turn.completed' };
  const beforeBytes = frame(before);
  const overBytes = frame(overLimit);
  const afterBytes = frame(after);
  const exactBytes = frame(atLimit);
  const bytes = Buffer.concat([beforeBytes, exactBytes, overBytes, afterBytes]);
  const capture = createCodexOutputCapture({ maxFrameBytes: exactBytes.length - 1, maxStdoutBytes: 512, maxStderrBytes: 64 });

  const split = beforeBytes.length + exactBytes.length + overBytes.length - 1;
  capture.write('stdout', bytes.subarray(0, split));
  capture.write('stdout', bytes.subarray(split));

  const result = capture.finish();
  assert.deepEqual(result.frames, [{ line: 1, event: before }, { line: 2, event: atLimit }, { line: 4, event: after }]);
  assert.deepEqual(result.diagnostics, [diagnostic('FRAME_LIMIT', 3)]);
  assert.deepEqual(result.stdout.bytes, bytes);
});

test('stdout exhaustion retains the raw prefix but cannot admit a JSON prefix without its delimiter', () => {
  const first = { type: 'thread.started', thread_id: 'thread-1' };
  const clipped = { type: 'turn.completed' };
  const firstBytes = frame(first);
  const clippedBytes = frame(clipped);
  const maxStdoutBytes = firstBytes.length + clippedBytes.length - 1;
  const capture = createCodexOutputCapture({ maxFrameBytes: 128, maxStdoutBytes, maxStderrBytes: 3 });
  const bytes = Buffer.concat([firstBytes, clippedBytes]);
  capture.write('stdout', bytes.subarray(0, maxStdoutBytes));
  capture.write('stdout', bytes.subarray(maxStdoutBytes));
  capture.write('stderr', Buffer.from('éé\n'));
  capture.write('stdout', Buffer.from('more'));

  const result = capture.finish();
  assert.deepEqual(result.frames, [{ line: 1, event: first }]);
  assert.deepEqual(result.stdout, { bytes: bytes.subarray(0, maxStdoutBytes), receivedBytes: bytes.length + 4, truncated: true });
  assert.deepEqual(result.stderr, { bytes: Buffer.from('éé\n').subarray(0, 3), receivedBytes: 5, truncated: true });
  assert.deepEqual(result.diagnostics, [
    diagnostic('STDOUT_LIMIT', 2),
    { code: 'OUTPUT_TRUNCATED', stream: 'stderr', reason: 'STDERR_LIMIT', count: 1 },
  ]);
});

test('exact stream budgets do not mark complete frames or stderr as truncated', () => {
  const event = { type: 'turn.completed' };
  const bytes = frame(event);
  const capture = createCodexOutputCapture({ maxFrameBytes: bytes.length - 1, maxStdoutBytes: bytes.length, maxStderrBytes: 3 });
  capture.write('stdout', bytes);
  capture.write('stderr', Buffer.from('err'));
  const result = capture.finish();
  assert.deepEqual(result.frames, [{ line: 1, event }]);
  assert.equal(result.stdout.truncated, false);
  assert.equal(result.stderr.truncated, false);
  assert.deepEqual(result.diagnostics, []);
});

test('the process adapter preserves JSONL events, partial output and the independent exit status', {
  skip: process.platform !== 'linux',
  timeout: 10_000,
}, async () => {
  const event = { type: 'item.completed', item: { type: 'agent_message', id: 'm1', text: 'ошибка 🧪' } };
  const bytes = frame(event);
  const split = bytes.indexOf(Buffer.from('🧪')) + 1;
  const launch = prepareCodexLaunch({
    adapter: 'codex-cli',
    launch: { command: process.execPath, args: ['-e', `
      const bytes = Buffer.from('${bytes.toString('base64')}', 'base64');
      process.stdout.write(bytes.subarray(0, ${split}));
      process.stderr.write(${JSON.stringify('native diagnostic\n')});
      setImmediate(() => {
        process.stdout.write(bytes.subarray(${split}));
        process.stdout.write('{"type":');
        process.exitCode = 6;
      });
    `, '--'] },
  }, { model: 'configured-model', prompt: '' }, process.env);
  const owned = startCodexProcess(launch, { timeoutMs: 3_000, signal: new AbortController().signal });
  const result = await owned.finished;
  assert.deepEqual(result.frames, [{ line: 1, event }]);
  assert.equal(result.process.exitCode, 6);
  assert.equal(result.stdout.bytes.toString(), bytes.toString() + '{"type":');
  assert.equal(result.stderr.bytes.toString(), 'native diagnostic\n');
  assert.deepEqual(result.diagnostics, [diagnostic('INCOMPLETE_FRAME', 2)]);
  assert.equal(await owned.close(), result);
});
