/**
 * env/conf 临时文件机制测试(issue #11):
 * - 内容格式:docker --env-file 逐行 K=V;msb --conf sparse 根配置 YAML env 映射;
 * - 键值安全校验:`=`/换行/`#` 前缀键与多行值显式拒绝(InvalidSpecError);
 * - 落盘:tmpdir 随机命名、独占创建、POSIX 0600、用后即删(幂等)。
 */
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import {
  InvalidSpecError,
  formatDockerEnvFile,
  formatMsbConfYaml,
  removeEnvFile,
  writeEnvFile,
} from "../../src/provision/index.ts";

describe("formatDockerEnvFile:docker --env-file 内容", () => {
  it("逐行 K=V,保持声明顺序", () => {
    assert.equal(
      formatDockerEnvFile({ CI: "1", NEBOBA_SECRET_TOKEN: "s3cr3t" }),
      "CI=1\nNEBOBA_SECRET_TOKEN=s3cr3t\n",
    );
  });

  it("值可含 =(docker 取首个 = 之后的全部为值)", () => {
    assert.equal(formatDockerEnvFile({ K: "a=b=c" }), "K=a=b=c\n");
  });

  it("键含 = / 换行 / # 前缀 → InvalidSpecError(逐行解析不安全)", () => {
    for (const key of ["A=B", "A\nB", "#A", ""]) {
      assert.throws(
        () => formatDockerEnvFile({ [key]: "v" }),
        (err: unknown) => {
          assert.ok(err instanceof InvalidSpecError);
          assert.equal(err.code, "invalid_spec");
          return true;
        },
      );
    }
  });

  it("值含换行 → InvalidSpecError(多行值先 base64,不静默截断)", () => {
    assert.throws(
      () => formatDockerEnvFile({ K: "line1\nline2" }),
      (err: unknown) => err instanceof InvalidSpecError,
    );
    assert.throws(
      () => formatDockerEnvFile({ K: "line1\rline2" }),
      (err: unknown) => err instanceof InvalidSpecError,
    );
  });
});

describe("formatMsbConfYaml:msb --conf(sparse 根配置)内容", () => {
  it("env: 映射,键值双引号标量,保持声明顺序", () => {
    assert.equal(
      formatMsbConfYaml({ NEBOBA_SECRET_TOKEN: "s3cr3t", FOO: "bar" }),
      `env:\n  "NEBOBA_SECRET_TOKEN": "s3cr3t"\n  "FOO": "bar"\n`,
    );
  });

  it("值含引号/反斜杠经 JSON 双引号转义(YAML 1.2 双引号标量为 JSON 超集)", () => {
    assert.equal(
      formatMsbConfYaml({ K: 'a"b\\c' }),
      `env:\n  "K": "a\\"b\\\\c"\n`,
    );
  });

  it("与 docker 同一套键值安全校验", () => {
    assert.throws(
      () => formatMsbConfYaml({ K: "line1\nline2" }),
      (err: unknown) => err instanceof InvalidSpecError,
    );
    assert.throws(
      () => formatMsbConfYaml({ "A=B": "v" }),
      (err: unknown) => err instanceof InvalidSpecError,
    );
  });
});

describe("writeEnvFile / removeEnvFile:落盘与用后即删", () => {
  it("写临时文件:tmpdir 下 neoba-env- 随机命名,内容一致,POSIX 0600", async () => {
    const path = await writeEnvFile("CI=1\n", ".env");
    try {
      assert.ok(path.startsWith(tmpdir()));
      assert.match(path, /neoba-env-[0-9a-f-]+\.env$/);
      assert.equal(existsSync(path), true);
      const stat = statSync(path);
      // Windows 忽略 mode 位(依赖 %TEMP% 用户 ACL),仅在 POSIX 断言
      if (process.platform !== "win32") {
        assert.equal(stat.mode & 0o777, 0o600);
      }
      const written = await import("node:fs/promises").then((m) => m.readFile(path, "utf8"));
      assert.equal(written, "CI=1\n");
    } finally {
      await removeEnvFile(path);
    }
    assert.equal(existsSync(path), false);
  });

  it("removeEnvFile 幂等:重复删除与不存在路径都不抛错", async () => {
    const path = await writeEnvFile("K=V\n", ".env");
    await removeEnvFile(path);
    await removeEnvFile(path);
    await removeEnvFile("/nonexistent/neoba-env-none.env");
    assert.equal(existsSync(path), false);
  });

  it("同名碰撞被 wx 独占创建规避:两次命名必然不同", async () => {
    const [a, b] = await Promise.all([
      writeEnvFile("A=1\n", ".env"),
      writeEnvFile("B=2\n", ".env"),
    ]);
    try {
      assert.notEqual(a, b);
    } finally {
      await removeEnvFile(a);
      await removeEnvFile(b);
    }
  });
});
