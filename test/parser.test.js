// Test the YAML sheet parser
import { test } from 'node:test';
import assert from 'node:assert';
import { parseSheet } from '../src/worker.js';

test('parses a simple value cell', () => {
  const yaml = `id: test
cells:
  - id: greeting
    kind: value
    value: "Hello"
  - id: target
    kind: value
    value: "world"
  - id: message
    kind: formula
    expr: "greeting + ' ' + target"`;
  const sheet = parseSheet(yaml);
  assert.equal(sheet.cells.length, 3);
  assert.equal(sheet.cells[0].id, 'greeting');
  assert.equal(sheet.cells[0].kind, 'value');
  assert.equal(sheet.cells[0].value, 'Hello');
  assert.equal(sheet.cells[2].config.expr, "greeting + ' ' + target");
  // Edges should include greeting→message and target→message
  assert.ok(sheet.edges.some(([f, t]) => f === 'greeting' && t === 'message'));
  assert.ok(sheet.edges.some(([f, t]) => f === 'target' && t === 'message'));
});

test('parses a multi-line program cell', () => {
  const yaml = `id: test
cells:
  - id: greet
    kind: program
    code: |
      return "hello";
  - id: target
    kind: program
    code: |-
      const x = 1;
      return x + 2;`;
  const sheet = parseSheet(yaml);
  assert.equal(sheet.cells.length, 2);
  assert.equal(sheet.cells[0].config.code, 'return "hello";');
  assert.ok(sheet.cells[1].config.code.includes('const x = 1'));
  assert.ok(sheet.cells[1].config.code.includes('return x + 2'));
});

test('parses an AI cell', () => {
  const yaml = `id: test
cells:
  - id: input
    kind: value
    value: "What is Quilt?"
  - id: explanation
    kind: ai.llm
    model: "@cf/meta/llama-3-8b-instruct"
    prompt: "Explain: " + input`;
  const sheet = parseSheet(yaml);
  assert.equal(sheet.cells[1].kind, 'ai.llm');
  assert.equal(sheet.cells[1].config.model, '@cf/meta/llama-3-8b-instruct');
  assert.equal(sheet.cells[1].config.prompt, 'Explain: ' + 'input');
});

test('parses a listener with watch and condition', () => {
  const yaml = `id: test
cells:
  - id: temp
    kind: value
    value: 22
  - id: alert
    kind: listener
    watch: temp
    condition: "temp > 30"
    action: "console.log('hot')"`;
  const sheet = parseSheet(yaml);
  assert.equal(sheet.cells[1].kind, 'listener');
  assert.equal(sheet.cells[1].config.watch, 'temp');
  assert.ok(sheet.edges.some(([f, t]) => f === 'temp' && t === 'alert'));
});

test('parses a router with multiple routes', () => {
  const yaml = `id: test
cells:
  - id: data.public
    kind: router
    routes:
      - when: "caller.role === 'admin'"
        expr: "all"
      - when: "caller.role === 'user'"
        expr: "filtered"`;
  const sheet = parseSheet(yaml);
  assert.equal(sheet.cells[0].kind, 'router');
  assert.equal(sheet.cells[0].config.routes?.length, 2);
});
