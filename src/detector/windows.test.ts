import { describe, it, expect } from "bun:test";
import { detectWindows, parseExecPolicy, type WinProbe } from "./windows";

// Deterministic probe. Defaults: Windows on, everything healthy. Scenarios override what they test.
function mockProbe(over: Partial<WinProbe> = {}): WinProbe {
  return {
    isWin: true,
    execPolicy: () => "Scope    ExecutionPolicy\nCurrentUser    RemoteSigned\nLocalMachine    Undefined",
    languageMode: () => "FullLanguage",
    codepage: () => 65001,
    schannelRevokeEnabled: () => false,
    appAliases: () => [],
    safeDeleteActive: () => false,
    ...over,
  };
}

describe("detectWindows: non-Windows", () => {
  it("returns windows:false and no checks off Windows", () => {
    const { data, checks } = detectWindows(mockProbe({ isWin: false }));
    expect(data.windows).toBe(false);
    expect(checks.length).toBe(0);
  });
});

describe("detectWindows: language mode (error)", () => {
  it("flags an error when Constrained Language Mode is active", () => {
    const { checks } = detectWindows(mockProbe({ languageMode: () => "ConstrainedLanguage" }));
    const c = checks.find((x) => x.ID === "win.langmode");
    expect(c).toBeDefined();
    expect(c!.Severity).toBe("error");
  });

  it("does NOT flag FullLanguage", () => {
    const { checks } = detectWindows(mockProbe({ languageMode: () => "FullLanguage" }));
    expect(checks.some((c) => c.ID === "win.langmode")).toBe(false);
  });
});

describe("detectWindows: execution policy (warn)", () => {
  it("flags a warn when the effective policy is Restricted", () => {
    const probe = mockProbe({
      execPolicy: () =>
        "Scope    ExecutionPolicy\nCurrentUser    Restricted\nLocalMachine    Undefined",
    });
    const { checks } = detectWindows(probe);
    const c = checks.find((x) => x.ID === "win.execpolicy");
    expect(c).toBeDefined();
    expect(c!.Severity).toBe("warn");
  });

  it("does NOT flag RemoteSigned", () => {
    const probe = mockProbe({
      execPolicy: () =>
        "Scope    ExecutionPolicy\nCurrentUser    RemoteSigned\nLocalMachine    Undefined",
    });
    const { checks } = detectWindows(probe);
    expect(checks.some((c) => c.ID === "win.execpolicy")).toBe(false);
  });

  it("flags Restricted when EVERY scope is Undefined (PowerShell default)", () => {
    const probe = mockProbe({
      execPolicy: () =>
        "Scope    ExecutionPolicy\nMachinePolicy    Undefined\nUserPolicy    Undefined\nCurrentUser    Undefined\nLocalMachine    Undefined",
    });
    const { checks } = detectWindows(probe);
    const c = checks.find((x) => x.ID === "win.execpolicy");
    expect(c).toBeDefined();
    expect(c!.Severity).toBe("warn");
  });
});

describe("detectWindows: console codepage (info)", () => {
  it("flags an info when codepage is not 65001", () => {
    const { checks } = detectWindows(mockProbe({ codepage: () => 936 }));
    const c = checks.find((x) => x.ID === "win.console.cp");
    expect(c).toBeDefined();
    expect(c!.Severity).toBe("info");
  });
});

describe("detectWindows: schannel revocation (warn)", () => {
  it("flags a warn when revocation check is blocking", () => {
    const { checks } = detectWindows(mockProbe({ schannelRevokeEnabled: () => true }));
    const c = checks.find((x) => x.ID === "win.schannel");
    expect(c).toBeDefined();
    expect(c!.Severity).toBe("warn");
  });

  it("does NOT flag when revocation check is off or undetermined", () => {
    for (const v of [false, null]) {
      const { checks } = detectWindows(mockProbe({ schannelRevokeEnabled: () => v }));
      expect(checks.some((c) => c.ID === "win.schannel")).toBe(false);
    }
  });
});

describe("detectWindows: app aliases (info)", () => {
  it("flags an info when WindowsApps aliases shadow real tools", () => {
    const { data, checks } = detectWindows(
      mockProbe({ appAliases: () => [{ tool: "python.exe", target: "WindowsApps" }] }),
    );
    expect(data.appAliases?.length).toBe(1);
    const c = checks.find((x) => x.ID === "win.appalias");
    expect(c).toBeDefined();
    expect(c!.Severity).toBe("info");
  });
});

describe("detectWindows: safe-delete (warn)", () => {
  it("flags a warn when the safe-delete shim is active", () => {
    const { checks } = detectWindows(mockProbe({ safeDeleteActive: () => true }));
    const c = checks.find((x) => x.ID === "win.safedelete");
    expect(c).toBeDefined();
    expect(c!.Severity).toBe("warn");
  });
});

describe("parseExecPolicy", () => {
  it("parses scope/level rows and skips Undefined + header", () => {
    const out =
      "Scope    ExecutionPolicy\nMachinePolicy    Undefined\nCurrentUser    RemoteSigned\nLocalMachine    Restricted";
    const rows = parseExecPolicy(out);
    expect(rows).toEqual([
      { scope: "CurrentUser", level: "RemoteSigned" },
      { scope: "LocalMachine", level: "Restricted" },
    ]);
  });
});
