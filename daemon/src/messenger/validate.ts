/**
 * validateMsg 纯函数(§3.4):校验消息符合 messaging.schema.json 语义。
 * 校验失败抛 InvalidMsg,field 带违规字段名。
 *
 * 宽严口径:
 * - schema 已知字段从严(protocol 冻结 "1.0"、spec_version 正则、to/agent_id 正则、
 *   priority 枚举、feedback 的 kind/ref/body/traversal);
 * - 未知顶层键从宽忽略(§3.0 规则 1:接收方忽略未知字段;daemon 自身要盖
 *   id/ts/seq/from 超集章,若按 additionalProperties:false 从严会把自盖章拒掉)。
 */
import { InvalidMsg } from './errors.ts';
import {
  FEEDBACK_KINDS,
  MSG_TYPES,
  PRIORITIES,
  PROTOCOL_VERSION,
  type MsgInput,
  type Priority,
} from './types.ts';

/** RFC3339 UTC,必须以 Z 结尾(参照 common.schema.json $defs/timestamp 的 pattern)。 */
export const RFC3339_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** agent id:<task>/<实例名>,如 task-42/e2e-tester-01($defs/agent_id)。 */
export const AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** 结构体规格版本:^\d+\.\d+(\.\d+)?$($defs/spec_version)。 */
export const SPEC_VERSION_RE = /^\d+\.\d+(\.\d+)?$/;

/** 工件引用:artifact:<工件名>,如 artifact:test_report($defs/artifact_ref)。 */
export const ARTIFACT_REF_RE = /^artifact:[a-z][a-z0-9_-]*$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(field: string, detail: string): never {
  throw new InvalidMsg(field, detail);
}

function requireString(obj: Record<string, unknown>, field: string, what: string): string {
  const v = obj[field];
  if (typeof v !== 'string') return fail(field, `必须是字符串(${what}),实际 ${v === null ? 'null' : typeof v}`);
  return v;
}

/** 自写 RFC3339 UTC 断言:合法返回原串,非法抛 InvalidMsg(参照 schema pattern)。 */
export function assertRfc3339Utc(value: unknown, field: string): string {
  if (typeof value !== 'string' || !RFC3339_UTC_RE.test(value)) {
    return fail(field, '必须是 RFC3339 UTC 时间戳(YYYY-MM-DDTHH:MM:SS[.fff]Z)');
  }
  return value;
}

export function isRfc3339Utc(value: unknown): value is string {
  return typeof value === 'string' && RFC3339_UTC_RE.test(value);
}

/** 当前时间的 RFC3339 UTC 形态(供 Messenger 盖 ts 章;now 可注入)。 */
export function nowRfc3339(now: () => Date = () => new Date()): string {
  return now().toISOString();
}

/**
 * 校验并收窄消息。返回 MsgInput(三型联合);失败抛 InvalidMsg(field 带字段名)。
 * 纯函数:不修改入参、不触碰任何模块状态。
 */
export function validateMsg(raw: unknown): MsgInput {
  if (!isPlainObject(raw)) return fail('(root)', '消息必须是 JSON 对象');

  const protocol = requireString(raw, 'protocol', '冻结为 "1.0"');
  if (protocol !== PROTOCOL_VERSION) {
    fail('protocol', `必须为 "${PROTOCOL_VERSION}",实际 "${protocol}"`);
  }

  const specVersion = requireString(raw, 'spec_version', 'semver 形如 1.0 / 1.0.2');
  if (!SPEC_VERSION_RE.test(specVersion)) {
    fail('spec_version', `必须匹配 \\d+\\.\\d+(\\.\\d+)?,实际 "${specVersion}"`);
  }

  const type = requireString(raw, 'type', 'msg.direct | msg.broadcast | msg.feedback');
  if (!(MSG_TYPES as readonly string[]).includes(type)) {
    fail('type', `必须是 ${MSG_TYPES.join(' | ')},实际 "${type}"`);
  }

  // 可选超集章:若调用方已带 id/ts,先行校验格式(Messenger 盖章时必然合法)。
  if (raw['id'] !== undefined && (typeof raw['id'] !== 'string' || raw['id'].length === 0)) {
    fail('id', '必须是非空字符串(uuid)');
  }
  if (raw['ts'] !== undefined) assertRfc3339Utc(raw['ts'], 'ts');
  if (raw['priority'] !== undefined && !(PRIORITIES as readonly string[]).includes(raw['priority'] as string)) {
    fail('priority', `必须是 ${PRIORITIES.join(' | ')},实际 "${String(raw['priority'])}"`);
  }

  switch (type) {
    case 'msg.direct':
      return validateDirect(raw);
    case 'msg.broadcast':
      return validateBroadcast(raw);
    case 'msg.feedback':
      return validateFeedback(raw);
    default:
      return fail('type', `必须是 ${MSG_TYPES.join(' | ')},实际 "${type}"`);
  }
}

function validateDirect(raw: Record<string, unknown>): MsgInput {
  const to = requireString(raw, 'to', '<task>/<实例名>');
  if (!AGENT_ID_RE.test(to)) fail('to', `必须匹配 <task>/<实例名> 格式,实际 "${to}"`);
  if (!isPlainObject(raw['body'])) fail('body', '必须是对象(direct/broadcast 的 body 是结构开放的对象)');
  return {
    protocol: PROTOCOL_VERSION,
    spec_version: raw['spec_version'] as string,
    type: 'msg.direct',
    to,
    body: raw['body'] as Record<string, unknown>,
    ...(raw['priority'] !== undefined ? { priority: raw['priority'] as Priority } : {}),
  };
}

function validateBroadcast(raw: Record<string, unknown>): MsgInput {
  const topic = requireString(raw, 'topic', '广播主题,如 deps-changed');
  if (topic.length === 0) fail('topic', '必须是非空字符串');
  if (!isPlainObject(raw['body'])) fail('body', '必须是对象(direct/broadcast 的 body 是结构开放的对象)');
  return {
    protocol: PROTOCOL_VERSION,
    spec_version: raw['spec_version'] as string,
    type: 'msg.broadcast',
    topic,
    body: raw['body'] as Record<string, unknown>,
    ...(raw['priority'] !== undefined ? { priority: raw['priority'] as Priority } : {}),
  };
}

function validateFeedback(raw: Record<string, unknown>): MsgInput {
  const to = requireString(raw, 'to', '<task>/<实例名>');
  if (!AGENT_ID_RE.test(to)) fail('to', `必须匹配 <task>/<实例名> 格式,实际 "${to}"`);

  const kind = requireString(raw, 'kind', 'correction | question | ack');
  if (!(FEEDBACK_KINDS as readonly string[]).includes(kind)) {
    fail('kind', `必须是 ${FEEDBACK_KINDS.join(' | ')},实际 "${kind}"`);
  }

  const ref = requireString(raw, 'ref', 'artifact:<工件名>');
  if (!ARTIFACT_REF_RE.test(ref)) fail('ref', `必须匹配 artifact:<工件名>,实际 "${ref}"`);

  const body = requireString(raw, 'body', 'feedback 正文是非空字符串');
  if (body.length === 0) fail('body', '必须是非空字符串(feedback 的 body 与 direct/broadcast 不同,是字符串)');

  const traversal = raw['traversal'];
  if (typeof traversal !== 'number' || !Number.isInteger(traversal) || traversal < 0) {
    fail('traversal', '必须是非负整数');
  }

  return {
    protocol: PROTOCOL_VERSION,
    spec_version: raw['spec_version'] as string,
    type: 'msg.feedback',
    to,
    kind: kind as (typeof FEEDBACK_KINDS)[number],
    ref,
    body,
    traversal,
    ...(raw['priority'] !== undefined ? { priority: raw['priority'] as Priority } : {}),
  };
}
