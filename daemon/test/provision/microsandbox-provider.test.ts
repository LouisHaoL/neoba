/**
 * MicrosandboxProvider 测试(M7,§9 P4):注入假 runner 的全矩阵桩测试,
 * 绝不触达真实 msb / msbd(真桥冒烟见仓库 manual checklist,不进 CI)。
 * - argv 形状:create/exec/logs/stop/remove/snapshot/run --from-snapshot;
 * - 生命周期:create → exec/logs → snapshot(stop→create)→ destroy 幂等;
 * - restore:锚定名校验,坏输出 → CliOutputParseError(类型化,不炸流);
 * - CLI 不可用(spawn 失败)/ msbd 不可达 → PrerequisiteNotMetError,不静默降级;
 * - userns 天然满足(microVM),spec.command / allowlist 显式拒绝。
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  CliOutputParseError,
  CommandFailedError,
  InvalidSpecError,
  InvalidStateError,
  MicrosandboxProvider,
  NEOBA_MANAGED_LABEL,
  NotSupportedError,
  PrerequisiteNotMetError,
  buildMsbCreateArgs,
  formatMemoryMiB,
} from "../../src/provision/index.ts";
import type { CliResult, CliRunner, SandboxSpec } from "../../src/provision/index.ts";

/** 假 runner:记录全部调用,按脚本返回结果。绝不触达真实 msb。 */
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

function makeProvider(script?: (args: string[]) => CliResult) {
  const fake = fakeRunner(script);
  const provider = new MicrosandboxProvider({ runner: fake.runner });
  return { provider, ...fake };
}

const SPEC: SandboxSpec = {
  image: "neoba/sandbox:latest",
  env: { CI: "1" },
  resources: { cpus: 2, memoryBytes: 536870912 },
  network: { mode: "none" as const },
  mounts: [{ kind: "workdir", source: "/t42/work", target: "/workspace", mode: "ro" as const }],
  user: "worker",
  workdir: "/workspace",
  labels: { "neoba.task": "t42" },
};

describe("provision/MicrosandboxProvider(注入假 runner)", () => {
  it("create 全流程:argv 按 msb 规格,句柄进入 running", async () => {
    const { provider, calls } = makeProvider();
    const handle = await provider.create(SPEC);

    assert.equal(calls.length, 1);
    const args = calls[0]!;
    assert.equal(args[0], "create");
    assert.deepEqual(args.slice(0, 3), ["create", "--name", handle.name]);
    assert.ok(args.includes("neoba/sandbox:latest"));
    const idxCpus = args.indexOf("-c");
    assert.equal(args[idxCpus! + 1], "2");
    const idxMem = args.indexOf("--memory");
    assert.equal(args[idxMem! + 1], "512M");
    const idxNet = args.indexOf("--net-default");
    assert.equal(args[idxNet! + 1], "deny");
    const idxVol = args.indexOf("-v");
    assert.equal(args[idxVol! + 1], "/t42/work:/workspace:ro");
    const idxLabel = args.indexOf("--label");
    assert.ok(args[idxLabel! + 1]!.startsWith(`${NEOBA_MANAGED_LABEL}=true`));

    assert.equal(handle.status, "running");
    assert.ok(!Number.isNaN(Date.parse(handle.createdAt)));
    assert.equal(handle.labels["neoba.task"], "t42");
    // msb create 无 --user 面:spec.user 记入标签,exec 缺省用户由此还原
    assert.equal(handle.labels["neoba.user"], "worker");
  });

  it("网络 bridge → --net-default allow;workdir 落 argv;env 经 --conf 文件注入", async () => {
    const { provider, calls } = makeProvider();
    await provider.create({
      ...SPEC,
      env: { FOO: "bar" },
      network: { mode: "bridge" },
    });
    const args = calls[0]!;
    const idxNet = args.indexOf("--net-default");
    assert.equal(args[idxNet! + 1], "allow");
    const idxConf = args.indexOf("--conf");
    assert.ok(idxConf > -1);
    const idxWd = args.indexOf("-w");
    assert.equal(args[idxWd! + 1], "/workspace");
    // 用后即删:CLI 调用结束后 conf 临时文件不存在
    assert.equal(existsSync(args[idxConf! + 1]!), false);
  });

  it("secret 明文不落 argv(#11):create 经 --conf 注入,文件内容正确且用后即删", async () => {
    /** 捕获 CLI 运行中的 conf 文件路径与内容(先于用后即删)。 */
    const paths: string[] = [];
    const contents: string[] = [];
    const { provider, calls } = makeProvider((args) => {
      const i = args.indexOf("--conf");
      if (i > -1) {
        paths.push(args[i + 1]!);
        contents.push(readFileSync(args[i + 1]!, "utf8"));
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const handle = await provider.create({
      ...SPEC,
      env: { NEBOBA_SECRET_TOKEN: "s3cr3t-value!", FOO: "bar" },
    });

    // argv 全量(每次调用逐元素)不含 secret 明文与 -e K=V 形态
    assert.ok(!calls.flat().some((a) => a.includes("s3cr3t-value!") || a === "-e"));
    assert.ok(!calls.flat().some((a) => a.includes("FOO=bar")));
    // conf 文件内容为 sparse 根配置的 YAML env 映射(运行中读到)
    assert.equal(
      contents[0],
      `env:\n  "NEBOBA_SECRET_TOKEN": "s3cr3t-value!"\n  "FOO": "bar"\n`,
    );
    // 用后即删
    assert.equal(paths.length, 1);
    assert.equal(existsSync(paths[0]!), false);
    assert.equal(handle.status, "running");
  });

  it("create 失败路径同样清理 conf 临时文件(用后即删)", async () => {
    const paths: string[] = [];
    const { provider } = makeProvider((args) => {
      const i = args.indexOf("--conf");
      if (args[0] === "create" && i > -1) paths.push(args[i + 1]!);
      return args[0] === "create"
        ? { code: 1, stdout: "", stderr: "no /dev/kvm, KVM not available" }
        : { code: 0, stdout: "", stderr: "" };
    });
    await assert.rejects(
      provider.create({ ...SPEC, env: { NEBOBA_SECRET_TOKEN: "s3cr3t" } }),
      CommandFailedError,
    );
    assert.equal(paths.length, 1);
    assert.equal(existsSync(paths[0]!), false);
  });

  it("纯映射:env 非空但未提供 conf 文件路径 → InvalidSpecError(防 -e K=V 明文回归)", () => {
    assert.throws(
      () => buildMsbCreateArgs({ image: "img", env: { CI: "1" } }, "id-1234", "2026-09-04T00:00:00.000Z"),
      (err: unknown) => {
        assert.ok(err instanceof InvalidSpecError);
        assert.equal(err.code, "invalid_spec");
        return true;
      },
    );
  });

  it("exec:走 msb exec -q,opts 与缺省 user(spec.user)生效,退出码透传", async () => {
    const { provider, calls } = makeProvider((args) =>
      args[0] === "exec"
        ? { code: 3, stdout: "hello\n", stderr: "" }
        : { code: 0, stdout: "", stderr: "" },
    );
    const handle = await provider.create(SPEC);
    const result = await provider.exec(handle, ["echo", "hello"]);

    assert.deepEqual(
      calls.at(-1),
      ["exec", "-q", "-u", "worker", handle.name, "--", "echo", "hello"],
    );
    assert.deepEqual(result, { exitCode: 3, stdout: "hello\n", stderr: "" });
  });

  it("exec:opts.user 显式覆盖 spec.user 缺省", async () => {
    const { provider, calls } = makeProvider();
    const handle = await provider.create(SPEC);
    await provider.exec(handle, ["id"], { user: "root" });
    const args = calls.at(-1)!;
    const idx = args.indexOf("-u");
    assert.equal(args[idx! + 1], "root");
  });

  it("logs:走 msb logs,支持 --tail", async () => {
    const { provider, calls } = makeProvider((args) =>
      args[0] === "logs" ? { code: 0, stdout: "line1\nline2\n", stderr: "" } : { code: 0, stdout: "", stderr: "" },
    );
    const handle = await provider.create(SPEC);
    assert.equal(await provider.logs(handle), "line1\nline2\n");
    assert.deepEqual(calls.at(-1), ["logs", handle.name]);
    await provider.logs(handle, { tail: 10 });
    assert.deepEqual(calls.at(-1), ["logs", "--tail", "10", handle.name]);
  });

  it("生命周期矩阵:snapshot = stop → snapshot create,句柄转 stopped;restore = run --from-snapshot 回热", async () => {
    // restore 输出带锚定名(--name 由 provider 指定):脚本回显 --name 值
    const { provider, calls } = makeProvider((args) => {
      if (args[0] === "run") {
        const i = args.indexOf("--name");
        return { code: 0, stdout: `sandbox ready: ${args[i! + 1]}\n`, stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const handle = await provider.create(SPEC);
    const ref = await provider.snapshot(handle);
    assert.match(ref, /^neoba-snap-/);
    assert.deepEqual(calls.at(-2), ["stop", handle.name]);
    const snapIdx = calls.findIndex((a) => a[0] === "snapshot");
    assert.deepEqual(
      calls[snapIdx]!.slice(0, 4),
      ["snapshot", "create", ref, "--from"],
    );
    assert.equal(calls[snapIdx]![4], handle.name); // --from 后紧跟源沙箱名
    assert.equal(handle.status, "stopped");

    const restored = await provider.restore(ref);
    assert.equal(restored.status, "running");
    assert.equal(restored.labels["neoba.snapshot"], ref);
    const runArgs = calls.find((a) => a[0] === "run")!;
    assert.deepEqual(runArgs.slice(0, 2), ["run", "--from-snapshot"]);
    assert.ok(runArgs.includes(ref));
    // restore 后句柄属本实例,可 exec / destroy
    await provider.exec(restored, ["true"]);
    await provider.destroy(restored);
    assert.equal(restored.status, "removed");
  });

  it("restore 坏输出(不含锚定名)→ CliOutputParseError 类型化解析错误,不炸流", async () => {
    const provider = new MicrosandboxProvider({
      runner: async () => ({ code: 0, stdout: "", stderr: "" }),
    });
    await assert.rejects(provider.restore("neoba-snap-x"), (err: unknown) => {
      assert.ok(err instanceof CliOutputParseError);
      assert.equal(err.code, "output_parse_failed");
      return true;
    });
  });

  it("destroy:remove --force 并置 removed;幂等,第二次不再调用 runner", async () => {
    const { provider, calls } = makeProvider();
    const handle = await provider.create(SPEC);
    await provider.destroy(handle);
    assert.deepEqual(calls.at(-1), ["remove", "--force", handle.name]);
    assert.equal(handle.status, "removed");
    await provider.destroy(handle);
    assert.equal(calls.length, 2);
  });

  it("destroy:沙箱已不存在(No such sandbox)视为已销毁,不抛错", async () => {
    const { provider } = makeProvider((args) =>
      args[0] === "remove"
        ? { code: 1, stdout: "", stderr: "Error: no such sandbox: neoba-x" }
        : { code: 0, stdout: "", stderr: "" },
    );
    const handle = await provider.create(SPEC);
    await provider.destroy(handle);
    assert.equal(handle.status, "removed");
  });

  it("exec/logs 对非 running 句柄抛 InvalidStateError;snapshot 后 exec 被拒", async () => {
    const { provider } = makeProvider();
    const handle = await provider.create(SPEC);
    await provider.snapshot(handle);
    await assert.rejects(provider.exec(handle, ["ls"]), InvalidStateError);
    await provider.destroy(handle);
    await assert.rejects(provider.logs(handle), InvalidStateError);
  });

  it("CLI 不可用(spawn 失败)→ PrerequisiteNotMetError,不静默降级", async () => {
    const provider = new MicrosandboxProvider({
      runner: async () => {
        throw new Error("spawn msb ENOENT");
      },
    });
    await assert.rejects(provider.create(SPEC), (err: unknown) => {
      assert.ok(err instanceof PrerequisiteNotMetError);
      assert.equal(err.code, "prerequisite_not_met");
      assert.match(err.message, /msb/);
      return true;
    });
  });

  it("msbd 服务端不可达(stderr 形态)→ PrerequisiteNotMetError", async () => {
    const { provider } = makeProvider(() => ({
      code: 1,
      stdout: "",
      stderr: "error connecting to msbd: connection refused",
    }));
    await assert.rejects(provider.create(SPEC), (err: unknown) => {
      assert.ok(err instanceof PrerequisiteNotMetError);
      assert.match(err.message, /msbd/);
      return true;
    });
  });

  it("普通命令失败 → CommandFailedError", async () => {
    const { provider } = makeProvider((args) =>
      args[0] === "create"
        ? { code: 1, stdout: "", stderr: "no /dev/kvm, KVM not available" }
        : { code: 0, stdout: "", stderr: "" },
    );
    await assert.rejects(provider.create(SPEC), (err: unknown) => {
      assert.ok(err instanceof CommandFailedError);
      assert.equal(err.code, "command_failed");
      assert.match(err.message, /exit 1/);
      return true;
    });
  });

  it("userns 天然满足:microVM 硬件隔离,baseRequirements.userns 不拒绝", async () => {
    const { provider, calls } = makeProvider();
    const handle = await provider.create({
      ...SPEC,
      baseRequirements: { harness: "codex", userns: true, preinstalled: ["bubblewrap"] },
    });
    assert.equal(handle.status, "running");
    assert.equal(handle.labels["neoba.harness"], "codex");
    assert.equal(calls.length, 1); // 无任何前置探测调用
  });

  it("spec.command 显式 NotSupported(msb create 为 idle 拉起,不静默忽略)", async () => {
    const { provider, calls } = makeProvider();
    await assert.rejects(
      provider.create({ ...SPEC, command: ["sleep", "infinity"] }),
      (err: unknown) => {
        assert.ok(err instanceof NotSupportedError);
        assert.equal(err.code, "not_supported");
        return true;
      },
    );
    assert.equal(calls.length, 0); // 拒绝发生在任何 CLI 调用之前
  });

  it("allowlist 网络 / secret 挂载 rw:复用共用硬规则校验", async () => {
    const { provider, calls } = makeProvider();
    await assert.rejects(
      provider.create({ ...SPEC, network: { mode: "allowlist", allow: ["example.com"] } }),
      NotSupportedError,
    );
    const badMounts = [
      { kind: "secret", source: "cred", target: "/run/secrets/cred", mode: "rw" },
    ] as unknown as SandboxSpec["mounts"];
    await assert.rejects(provider.create({ ...SPEC, mounts: badMounts }), InvalidSpecError);
    assert.equal(calls.length, 0);
  });

  it("list:按标签子集匹配本实例句柄,排除已销毁;acquire/release 仍为占位", async () => {
    const { provider } = makeProvider();
    const h1 = await provider.create(SPEC);
    const h2 = await provider.create({ ...SPEC, labels: { "neoba.task": "t43" } });
    assert.deepEqual((await provider.list({ "neoba.task": "t42" })).map((h) => h.id), [h1.id]);
    assert.equal((await provider.list()).length, 2);
    await provider.destroy(h2);
    assert.equal((await provider.list()).length, 1);
    await assert.rejects(provider.acquire("default"), NotSupportedError);
    await assert.rejects(provider.release("default"), NotSupportedError);
  });

  it("formatMemoryMiB:字节 → msb --memory 形态", () => {
    assert.equal(formatMemoryMiB(536870912), "512M");
    assert.equal(formatMemoryMiB(1073741824), "1024M");
    assert.equal(formatMemoryMiB(0), "1M");
  });
});
