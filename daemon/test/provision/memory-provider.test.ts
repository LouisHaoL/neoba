import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  InvalidSpecError,
  InvalidStateError,
  MemoryProvider,
  NEOBA_MANAGED_LABEL,
  NEOBA_PROVIDER_LABEL,
  NotSupportedError,
  PrerequisiteNotMetError,
} from "../../src/provision/index.ts";
import type { SandboxMount, SandboxSpec } from "../../src/provision/index.ts";

const SPEC: SandboxSpec = {
  image: "neoba-base:latest",
  env: { CI: "1" },
  resources: { cpus: 1, memoryBytes: 268435456 },
  network: { mode: "none" as const },
  mounts: [{ kind: "workdir", source: "/t42/work", target: "/home/worker/work", mode: "rw" as const }],
  user: "worker",
  labels: { "neoba.task": "t42" },
};

describe("MemoryProvider(进程内假实现,语义对齐 DockerProvider)", () => {
  it("create:句柄 running,标签含 neoba.* 管理标签", async () => {
    const provider = new MemoryProvider({ now: () => new Date("2026-09-04T08:00:00Z") });
    const handle = await provider.create(SPEC);

    assert.equal(provider.backend, "memory");
    assert.ok(handle.id.startsWith("mem-"));
    assert.equal(handle.status, "running");
    assert.equal(handle.createdAt, "2026-09-04T08:00:00.000Z");
    assert.equal(handle.labels[NEOBA_MANAGED_LABEL], "true");
    assert.equal(handle.labels[NEOBA_PROVIDER_LABEL], "memory");
    assert.equal(handle.labels["neoba.task"], "t42");
  });

  it("exec:缺省 exit 0;自定义 handler 决定结果;调用被记录", async () => {
    const provider = new MemoryProvider({
      execHandler: (_h, cmd) =>
        cmd[0] === "fail" ? { exitCode: 7, stdout: "", stderr: "boom" } : { exitCode: 0, stdout: cmd.join(" "), stderr: "" },
    });
    const handle = await provider.create(SPEC);

    const ok = await provider.exec(handle, ["echo", "hi"]);
    assert.deepEqual(ok, { exitCode: 0, stdout: "echo hi", stderr: "" });

    const bad = await provider.exec(handle, ["fail"], { user: "worker" });
    assert.equal(bad.exitCode, 7);
    assert.equal(bad.stderr, "boom");

    assert.equal(provider.execCalls.length, 2);
    assert.deepEqual(provider.execCalls[0], { handleId: handle.id, cmd: ["echo", "hi"], opts: undefined });
    assert.deepEqual(provider.execCalls[1]!.cmd, ["fail"]);
    assert.equal(provider.execCalls[1]!.opts?.user, "worker");
  });

  it("logs:随 exec 累积,tail 取末尾 N 行", async () => {
    const provider = new MemoryProvider();
    const handle = await provider.create(SPEC);
    await provider.exec(handle, ["one"]);
    await provider.exec(handle, ["two"]);

    const all = await provider.logs(handle);
    assert.match(all, /one/);
    assert.match(all, /two/);
    assert.equal((await provider.logs(handle, { tail: 1 })).split("\n").length, 1);
    assert.match(await provider.logs(handle, { tail: 1 }), /two/);
  });

  it("destroy 幂等:重复 destroy 不抛错;destroy 后 exec/logs 报 InvalidStateError", async () => {
    const provider = new MemoryProvider();
    const handle = await provider.create(SPEC);
    await provider.destroy(handle);
    assert.equal(handle.status, "removed");
    await provider.destroy(handle); // 幂等,不抛
    assert.equal(handle.status, "removed");

    await assert.rejects(provider.exec(handle, ["ls"]), (err: unknown) => {
      assert.ok(err instanceof InvalidStateError);
      assert.equal(err.code, "invalid_state");
      return true;
    });
    await assert.rejects(provider.logs(handle), InvalidStateError);
  });

  it("list:按标签子集匹配,排除已销毁", async () => {
    const provider = new MemoryProvider();
    const h1 = await provider.create(SPEC);
    const h2 = await provider.create({ ...SPEC, labels: { "neoba.task": "t43" } });

    assert.equal((await provider.list()).length, 2);
    assert.deepEqual((await provider.list({ "neoba.task": "t42" })).map((h) => h.id), [h1.id]);

    await provider.destroy(h1);
    const rest = await provider.list();
    assert.equal(rest.length, 1);
    assert.equal(rest[0]!.id, h2.id);
  });

  it("snapshot/restore/acquire/release 抛 NotSupportedError", async () => {
    const provider = new MemoryProvider();
    const handle = await provider.create(SPEC);
    await assert.rejects(provider.snapshot(handle), NotSupportedError);
    await assert.rejects(provider.restore("snap-1"), (err: unknown) => {
      assert.ok(err instanceof NotSupportedError);
      assert.equal(err.code, "not_supported");
      return true;
    });
    await assert.rejects(provider.acquire("default"), NotSupportedError);
    await assert.rejects(provider.release("default"), NotSupportedError);
  });

  it("userns 前置:能力满足 → 通过;不满足/未声明 → PrerequisiteNotMetError", async () => {
    const capable = new MemoryProvider({ capabilities: { userns: true } });
    const h = await capable.create({
      ...SPEC,
      baseRequirements: { harness: "codex", userns: true, preinstalled: ["bubblewrap"] },
    });
    assert.equal(h.status, "running");

    const incapable = new MemoryProvider({ capabilities: { userns: false } });
    await assert.rejects(
      incapable.create({ ...SPEC, baseRequirements: { harness: "codex", userns: true } }),
      (err: unknown) => {
        assert.ok(err instanceof PrerequisiteNotMetError);
        assert.equal(err.code, "prerequisite_not_met");
        assert.match(err.message, /userns/);
        assert.match(err.message, /neoba doctor/);
        return true;
      },
    );

    const undeclared = new MemoryProvider();
    await assert.rejects(
      undeclared.create({ ...SPEC, baseRequirements: { harness: "codex", userns: true } }),
      PrerequisiteNotMetError,
    );
  });

  it("网络 allowlist:预留能力,create 报 NotSupportedError", async () => {
    const provider = new MemoryProvider();
    await assert.rejects(
      provider.create({
        ...SPEC,
        network: { mode: "allowlist", allow: ["registry.npmjs.org"] },
      }),
      NotSupportedError,
    );
  });

  it("secret/config 挂载 rw 被运行时强制拒绝(防 as 绕过类型)", async () => {
    const provider = new MemoryProvider();
    const badMounts = [
      { kind: "config", source: "/s/settings.json", target: "/home/worker/.claude/settings.json", mode: "rw" },
    ] as unknown as SandboxMount[];
    await assert.rejects(
      provider.create({ ...SPEC, mounts: badMounts }),
      (err: unknown) => {
        assert.ok(err instanceof InvalidSpecError);
        assert.equal(err.code, "invalid_spec");
        return true;
      },
    );
  });

  it("与 DockerProvider 共享同一 SandboxProvider 接口形状(字段 smoke)", async () => {
    const provider = new MemoryProvider();
    for (const member of ["create", "exec", "logs", "destroy", "list", "snapshot", "restore"] as const) {
      assert.equal(typeof provider[member], "function");
    }
  });
});
