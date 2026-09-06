import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  InvalidSpecError,
  NEOBA_CREATED_AT_LABEL,
  NEOBA_MANAGED_LABEL,
  NEOBA_PROVIDER_LABEL,
  buildCreateArgs,
  buildExecArgs,
  buildLogsArgs,
  buildRemoveArgs,
  buildStartArgs,
  containerName,
  NotSupportedError,
} from "../../src/provision/index.ts";
import type { SandboxSpec } from "../../src/provision/index.ts";

const ID = "0123456789abcdef";
const CREATED_AT = "2026-09-04T00:00:00.000Z";

describe("containerName", () => {
  it("由 id 前 12 位派生 neoba- 前缀容器名", () => {
    assert.equal(containerName(ID), "neoba-0123456789ab");
  });
});

describe("buildCreateArgs:spec → docker 参数映射", () => {
  it("最小 spec:默认 --network none,无多余参数", () => {
    const args = buildCreateArgs({ image: "neoba-base:latest" }, ID, CREATED_AT);
    assert.equal(args[0], "create");
    assert.deepEqual(args.slice(-1), ["neoba-base:latest"]);
    // 资源/挂载/env/用户均未给,不应出现对应 flag
    for (const flag of ["--memory", "--cpus", "--pids-limit", "-v", "-e", "--user", "--workdir"]) {
      assert.ok(!args.includes(flag), `不应包含 ${flag}`);
    }
    assert.ok(args.includes("--network"));
    assert.equal(args[args.indexOf("--network") + 1], "none");
  });

  it("资源限额:--memory(字节整数)/--cpus/--pids-limit", () => {
    const spec: SandboxSpec = {
      image: "img",
      resources: { memoryBytes: 256 * 1024 * 1024, cpus: 1.5, pidsLimit: 256 },
    };
    const args = buildCreateArgs(spec, ID, CREATED_AT);
    assert.equal(args[args.indexOf("--memory") + 1], "268435456");
    assert.equal(args[args.indexOf("--cpus") + 1], "1.5");
    assert.equal(args[args.indexOf("--pids-limit") + 1], "256");
  });

  it("网络策略:bridge / none 映射到 --network;allowlist 拒绝", () => {
    const bridge = buildCreateArgs({ image: "img", network: { mode: "bridge" } }, ID, CREATED_AT);
    assert.equal(bridge[bridge.indexOf("--network") + 1], "bridge");

    assert.throws(
      () =>
        buildCreateArgs(
          { image: "img", network: { mode: "allowlist", allow: ["registry.npmjs.org"] } },
          ID,
          CREATED_AT,
        ),
      (err: unknown) => {
        assert.ok(err instanceof NotSupportedError);
        assert.equal(err.code, "not_supported");
        return true;
      },
    );
  });

  it("基座前置 userns:映射 --security-opt seccomp=unconfined(docker 默认 seccomp 拦 clone)", () => {
    const plain = buildCreateArgs(
      { image: "img", baseRequirements: { harness: "claude-code" } },
      ID,
      CREATED_AT,
    );
    assert.ok(!plain.includes("--security-opt"));

    const userns = buildCreateArgs(
      { image: "img", baseRequirements: { harness: "codex", userns: true, preinstalled: ["bubblewrap"] } },
      ID,
      CREATED_AT,
    );
    const idx = userns.indexOf("--security-opt");
    assert.ok(idx > -1);
    assert.equal(userns[idx + 1], "seccomp=unconfined");
  });

  it("挂载卷:-v source:target:ro|rw;secret/config 类恒 ro", () => {
    const spec: SandboxSpec = {
      image: "img",
      mounts: [
        { kind: "workdir", source: "C:/tasks/t42/work", target: "/home/worker/work", mode: "rw" },
        { kind: "workdir", source: "C:/tasks/t42/artifacts", target: "/artifacts", mode: "ro" },
        { kind: "config", source: "C:/tasks/t42/settings.json", target: "/home/worker/.claude/settings.json", mode: "ro" },
        { kind: "secret", source: "neoba-cred-t42", target: "/run/secrets/cred", mode: "ro" },
      ],
    };
    const args = buildCreateArgs(spec, ID, CREATED_AT);
    const volumes = args.filter((a, i) => i > 0 && args[i - 1] === "-v");
    assert.deepEqual(volumes, [
      "C:/tasks/t42/work:/home/worker/work:rw",
      "C:/tasks/t42/artifacts:/artifacts:ro",
      "C:/tasks/t42/settings.json:/home/worker/.claude/settings.json:ro",
      "neoba-cred-t42:/run/secrets/cred:ro",
    ]);
  });

  it("环境变量:env 经 --env-file 临时文件传递,明文不落 argv(#11)", () => {
    const args = buildCreateArgs(
      { image: "img", env: { CI: "1", NEBOBA_SECRET_TOKEN: "s3cr3t-value" } },
      ID,
      CREATED_AT,
      "/tmp/neoba-env-x.env",
    );
    const idx = args.indexOf("--env-file");
    assert.ok(idx > -1);
    assert.equal(args[idx + 1], "/tmp/neoba-env-x.env");
    // argv 全量不出现 -e K=V 形态与任何明文
    assert.ok(!args.includes("-e"));
    assert.ok(!args.includes("--env"));
    assert.ok(!args.some((a) => a.includes("s3cr3t-value") || a.includes("CI=1")));
  });

  it("env 非空但未提供 env-file 路径 → InvalidSpecError(防 -e K=V 明文回归)", () => {
    assert.throws(
      () => buildCreateArgs({ image: "img", env: { CI: "1" } }, ID, CREATED_AT),
      (err: unknown) => {
        assert.ok(err instanceof InvalidSpecError);
        assert.equal(err.code, "invalid_spec");
        return true;
      },
    );
  });

  it("env 为空:不出现 --env-file(argv 零变化)", () => {
    const args = buildCreateArgs({ image: "img" }, ID, CREATED_AT, "/tmp/neoba-env-x.env");
    assert.ok(!args.includes("--env-file"));
  });

  it("非 root 用户与工作目录:--user / --workdir", () => {
    const args = buildCreateArgs(
      { image: "img", user: "1000:1000", workdir: "/home/worker/work" },
      ID,
      CREATED_AT,
    );
    assert.equal(args[args.indexOf("--user") + 1], "1000:1000");
    assert.equal(args[args.indexOf("--workdir") + 1], "/home/worker/work");
  });

  it("标签:neoba.* 管理标签自动追加,业务标签原样透传", () => {
    const args = buildCreateArgs(
      { image: "img", labels: { "neoba.task": "t42", team: "core" } },
      ID,
      CREATED_AT,
    );
    const labels = args.filter((a, i) => i > 0 && args[i - 1] === "--label");
    assert.ok(labels.includes(`${NEOBA_MANAGED_LABEL}=true`));
    assert.ok(labels.includes(`${NEOBA_PROVIDER_LABEL}=docker`));
    assert.ok(labels.includes(`${NEOBA_CREATED_AT_LABEL}=${CREATED_AT}`));
    assert.ok(labels.includes("neoba.id=0123456789abcdef"));
    assert.ok(labels.includes("neoba.task=t42"));
    assert.ok(labels.includes("team=core"));
    // 声明基座时追加 neoba.harness
    const withHarness = buildCreateArgs(
      { image: "img", baseRequirements: { harness: "codex" } },
      ID,
      CREATED_AT,
    );
    assert.ok(
      withHarness.includes("--label") && withHarness.includes("neoba.harness=codex"),
    );
  });

  it("命令覆盖:镜像后追加 command", () => {
    const args = buildCreateArgs({ image: "img", command: ["sleep", "infinity"] }, ID, CREATED_AT);
    assert.deepEqual(args.slice(-2), ["sleep", "infinity"]);
    assert.equal(args.at(-3), "img");
  });
});

describe("其余子命令参数", () => {
  it("start / exec / logs / rm", () => {
    assert.deepEqual(buildStartArgs(ID), ["start", ID]);
    assert.deepEqual(buildExecArgs(ID, ["echo", "hi"]), ["exec", ID, "echo", "hi"]);
    assert.deepEqual(
      buildExecArgs(ID, ["whoami"], { user: "worker", workdir: "/w", env: { A: "1" } }),
      ["exec", "--user", "worker", "--workdir", "/w", "--env", "A=1", ID, "whoami"],
    );
    assert.deepEqual(buildLogsArgs(ID), ["logs", ID]);
    assert.deepEqual(buildLogsArgs(ID, { tail: 50 }), ["logs", "--tail", "50", ID]);
    assert.deepEqual(buildRemoveArgs(ID), ["rm", "-f", ID]);
  });
});
