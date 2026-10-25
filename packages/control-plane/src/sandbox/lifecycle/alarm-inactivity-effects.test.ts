import { afterEach, describe, it, expect, vi } from "vitest";
import { DEFAULT_LIFECYCLE_CONFIG, SandboxLifecycleManager } from "./manager";
import {
  createAlarmFixture,
  createMockAlarmScheduler,
  createMockBroadcaster,
  createMockIdGenerator,
  createMockProvider,
  createMockSandbox,
  createMockSession,
  createMockStorage,
  createMockWebSocketManager,
  createTestConfig,
  createUnmanagedShutdown,
} from "./test-helpers";

describe("inactivity alarm effects", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    {
      name: "heartbeat before remaining inactivity",
      ageMs: 120_000,
      clients: 0,
      delayMs: DEFAULT_LIFECYCLE_CONFIG.heartbeat.timeoutMs + 1,
    },
    {
      name: "minimum interval",
      ageMs: DEFAULT_LIFECYCLE_CONFIG.inactivity.timeoutMs - 1,
      clients: 0,
      delayMs: DEFAULT_LIFECYCLE_CONFIG.inactivity.minCheckIntervalMs,
    },
    {
      name: "client extension",
      ageMs: DEFAULT_LIFECYCLE_CONFIG.inactivity.timeoutMs,
      clients: 2,
      delayMs: DEFAULT_LIFECYCLE_CONFIG.inactivity.extensionMs,
    },
  ])("schedules $name at an absolute deadline", async ({ ageMs, clients, delayMs }) => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000_000);
    const now = Date.now();
    const sandbox = createMockSandbox({ last_heartbeat: now, last_activity: now - ageMs });
    const h = createAlarmFixture(sandbox, createMockProvider(), clients);

    await expect(h.manager.handleAlarm()).resolves.toBe("no_action");

    expect(h.alarmScheduler.schedule).toHaveBeenCalledExactlyOnceWith(now + delayMs);
    expect(h.storage.updateSandboxStatus).not.toHaveBeenCalled();
    expect(h.provider.takeSnapshot).not.toHaveBeenCalled();
    expect(h.wsManager.sendToSandbox).not.toHaveBeenCalled();
    expect(h.wsManager.detachSandboxWebSocket).not.toHaveBeenCalled();
    expect(h.broadcaster.messages).toEqual(
      clients
        ? [
            {
              type: "sandbox_warning",
              message:
                "Sandbox will stop in 5 minutes due to inactivity. Send a message to keep it alive.",
            },
          ]
        : []
    );
  });

  describe.each(["rejected", "unsuccessful"] as const)("%s provider stop", (failure) => {
    it.each([false, true])("still retires and warns (resumable=%s)", async (resumable) => {
      const sandbox = createMockSandbox({
        last_activity: Date.now() - DEFAULT_LIFECYCLE_CONFIG.inactivity.timeoutMs - 1,
        code_server_url: "https://code.test",
      });
      const stopSandbox = vi.fn(async () => {
        if (failure === "rejected") throw new Error("provider stop unavailable");
        return { success: false, error: "provider stop unavailable" };
      });
      const stopLog = vi.spyOn(console, "error").mockImplementation(() => {});
      const h = createAlarmFixture(
        sandbox,
        createMockProvider({
          capabilities: { supportsExplicitStop: true, supportsPersistentResume: resumable },
          stopSandbox,
        })
      );

      await expect(h.manager.handleAlarm()).resolves.toBe("sandbox_terminated");

      expect(stopSandbox).toHaveBeenCalledOnce();
      expect(stopSandbox).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: "inactivity_timeout",
          intent: resumable ? "preserve" : "destroy",
        })
      );
      expect(stopLog).toHaveBeenCalledWith(
        expect.stringContaining('"error":"provider stop unavailable"')
      );
      expect(sandbox.code_server_url).toBeNull();
      expect(sandbox.status).toBe("stopped");
      expect(h.manager.isSpawning()).toBe(false);
      expect(h.alarmScheduler.schedule).not.toHaveBeenCalled();
      expect(h.broadcaster.messages).toContainEqual({ type: "sandbox_status", status: "stopped" });
      expect(h.broadcaster.messages).toContainEqual({
        type: "sandbox_warning",
        message: resumable
          ? "Sandbox stopped due to inactivity"
          : "Sandbox stopped due to inactivity, snapshot saved",
      });
      expect(h.wsManager.detachSandboxWebSocket).toHaveBeenCalledExactlyOnceWith(
        1000,
        "Inactivity timeout"
      );
      expect(h.provider.takeSnapshot).toHaveBeenCalledTimes(resumable ? 0 : 1);
      expect(h.wsManager.sendToSandbox).toHaveBeenCalledTimes(resumable ? 0 : 1);
    });
  });

  it("does not explicitly stop providers when the capability is disabled", async () => {
    const sandbox = createMockSandbox({
      last_activity: Date.now() - DEFAULT_LIFECYCLE_CONFIG.inactivity.timeoutMs - 1,
    });
    const stopSandbox = vi.fn(async () => ({ success: true }));
    const h = createAlarmFixture(
      sandbox,
      createMockProvider({
        capabilities: { supportsExplicitStop: false, supportsPersistentResume: false },
        stopSandbox,
      })
    );

    await expect(h.manager.handleAlarm()).resolves.toBe("sandbox_terminated");

    expect(sandbox.status).toBe("stopped");
    expect(h.provider.takeSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        providerObjectId: sandbox.modal_object_id,
        reason: "inactivity_timeout",
      })
    );
    expect(stopSandbox).not.toHaveBeenCalled();
    expect(h.wsManager.sendToSandbox).toHaveBeenCalledWith({ type: "shutdown" });
  });

  it("preserves a destructive-snapshot sandbox before inactivity destroys it", async () => {
    const sandbox = createMockSandbox({
      last_activity: Date.now() - DEFAULT_LIFECYCLE_CONFIG.inactivity.timeoutMs - 1,
    });
    const order: string[] = [];
    const h = createAlarmFixture(
      sandbox,
      createMockProvider({
        capabilities: {
          snapshotRequiresShutdown: true,
          supportsExplicitStop: true,
          supportsPersistentResume: false,
        },
        takeSnapshot: vi.fn(async () => {
          order.push("snapshot");
          return { success: true, imageId: "legacy-vercel-snapshot" };
        }),
        stopSandbox: vi.fn(async () => {
          order.push("stop");
          return { success: true };
        }),
      })
    );

    await h.manager.handleAlarm();

    expect(order).toEqual(["snapshot", "stop"]);
    expect(sandbox.snapshot_image_id).toBe("legacy-vercel-snapshot");
  });

  it("stops resumable sandboxes without snapshotting, preserving access secrets", async () => {
    const sandbox = createMockSandbox({
      last_activity: Date.now() - DEFAULT_LIFECYCLE_CONFIG.inactivity.timeoutMs - 1,
      code_server_url: "https://code.test",
      code_server_password: "code-secret",
      vnc_url: "https://vnc.test",
      vnc_password: "vnc-secret",
      ttyd_url: "https://terminal.test",
      ttyd_token: "terminal-secret",
      tunnel_urls: '{"3000":"https://preview.test"}',
    });
    const stopSandbox = vi.fn(async () => ({ success: true }));
    const h = createAlarmFixture(
      sandbox,
      createMockProvider({
        capabilities: { supportsExplicitStop: true, supportsPersistentResume: true },
        stopSandbox,
      })
    );

    await expect(h.manager.handleAlarm()).resolves.toBe("sandbox_terminated");

    expect(h.provider.takeSnapshot).not.toHaveBeenCalled();
    expect(h.wsManager.sendToSandbox).not.toHaveBeenCalled();
    expect(stopSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        providerObjectId: sandbox.modal_object_id,
        reason: "inactivity_timeout",
        intent: "preserve",
      })
    );
    expect(h.storage.clearSandboxAccess).not.toHaveBeenCalledWith("codeServer");
    expect(h.storage.clearSandboxAccess).not.toHaveBeenCalledWith("vnc");
    expect(h.storage.clearSandboxAccess).not.toHaveBeenCalledWith("ttyd");
    expect(sandbox).toMatchObject({
      code_server_url: null,
      code_server_password: "code-secret",
      vnc_url: null,
      vnc_password: "vnc-secret",
      ttyd_url: null,
      ttyd_token: "terminal-secret",
      tunnel_urls: null,
    });
  });

  it("clears complete access when URL-only clearing is unavailable", async () => {
    const sandbox = createMockSandbox({
      last_activity: Date.now() - DEFAULT_LIFECYCLE_CONFIG.inactivity.timeoutMs - 1,
      vnc_url: "https://vnc.test",
      vnc_password: "encrypted-vnc-password",
    });
    const h = createAlarmFixture(
      sandbox,
      createMockProvider({
        capabilities: { supportsExplicitStop: true, supportsPersistentResume: true },
        stopSandbox: vi.fn(async () => ({ success: true })),
      })
    );
    delete h.storage.clearSandboxAccessUrl;

    await h.manager.handleAlarm();

    expect(h.storage.calls).toContain("clearSandboxAccess:vnc");
    expect(sandbox.vnc_url).toBeNull();
    expect(sandbox.vnc_password).toBeNull();
  });
});

describe("unprompted sandbox release", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function unpromptedFixture(release: "released" | "held" | "unmanaged") {
    vi.useFakeTimers();
    vi.setSystemTime(10_000_000);
    const now = Date.now();
    const sandbox = createMockSandbox({
      last_heartbeat: now,
      last_activity: now - DEFAULT_LIFECYCLE_CONFIG.inactivity.unpromptedTimeoutMs,
    });
    const provider = createMockProvider();
    const storage = createMockStorage(createMockSession({ status: "created" }), sandbox);
    const broadcaster = createMockBroadcaster();
    const wsManager = createMockWebSocketManager(false, 0);
    const alarmScheduler = createMockAlarmScheduler();
    const shutdown = {
      ...createUnmanagedShutdown(),
      releaseUnprompted: vi.fn(async (_reason: string) => release),
    };
    const manager = new SandboxLifecycleManager(
      provider,
      storage,
      storage,
      broadcaster,
      wsManager,
      alarmScheduler,
      createMockIdGenerator(),
      shutdown,
      createTestConfig()
    );
    return { now, sandbox, provider, storage, alarmScheduler, shutdown, manager };
  }

  it("releases a warm sandbox nobody prompted after the short idle, without a save", async () => {
    const f = unpromptedFixture("released");

    await expect(f.manager.handleAlarm()).resolves.toBe("sandbox_terminated");

    expect(f.shutdown.releaseUnprompted).toHaveBeenCalledExactlyOnceWith("unprompted_timeout");
    expect(f.shutdown.requestShutdown).not.toHaveBeenCalled();
    expect(f.provider.takeSnapshot).not.toHaveBeenCalled();
  });

  it("falls back to the ordinary inactivity stop when the release is not owned", async () => {
    const f = unpromptedFixture("unmanaged");

    await expect(f.manager.handleAlarm()).resolves.toBe("sandbox_terminated");

    expect(f.shutdown.requestShutdown).toHaveBeenCalledWith("inactivity_timeout");
    expect(f.sandbox.status).toBe("stopped");
  });

  it("looks again shortly when the shutdown owner is busy", async () => {
    const f = unpromptedFixture("held");

    await expect(f.manager.handleAlarm()).resolves.toBe("no_action");

    expect(f.alarmScheduler.alarms).toEqual([
      f.now + DEFAULT_LIFECYCLE_CONFIG.inactivity.minCheckIntervalMs,
    ]);
    expect(f.sandbox.status).toBe("ready");
  });

  it("arms the first inactivity check at the short idle", async () => {
    const f = unpromptedFixture("released");

    await f.manager.scheduleInactivityCheck();

    expect(f.alarmScheduler.alarms).toEqual([
      f.now + DEFAULT_LIFECYCLE_CONFIG.inactivity.unpromptedTimeoutMs,
    ]);
  });

  it("releases an archived draft's sandbox, saving it only when release is not possible", async () => {
    const released = unpromptedFixture("released");
    await released.manager.releaseForArchivedDraft();
    expect(released.shutdown.releaseUnprompted).toHaveBeenCalledWith("draft_archived");
    expect(released.shutdown.requestShutdown).not.toHaveBeenCalled();

    const unmanaged = unpromptedFixture("unmanaged");
    await unmanaged.manager.releaseForArchivedDraft();
    expect(unmanaged.shutdown.requestShutdown).toHaveBeenCalledWith("session_archived");
  });

  it("cancels, rather than holds, the sandbox of a draft archived while it is still starting", async () => {
    const f = unpromptedFixture("unmanaged");
    f.sandbox.status = "spawning";
    f.sandbox.modal_object_id = null;

    await f.manager.releaseForArchivedDraft();

    // The row is stopped, so the provider's answer is destroyed when it arrives (a held
    // generation would keep it running); nothing is saved and nothing waits for a runtime.
    expect(f.sandbox.status).toBe("stopped");
    expect(f.shutdown.requestShutdown).not.toHaveBeenCalled();
    expect(f.provider.takeSnapshot).not.toHaveBeenCalled();
  });

  it("still saves an archived draft's sandbox that is up but whose release is not owned", async () => {
    const f = unpromptedFixture("unmanaged");
    f.sandbox.status = "spawning";
    f.sandbox.modal_object_id = "provider-object-1";

    await f.manager.releaseForArchivedDraft();

    expect(f.shutdown.requestShutdown).toHaveBeenCalledWith("session_archived");
  });
});
