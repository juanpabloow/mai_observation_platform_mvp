import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { parseWorkflowRef } from '../../src/scheduling/workflowRef.js';

/** Pure X-Workflow-Ref parsing (the header n8n sends as `{{$workflow.id}}`). */

test('trims and returns a non-empty ref', () => {
  assert.equal(parseWorkflowRef('wf_123'), 'wf_123');
  assert.equal(parseWorkflowRef('  wf_123  '), 'wf_123');
});

test('missing / blank → null (maps to workflow_ref_required)', () => {
  assert.equal(parseWorkflowRef(null), null);
  assert.equal(parseWorkflowRef(undefined), null);
  assert.equal(parseWorkflowRef(''), null);
  assert.equal(parseWorkflowRef('   '), null);
  assert.equal(parseWorkflowRef('\t\n'), null);
});
