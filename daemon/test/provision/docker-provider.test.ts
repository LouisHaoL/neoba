import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CommandFailedError,
  DockerProvider,
  InvalidSpecError,
  InvalidStateError,
  NEOBA_MANAGED_LABEL,
  NotSupportedError,
  PrerequisiteNotMetError,
  ProviderUnavailableError,
} from "../../src/provision/index.ts";
import type { CliResult, CliRunner, SandboxMount, SandboxSpec } from "../../src/provision/index.ts";

/** 假 runner:记录全部调用,按脚本返回结果。绝不触达真实 docker daemon。 */
interface FakeRunner {
  calls: string[][];
  runner: CliRunner;
}

function fakeRunner(script?: (args: string[]) => CliResult): FakeRunner {
  const calls: string[][] = [];
  return {
    calls,
    runner: async (args) => {
      calls.push(args);
      return script ? script(args) : { code: 0, stdout: "", stderr: "" };
    },
  };
}

function makeProvider(script?: (args: string[]) => CliResult, usernsProbe?: () => boolean) {
  const fake = fakeRunner(script);
  const provider = new DockerProvider({ runner: fake.runner, usernsProbe });
  return { provider, ...fake };
}

const SPEC: SandboxSpec = {
  image: "neoba-base:latest",
  command: ["sleep", "infinity"],
  env: { CI: "1" },
  resources: { cpus: 2, memoryBytes: 536870912 },
  network: { mode: "none" as const },
  mounts: [{ kind: "workdir", source: "/t42/work", target: "/home/worker/work", mode: "ro" as const }],
  user: "worker",
  labels: { "neoba.task": "t42" },
};

describe("DockerProvider(注入假 runner)", () => {
  it("create 全流程:create + start,句柄进入 running", async () => {
    const { provider, calls } = makeProvider();
    const handle = await provider.create(SPEC);

    assert.equal(calls.length, 2);
    const createArgs = calls[0]!;
    assert.equal(createArgs[0], "create");
    assert.ok(createArgs.includes("neoba-base:latest"));
    assert.ok(createArgs.includes("--user"));
    assert.equal(createArgs[createArgs.indexOf("--user") + 1], "worker");
    const labelIdx = createArgs.indexOf("--label");
    assert.ok(createArgs[labelIdx! + 1]!.includes(`${NEOBA_MANAGED_LABEL}=true`));

    assert.deepEqual(calls[1], ["start", handle.id]);
    assert.equal(handle.status, "running");
    assert.equal(handle.name, `neoba-${handle.id.slice(0, 12)}`);
    assert.ok(!Number.isNaN(Date.parse(handle.createdAt)));
    assert.equal(handle.labels["neoba.task"], "t42");
    assert.equal(handle.labels[NEOBA_MANAGED_LABEL], "true");
  });

  it("exec:走 docker exec,结果透传,支持 opts", async () => {
    const { provider, calls } = makeProvider((args) =>
      args[0] === "exec"
        ? { code: 3, stdout: "hello\n", stderr: "warn\n" }
        : { code: 0, stdout: "", stderr: "" },
    );
    const handle = await provider.create(SPEC);
    const result = await provider.exec(handle, ["echo", "hello"], { user: "worker" });

    assert.deepEqual(calls.at(-1), ["exec", "--user", "worker", handle.id, "echo", "hello"]);
    assert.deepEqual(result, { exitCode: 3, stdout: "hello\n", stderr: "warn\n" });
  });

  it("logs:走 docker logs,支持 tail", async () => {
    const { provider, calls } = makeProvider((args) =>
      args[0] === "logs" ? { code: 0, stdout: "line1\nline2\n", stderr: "" } : { code: 0, stdout: "", stderr: "" },
    );
    const handle = await provider.create(SPEC);
    assert.equal(await provider.logs(handle), "line1\nline2\n");
    assert.deepEqual(calls.at(-1), ["logs", handle.id]);
    await provider.logs(handle, { tail: 10 });
    assert.deepEqual(calls.at(-1), ["logs", "--tail", "10", handle.id]);
  });

  it("destroy:rm -f 并置 removed;幂等,第二次不再调用 runner", async () => {
    const { provider, calls } = makeProvider();
    const handle = await provider.create(SPEC);
    await provider.destroy(handle);

    assert.deepEqual(calls.at(-1), ["rm", "-f", handle.id]);
    assert.equal(handle.status, "removed");

    await provider.destroy(handle); // 幂等
    assert.equal(calls.length, 3);
    assert.equal(handle.status, "removed");
  });

  it("destroy:容器已不存在(No such container)视为已销毁,不抛错", async () => {
    const { provider } = makeProvider((args) =>
      args[0] === "rm"
        ? { code: 1, stdout: "", stderr: "Error response from daemon: No such container: neoba-x" }
        : { code: 0, stdout: "", stderr: "" },
    );
    const handle = await provider.create(SPEC);
    await provider.destroy(handle);
    assert.equal(handle.status, "removed");
  });

  it("exec 对非 running 句柄抛 InvalidStateError(removed)", async () => {
    const { provider } = makeProvider();
    const handle = await provider.create(SPEC);
    await provider.destroy(handle);
    await assert.rejects(provider.exec(handle, ["ls"]), (err: unknown) => {
      assert.ok(err instanceof InvalidStateError);
      assert.equal(err.code, "invalid_state");
      return true;
    });
  });

  it("exec 对 provisioning 中的句柄同样拒绝(非 running)", async () => {
    const { provider } = makeProvider();
    // 用 pending 状态句柄模拟中间态:create 前手工构造
    const handle = await provider.create(SPEC);
    handle.status = "provisioning";
    await assert.rejects(provider.exec(handle, ["ls"]), InvalidStateError);
    handle.status = "running";
  });

  it("runner spawn 失败(如 docker 未安装)→ ProviderUnavailableError", async () => {
    const provider = new DockerProvider({
      runner: async () => {
        throw new Error("spawn docker ENOENT");
      },
    });
    await assert.rejects(provider.create(SPEC), (err: unknown) => {
      assert.ok(err instanceof ProviderUnavailableError);
      assert.equal(err.code, "provider_unavailable");
      assert.match(err.message, /neoba doctor/);
      return true;
    });
  });

  it("daemon 不可达(stderr 形态)→ ProviderUnavailableError 并提示 neoba doctor", async () => {
    const { provider } = makeProvider(() => ({
      code: 1,
      stdout: "",
      stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
    }));
    await assert.rejects(provider.create(SPEC), (err: unknown) => {
      assert.ok(err instanceof ProviderUnavailableError);
      assert.match(err.message, /neoba doctor/);
      return true;
    });
  });

  it("普通命令失败 → CommandFailedError", async () => {
    const { provider } = makeProvider((args) =>
      args[0] === "create"
        ? { code: 125, stdout: "", stderr: "docker: invalid reference format." }
        : { code: 0, stdout: "", stderr: "" },
    );
    await assert.rejects(provider.create(SPEC), (err: unknown) => {
      assert.ok(err instanceof CommandFailedError);
      assert.equal(err.code, "command_failed");
      assert.match(err.message, /exit 125/);
      return true;
    });
  });

  it("list:按标签子集匹配本实例创建的句柄,排除已销毁", async () => {
    const { provider } = makeProvider();
    const h1 = await provider.create(SPEC);
    const h2 = await provider.create({ ...SPEC, labels: { "neoba.task": "t43" } });

    assert.equal((await provider.list()).length, 2);
    const t42 = await provider.list({ "neoba.task": "t42" });
    assert.deepEqual(t42.map((h) => h.id), [h1.id]);
    // 管理标签可检索任意本 daemon 句柄
    assert.equal((await provider.list({ [NEOBA_MANAGED_LABEL]: "true" })).length, 2);
    // 不匹配任何句柄的标签
    assert.deepEqual(await provider.list({ "neoba.task": "nope" }), []);
    // 销毁后从 list 消失
    await provider.destroy(h2);
    assert.equal((await provider.list()).length, 1);
    assert.equal((await provider.list())[0]!.id, h1.id);
  });

  it("snapshot/restore/acquire/release 抛 NotSupportedError", async () => {
    const { provider } = makeProvider();
    const handle = await provider.create(SPEC);
    await assert.rejects(provider.snapshot(handle), (err: unknown) => {
      assert.ok(err instanceof NotSupportedError);
      assert.equal(err.code, "not_supported");
      return true;
    });
    await assert.rejects(provider.restore("snap-1"), NotSupportedError);
    await assert.rejects(provider.acquire("default"), NotSupportedError);
    await assert.rejects(provider.release("default"), NotSupportedError);
  });

  it("userns 前置:探针通过 → create 成功并映射 seccomp 放行", async () => {
    let probeCalls = 0;
    const { provider, calls } = makeProvider(undefined, () => {
      probeCalls += 1;
      return true;
    });
    const handle = await provider.create({
      ...SPEC,
      baseRequirements: { harness: "codex", userns: true, preinstalled: ["bubblewrap"] },
    });
    assert.equal(handle.status, "running");
    assert.equal(probeCalls, 1);
    const createArgs = calls[0]!;
    const idx = createArgs.indexOf("--security-opt");
    assert.ok(idx > -1);
    assert.equal(createArgs[idx + 1], "seccomp=unconfined");
  });

  it("userns 前置:探针不通过 → PrerequisiteNotMetError 显式拒绝,不静默降级", async () => {
    const { provider, calls } = makeProvider(undefined, () => false);
    await assert.rejects(
      provider.create({
        ...SPEC,
        baseRequirements: { harness: "codex", userns: true },
      }),
      (err: unknown) => {
        assert.ok(err instanceof PrerequisiteNotMetError);
        assert.equal(err.code, "prerequisite_not_met");
        assert.match(err.message, /userns/);
        assert.match(err.message, /neoba doctor/);
        return true;
      },
    );
    // 拒绝发生在拉起之前:无任何 docker 调用,不产生半注册句柄
    assert.equal(calls.length, 0);
    assert.equal((await provider.list()).length, 0);
  });

  it("userns 前置:未配置探针 → 视为无法验证,显式拒绝", async () => {
    const { provider } = makeProvider();
    await assert.rejects(
      provider.create({ ...SPEC, baseRequirements: { harness: "codex", userns: true } }),
      PrerequisiteNotMetError,
    );
  });

  it("Claude Code 基座无特殊要求:不触发 userns 探测", async () => {
    const { provider } = makeProvider(undefined, () => {
      throw new Error("不应被调用");
    });
    const handle = await provider.create({
      ...SPEC,
      baseRequirements: { harness: "claude-code" },
    });
    assert.equal(handle.status, "running");
  });

  it("网络 allowlist:预留能力,create 报 NotSupportedError", async () => {
    const { provider, calls } = makeProvider();
    await assert.rejects(
      provider.create({
        ...SPEC,
        network: { mode: "allowlist", allow: ["registry.npmjs.org"] },
      }),
      (err: unknown) => {
        assert.ok(err instanceof NotSupportedError);
        assert.equal(err.code, "not_supported");
        return true;
      },
    );
    assert.equal(calls.length, 0);
  });

  it("secret/config 挂载 rw 被运行时强制拒绝(防 as 绕过类型)", async () => {
    const { provider } = makeProvider();
    const badMounts = [
      { kind: "secret", source: "neoba-cred", target: "/run/secrets/cred", mode: "rw" },
    ] as unknown as SandboxMount[];
    await assert.rejects(
      provider.create({ ...SPEC, mounts: badMounts }),
      (err: unknown) => {
        assert.ok(err instanceof InvalidSpecError);
        assert.equal(err.code, "invalid_spec");
        assert.match(err.message, /ro/);
        return true;
      },
    );
  });
});
