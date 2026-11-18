import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { generateEndpoint, generateToken } from "../src/endpoint";
import type { Logger } from "../src/logger";
import { type IpcServer, startIpcServer } from "../src/server";

/**
 * Opt-in (CI sets AUDIT_WIN_PIPE_ACL=1 on windows-latest): needs an elevated shell to create a
 * throw-away local account. Without the variable the file is skipped, so a developer's `pnpm test`
 * never creates accounts.
 */
const enabled = process.platform === "win32" && process.env.AUDIT_WIN_PIPE_ACL === "1";

const silent: Logger = { info: () => {}, warn: () => {}, error: () => {} };

const PROBE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$src = @'
using System;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class AuditPipeProbe
{
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool LogonUser(string user, string domain, string password, int logonType, int provider, out IntPtr token);

    static string Open(string pipe, PipeDirection direction)
    {
        try
        {
            using (var c = new NamedPipeClientStream(".", pipe, direction, PipeOptions.None, TokenImpersonationLevel.None))
            {
                c.Connect(3000);
                return "opened";
            }
        }
        catch (UnauthorizedAccessException) { return "denied"; }
        catch (TimeoutException) { return "timeout"; }
        catch (Exception e) { return "error:" + e.GetType().Name + ":" + e.Message.Replace('\n', ' '); }
    }

    static string Dacl(string pipe)
    {
        try
        {
            using (var c = new NamedPipeClientStream(".", pipe, PipeAccessRights.ReadData | PipeAccessRights.ReadPermissions, PipeOptions.None, TokenImpersonationLevel.None, System.IO.HandleInheritability.None))
            {
                c.Connect(3000);
                PipeSecurity sec = PipesAclExtensions.GetAccessControl(c);
                var sb = new StringBuilder();
                sb.AppendLine("sddl=" + sec.GetSecurityDescriptorSddlForm(AccessControlSections.Access | AccessControlSections.Owner));
                foreach (PipeAccessRule r in sec.GetAccessRules(true, true, typeof(SecurityIdentifier)))
                {
                    string name;
                    try { name = r.IdentityReference.Translate(typeof(NTAccount)).Value; }
                    catch (Exception) { name = r.IdentityReference.Value; }
                    sb.AppendLine("ace=" + name + " " + r.AccessControlType + " " + r.PipeAccessRights);
                }
                return sb.ToString();
            }
        }
        catch (Exception e) { return "dacl_error=" + e.GetType().Name + ":" + e.Message.Replace('\n', ' ') + "\n"; }
    }

    public static string Run(string user, string password, string pipe)
    {
        var sb = new StringBuilder();
        sb.AppendLine("self=" + WindowsIdentity.GetCurrent().Name);
        sb.AppendLine("self_inout=" + Open(pipe, PipeDirection.InOut));
        sb.Append(Dacl(pipe));

        IntPtr raw = IntPtr.Zero;
        string logonError = null;
        foreach (int type in new int[] { 3, 2 })
        {
            if (LogonUser(user, ".", password, type, 0, out raw)) { logonError = null; sb.AppendLine("logon_type=" + type); break; }
            logonError = "logon-failed:type" + type + ":win32=" + Marshal.GetLastWin32Error();
        }
        if (logonError != null) { sb.AppendLine("other_error=" + logonError); return sb.ToString(); }

        try
        {
            using (var token = new SafeAccessTokenHandle(raw))
            {
                WindowsIdentity.RunImpersonated(token, () =>
                {
                    sb.AppendLine("other_as=" + WindowsIdentity.GetCurrent().Name);
                    sb.AppendLine("other_inout=" + Open(pipe, PipeDirection.InOut));
                    sb.AppendLine("other_out=" + Open(pipe, PipeDirection.Out));
                    sb.AppendLine("other_in=" + Open(pipe, PipeDirection.In));
                });
            }
        }
        catch (Exception e) { sb.AppendLine("other_error=" + e.GetType().Name + ":" + e.Message.Replace('\n', ' ')); }
        return sb.ToString();
    }
}
'@
Add-Type -TypeDefinition $src
[AuditPipeProbe]::Run($env:AUDIT_PROBE_USER, $env:AUDIT_PROBE_PASSWORD, $env:AUDIT_PROBE_PIPE)
`;

/** Never put argv in a thrown message: it would carry the account password into the public CI log. */
function run(command: string, args: string[], what: string, env?: NodeJS.ProcessEnv): string {
  const r = spawnSync(command, args, { encoding: "utf8", env, timeout: 90_000 });
  if (r.error || r.status !== 0) {
    const detail = r.error ? r.error.message : `exit ${r.status}`;
    throw new Error(`${what} failed (${detail})\n${r.stdout ?? ""}\n${r.stderr ?? ""}`.trim());
  }
  return r.stdout;
}

function parse(output: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of output.split(/\r?\n/)) {
    const eq = line.indexOf("=");
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

const open: IpcServer[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});

describe.skipIf(!enabled)("Windows named pipe: another local account", () => {
  it("cannot open the daemon's pipe for writing", { timeout: 120_000 }, async () => {
    const server = await startIpcServer({
      endpoint: generateEndpoint(),
      token: generateToken(),
      handlers: {},
      log: silent,
    });
    open.push(server);
    const pipeName = server.endpoint.replace(/^\\\\\.\\pipe\\/, "");

    const user = `auditpipe${randomBytes(3).toString("hex")}`;
    // At most 14 characters: a longer password makes `net user` stop and ask for confirmation.
    const password = `Aa1!${randomBytes(5).toString("hex")}`;
    let output: string;
    try {
      run(
        "net",
        ["user", user, password, "/add", "/y"],
        "creating the local test account (needs an elevated shell)",
      );
      output = run(
        "pwsh",
        [
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(PROBE_SCRIPT, "utf16le").toString("base64"),
        ],
        "the named pipe probe",
        {
          ...process.env,
          AUDIT_PROBE_USER: user,
          AUDIT_PROBE_PASSWORD: password,
          AUDIT_PROBE_PIPE: pipeName,
        },
      );
    } finally {
      spawnSync("net", ["user", user, "/delete"], { stdio: "ignore", timeout: 30_000 });
    }

    // The evidence goes to the CI log before any assertion, so a red run is diagnosable in one pass.
    console.log(`named pipe access report\n${output}`);
    const r = parse(output);

    // Control: the probe itself works when run as the daemon's own account.
    expect(r.self_inout, "the daemon's own account must be able to open the pipe").toBe("opened");
    // The second account was really impersonated, not silently the same user.
    expect(r.other_error, "could not log on as the test account").toBeUndefined();
    expect((r.other_as ?? "").toLowerCase()).toContain(user.toLowerCase());
    // The requirement: another local account cannot send anything to the daemon.
    expect(r.other_inout).toBe("denied");
    expect(r.other_out).toBe("denied");
    // other_in (read-only open) is reported, not asserted: the daemon writes nothing unsolicited.
  });
});
