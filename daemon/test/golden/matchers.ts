/**
 * golden 场景断言匹配器(纯函数,零依赖)。
 *
 * 期望值是"部分匹配规范":
 *   - 对象:子集匹配(期望中出现的键必须逐一匹配,实际可有额外字段 ——
 *     对应 §3.0 规则 1 "接收方必须忽略未知字段",golden 断言不依赖
 *     实现无关字段);
 *   - 数组:按位且等长(顺序敏感);
 *   - {"$contains": [spec, ...]}:实际数组必须无序包含逐一匹配 spec 的
 *     不重复元素,额外元素允许(对顺序无关的集合断言,如 task.list);
 *   - {"$regex": "..."}:实际字符串须匹配正则(动态 id 形状断言);
 *   - 标量:严格相等;
 *   - 字符串中的 "${VAR}" 引用此前步骤 capture 的变量。
 *
 * 事件序列断言(matchEventSequence):
 *   - subsequence(缺省):期望事件按序出现在实际事件流中,允许其间夹
 *     实现无关事件(如 node.started/node.completed 的编排噪声);
 *   - exact:逐条按位且等长。
 *   任何失败都产出可读 diff(期望序列 vs 实际序列,含逐条匹配标注)。
 */

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 期望值中的操作符对象(单键 $regex / $contains 才算操作符)。 */
function asOperator(value: unknown): { op: '$regex' | '$contains'; arg: unknown } | null {
  if (!isPlainObject(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 1) return null;
  const key = keys[0];
  if (key === '$regex' || key === '$contains') return { op: key, arg: value[key] };
  return null;
}

const VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * 深度替换字符串中的 ${VAR} 引用:整串恰为一个引用时替换为捕获值原样
 * (可为任意 JSON 值),否则按字符串拼接。引用未捕获的变量 = 场景 bug,抛错。
 */
export function substitute(value: unknown, captures: ReadonlyMap<string, unknown>): unknown {
  if (typeof value === 'string') {
    const exact = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value);
    if (exact !== null) {
      const name = exact[1];
      if (name === undefined || !captures.has(name)) {
        throw new Error(`场景引用了未捕获的变量 ${value}(检查此前步骤的 capture)`);
      }
      return captures.get(name);
    }
    return value.replace(VAR_RE, (whole: string, name: string): string => {
      if (!captures.has(name)) throw new Error(`场景引用了未捕获的变量 ${whole}`);
      return String(captures.get(name));
    });
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, captures));
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = substitute(v, captures);
    return out;
  }
  return value;
}

function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * 收集 expected 相对 actual 的部分匹配差异到 out(空数组 = 匹配)。
 * 路径前缀 path 用于 diff 可读性(如 "result.manifest.grants[0].cap")。
 */
export function collectSubsetMismatches(
  expected: unknown,
  actual: unknown,
  path: string,
  out: string[],
): void {
  const op = asOperator(expected);
  if (op !== null) {
    if (op.op === '$regex') {
      const ok =
        typeof actual === 'string' &&
        typeof op.arg === 'string' &&
        new RegExp(op.arg).test(actual);
      if (!ok) {
        out.push(`${path}: 期望匹配 /${String(op.arg)}/,实际 ${JSON.stringify(actual)}`);
      }
      return;
    }
    // $contains:无序包含,元素不重复消费
    if (!Array.isArray(actual)) {
      out.push(`${path}: $contains 期望实际为数组,实际 ${typeName(actual)}`);
      return;
    }
    if (!Array.isArray(op.arg)) {
      out.push(`${path}: $contains 的期望值必须是数组(场景 bug)`);
      return;
    }
    const remaining = [...actual];
    op.arg.forEach((item, i) => {
      const idx = remaining.findIndex((cand) => {
        const probe: string[] = [];
        collectSubsetMismatches(item, cand, '', probe);
        return probe.length === 0;
      });
      if (idx === -1) {
        out.push(
          `${path}: $contains 第 ${i} 项 ${JSON.stringify(item)} 在实际数组(${actual.length} 项)中无匹配`,
        );
      } else {
        remaining.splice(idx, 1);
      }
    });
    return;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      out.push(`${path}: 期望数组,实际 ${typeName(actual)}`);
      return;
    }
    if (expected.length !== actual.length) {
      out.push(`${path}: 数组长度期望 ${expected.length},实际 ${actual.length}`);
    }
    const n = Math.min(expected.length, actual.length);
    for (let i = 0; i < n; i++) {
      collectSubsetMismatches(expected[i], actual[i], `${path}[${i}]`, out);
    }
    return;
  }
  if (isPlainObject(expected)) {
    if (!isPlainObject(actual)) {
      out.push(`${path}: 期望对象,实际 ${typeName(actual)} ${clip(JSON.stringify(actual))}`);
      return;
    }
    for (const [k, v] of Object.entries(expected)) {
      if (!(k in actual)) {
        out.push(`${path}.${k}: 期望存在,实际缺失`);
        continue;
      }
      collectSubsetMismatches(v, actual[k], `${path}.${k}`, out);
    }
    return;
  }
  if (expected !== actual) {
    out.push(`${path}: 期望 ${JSON.stringify(expected)},实际 ${JSON.stringify(actual)}`);
  }
}

/** 超长文本截断(diff 可读性)。 */
export function clip(text: string, max = 200): string {
  return text.length <= max ? text : `${text.slice(0, max)}…(截断,共 ${text.length} 字符)`;
}

// ---------------------------------------------------------------- 事件序列

/** golden 执行器观察到的事件(结构性子集,EventLog Event 的超集兼容形)。 */
export interface EventLike {
  readonly seq: number;
  readonly ts: string;
  readonly type: string;
  readonly principal: Record<string, unknown>;
  readonly payload: Record<string, unknown>;
}

export interface EventExpectation {
  readonly type: string;
  readonly payload?: unknown;
  readonly principal?: unknown;
}

export type EventMatchMode = 'subsequence' | 'exact' | 'set';

function renderExpected(ev: EventExpectation): string {
  let text = ev.type;
  if (ev.payload !== undefined) text += ` payload=${clip(JSON.stringify(ev.payload))}`;
  if (ev.principal !== undefined) text += ` principal=${clip(JSON.stringify(ev.principal))}`;
  return text;
}

function renderActual(ev: EventLike): string {
  let text = `#${ev.seq} ${ev.type}`;
  text += ` principal=${clip(JSON.stringify(ev.principal))}`;
  text += ` payload=${clip(JSON.stringify(ev.payload))}`;
  return text;
}

function eventMatches(want: EventExpectation, actual: EventLike): boolean {
  if (want.type !== actual.type) return false;
  const errors: string[] = [];
  if (want.payload !== undefined) {
    collectSubsetMismatches(want.payload, actual.payload, 'payload', errors);
  }
  if (want.principal !== undefined) {
    collectSubsetMismatches(want.principal, actual.principal, 'principal', errors);
  }
  return errors.length === 0;
}

export interface SequenceMatchResult {
  readonly ok: boolean;
  /** 失败时的可读 diff(期望序列 vs 实际序列,含逐条匹配标注);成功为空串。 */
  readonly report: string;
}

/**
 * 事件序列断言。subsequence:期望按序出现在实际事件流中(其间允许实现无关
 * 事件);exact:等长且逐位匹配;set:无序多重集包含(顺序不确定的并行编排)。
 * 失败报告列出期望/实际两侧与逐条匹配情况。
 */
export function matchEventSequence(
  expected: readonly EventExpectation[],
  actual: readonly EventLike[],
  mode: EventMatchMode,
): SequenceMatchResult {
  const problems: string[] = [];
  const actualHit: (number | null)[] = actual.map(() => null);

  if (mode === 'set') {
    // 无序多重集包含:每条期望事件独立在实际事件(未被前面期望消费的)中找匹配。
    const consumed = actual.map(() => false);
    expected.forEach((want, i) => {
      const found = actual.findIndex((cand, j) => !consumed[j] && cand !== undefined && eventMatches(want, cand));
      if (found >= 0) {
        consumed[found] = true;
        actualHit[found] = i;
      } else {
        problems.push(`set:期望 [${i}] ${renderExpected(want)} 在实际事件中无匹配(或匹配项已被先行期望消费)`);
      }
    });
  } else if (mode === 'exact') {
    if (expected.length !== actual.length) {
      problems.push(`exact 模式:期望 ${expected.length} 条,实际 ${actual.length} 条`);
    }
    const n = Math.min(expected.length, actual.length);
    for (let i = 0; i < n; i++) {
      const want = expected[i];
      const got = actual[i];
      if (want === undefined || got === undefined) break;
      if (eventMatches(want, got)) {
        actualHit[i] = i;
      } else {
        problems.push(`exact [${i}] 不匹配:\n    期望 ${renderExpected(want)}\n    实际 ${renderActual(got)}`);
      }
    }
  } else {
    let cursor = 0;
    expected.forEach((want, i) => {
      let found = -1;
      for (let j = cursor; j < actual.length; j++) {
        const cand = actual[j];
        if (cand !== undefined && eventMatches(want, cand)) {
          found = j;
          break;
        }
      }
      if (found >= 0) {
        cursor = found + 1;
        actualHit[found] = i;
      } else {
        problems.push(
          `subsequence:期望 [${i}] ${renderExpected(want)} 在剩余实际事件(自 #${cursor + 1} 起)中无匹配`,
        );
      }
    });
  }

  const lines: string[] = [];
  lines.push(`事件序列断言失败(${mode}模式)`);
  lines.push(`期望序列(${expected.length} 条):`);
  expected.forEach((ev, i) => {
    lines.push(`  [${i}] ${renderExpected(ev)}`);
  });
  lines.push(`实际序列(过滤后 ${actual.length} 条,← 标注被期望项匹配):`);
  actual.forEach((ev, i) => {
    const hit = actualHit[i];
    const note = hit === null ? '  (期望序列未引用,忽略)' : `  ← 匹配期望 [${hit}]`;
    lines.push(`  ${renderActual(ev)}${note}`);
  });
  lines.push('差异:');
  for (const p of problems) lines.push(`  - ${p}`);
  return { ok: problems.length === 0, report: lines.join('\n') };
}
