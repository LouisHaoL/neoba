// neoba 协议 schema 正例批量校验脚本(P0 冻结物自检)。
// 用法:node D:\workspace\neoba\protocol\examples\validate.mjs
// 约束:不新增依赖。ajv 经绝对路径取自 daemon 的 node_modules(参考实现自带),
//       本目录不建 package.json、不 npm install。
// 注:daemon 未装 ajv-formats,故 validateFormats:false,"format": "date-time"
//     仅作注解不做语法校验(其余 pattern/enum/const 约束全部生效)。
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const DAEMON_NODE_MODULES = "D:/workspace/neoba/daemon/node_modules";
const here = path.dirname(fileURLToPath(import.meta.url));
const schemaDir = path.resolve(here, "../schemas");

const require = createRequire(path.join(DAEMON_NODE_MODULES, "noop.js"));
// ajv 8 需显式引入 2020-12 draft 支持(自带 meta-schema,不装新包)
const Ajv = require("ajv/dist/2020");

const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true });

// 先注册 common(被其余 schema 以 $id 引用),再注册其余全部 schema。
for (const name of readdirSync(schemaDir)) {
  if (!name.endsWith(".schema.json")) continue;
  const schema = JSON.parse(readFileSync(path.join(schemaDir, name), "utf8"));
  ajv.addSchema(schema);
}

// 正例 → schema 映射(前缀匹配;顶层 oneOf 的 schema 由正例自身落到对应分支)。
const ROUTES = [
  ["handshake", "handshake.schema.json"],
  ["capability-registry", "capability-registry.schema.json"],
  ["preset", "preset.schema.json"],
  ["grant-manifest", "grant-manifest.schema.json"],
  ["tool-request", "grant-manifest.schema.json"],
  ["msg-", "messaging.schema.json"],
  ["intent", "intent.schema.json"],
  ["workflow", "workflow.schema.json"],
  ["runtime-", "runtime-api.schema.json"],
  ["event-", "runtime-api.schema.json"],
  ["artifact-manifest", "artifact-manifest.schema.json"],
  ["model-score", "model-score-registry.schema.json"],
];

let pass = 0;
let fail = 0;
for (const file of readdirSync(here).sort()) {
  if (!file.endsWith(".example.json")) continue;
  const route = ROUTES.find(([prefix]) => file.startsWith(prefix));
  if (!route) {
    console.error(`FAIL ${file}: 无对应 schema 路由`);
    fail++;
    continue;
  }
  const schemaId = `https://neoba.dev/schemas/${route[1]}`;
  const data = JSON.parse(readFileSync(path.join(here, file), "utf8"));
  const validate = ajv.getSchema(schemaId);
  if (validate(data)) {
    console.log(`PASS ${file} -> ${route[1]}`);
    pass++;
  } else {
    console.error(`FAIL ${file} -> ${route[1]}`);
    console.error("  " + ajv.errorsText(validate.errors, { separator: "\n  " }));
    fail++;
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
