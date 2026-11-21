/**
 * Mapping an ACP form elicitation onto the form the opencode TUI renders.
 *
 * The mapping is the whole contract of the elicitation path: the agent declares a
 * flat JSON Schema, we publish a `Form.Info` (verified against
 * `packages/schema/src/form.ts` in the opencode checkout), and whatever the TUI
 * hands back becomes the `content` of an `accept`.
 *
 * The refusals matter as much as the successes. A field we cannot render means the
 * answer would silently not match the agent's schema, and the agent has no way to
 * tell that from a good answer — so it must be an explicit error instead.
 */
import { describe, expect, it } from 'vitest';

import { formFromElicitation } from '../src/server.js';
import type { ElicitationRequest } from '../src/acp/types.js';

const form = (
  properties: Record<string, unknown>,
  extra: { required?: string[]; message?: string; toolCallId?: string } = {},
): ElicitationRequest => ({
  sessionId: 'ses_1',
  mode: 'form',
  message: extra.message ?? 'Which one?',
  requestedSchema: {
    type: 'object',
    properties,
    ...(extra.required ? { required: extra.required } : {}),
  },
  ...(extra.toolCallId ? { toolCallId: extra.toolCallId } : {}),
});

describe('formFromElicitation', () => {
  it('carries the agent message as the form title', () => {
    const mapped = formFromElicitation('ses_1', 'frm_1', form({ a: { type: 'string' } }));
    expect(mapped.id).toBe('frm_1');
    expect(mapped.sessionID).toBe('ses_1');
    expect(mapped.title).toBe('Which one?');
    expect(mapped.fields).toHaveLength(1);
  });

  it('drops the synthetic free-form "other" field opencode question adds', () => {
    // opencode's question tool marks every field custom:true; for a free-form
    // question the form service then adds `q0_custom` with the same label plus
    // "(other)". The TUI showed both as tabs; the base field is already a text
    // input, and the tool only reads q0. Reported 2026-10-20 (valuation 配置刷新方式).
    const mapped = formFromElicitation(
      'ses_1',
      'frm_1',
      form({
        q0: { type: 'string', title: 'valuation 配置刷新方式', description: '你们平时怎么触发？' },
        q0_custom: {
          type: 'string',
          title: 'valuation 配置刷新方式 (other)',
          description: 'Type your own answer',
        },
      }),
    );
    expect(mapped.fields.map((field) => field.key)).toEqual(['q0']);
  });

  it('keeps a required synthetic "other" field: dropping it would break the schema', () => {
    const mapped = formFromElicitation(
      'ses_1',
      'frm_1',
      form(
        {
          q0: { type: 'string', title: 'how' },
          q0_custom: { type: 'string', title: 'how (other)', description: 'Type your own answer' },
        },
        { required: ['q0_custom'] },
      ),
    );
    expect(mapped.fields.map((field) => field.key)).toEqual(['q0', 'q0_custom']);
  });

  it('keeps a real "other" field when the base question has options', () => {
    const mapped = formFromElicitation(
      'ses_1',
      'frm_1',
      form({
        q0: { type: 'string', title: 'how', enum: ['a', 'b'] },
        q0_custom: { type: 'string', title: 'how (other)', description: 'Type your own answer' },
      }),
    );
    expect(mapped.fields.map((field) => field.key)).toEqual(['q0', 'q0_custom']);
  });

  it('falls back to a non-empty title, which Form.Info requires', () => {
    const mapped = formFromElicitation('ses_1', 'frm_1', form({ a: { type: 'string' } }, { message: '   ' }));
    expect(mapped.title).toBe('Input requested');
  });

  it('turns a string enum into options, labelled by value', () => {
    const mapped = formFromElicitation(
      'ses_1',
      'frm_1',
      form({ strategy: { type: 'string', enum: ['a', 'b'] } }),
    );
    expect(mapped.fields[0]).toMatchObject({
      key: 'strategy',
      type: 'string',
      options: [{ value: 'a', label: 'a' }, { value: 'b', label: 'b' }],
    });
  });

  it('carries the constraints a select or text input can enforce', () => {
    const mapped = formFromElicitation(
      'ses_1',
      'frm_1',
      form({
        email: { type: 'string', format: 'email', minLength: 3, maxLength: 40, pattern: '@', default: 'a@b' },
        age: { type: 'integer', minimum: 0, maximum: 120, default: 7 },
        score: { type: 'number', minimum: 0.5 },
        brave: { type: 'boolean', default: true },
      }),
    );
    const byKey = Object.fromEntries(mapped.fields.map((field) => [field.key, field]));
    expect(byKey.email).toMatchObject({ type: 'string', format: 'email', minLength: 3, maxLength: 40, pattern: '@', default: 'a@b' });
    expect(byKey.age).toMatchObject({ type: 'integer', minimum: 0, maximum: 120, default: 7 });
    expect(byKey.score).toMatchObject({ type: 'number', minimum: 0.5 });
    expect(byKey.brave).toMatchObject({ type: 'boolean', default: true });
  });

  it('maps an array of enums onto the TUI multiselect field', () => {
    const mapped = formFromElicitation(
      'ses_1',
      'frm_1',
      form({
        extras: { type: 'array', items: { type: 'string', enum: ['fast', 'safe'] }, minItems: 1, default: ['fast'] },
      }),
    );
    expect(mapped.fields[0]).toMatchObject({
      key: 'extras',
      type: 'multiselect',
      options: [{ value: 'fast', label: 'fast' }, { value: 'safe', label: 'safe' }],
      minItems: 1,
      default: ['fast'],
    });
  });

  it('marks fields the schema requires', () => {
    const mapped = formFromElicitation(
      'ses_1',
      'frm_1',
      form({ a: { type: 'string' }, b: { type: 'string' } }, { required: ['a'] }),
    );
    const byKey = Object.fromEntries(mapped.fields.map((field) => [field.key, field.required]));
    expect(byKey).toEqual({ a: true, b: false });
  });

  it('keeps title and description when the agent supplies them', () => {
    const mapped = formFromElicitation(
      'ses_1',
      'frm_1',
      form({ a: { type: 'string', title: 'Your name', description: 'As it should appear' } }),
    );
    expect(mapped.fields[0]).toMatchObject({ title: 'Your name', description: 'As it should appear' });
  });

  it('records the tool call an elicitation belongs to', () => {
    const mapped = formFromElicitation(
      'ses_1',
      'frm_1',
      form({ a: { type: 'string' } }, { toolCallId: 'call-7' }),
    );
    expect(mapped.metadata).toEqual({ toolCallId: 'call-7' });
  });

  it('refuses a schema it cannot render completely, rather than showing part of it', () => {
    // An object field has no representation in the TUI's field union; answering
    // with a form missing it would collect a non-conforming answer.
    expect(() =>
      formFromElicitation('ses_1', 'frm_1', form({ nested: { type: 'object', properties: {} } })),
    ).toThrowError(/unsupported elicitation field "nested"/);
  });

  it('refuses an array whose items are not a string enum', () => {
    expect(() =>
      formFromElicitation('ses_1', 'frm_1', form({ list: { type: 'array', items: { type: 'number' } } })),
    ).toThrowError(/unsupported elicitation field "list"/);
  });

  it('refuses a request with no schema, and one with no fields', () => {
    expect(() => formFromElicitation('ses_1', 'frm_1', { sessionId: 'ses_1', mode: 'form' })).toThrowError(
      /requestedSchema/,
    );
    expect(() => formFromElicitation('ses_1', 'frm_1', form({}))).toThrowError(/no fields|no properties/);
  });

  it('carries the -32602 code the agent is owed for an unrenderable schema', () => {
    try {
      formFromElicitation('ses_1', 'frm_1', form({ nested: { type: 'object' } }));
      throw new Error('expected a refusal');
    } catch (err) {
      expect((err as { code?: number }).code).toBe(-32602);
    }
  });
});
