using System.Diagnostics;
using System.Text;

namespace ActMon.Setup.Core.Services;

/// <summary>
/// Provisions Redis and ClickHouse inside WSL2 + Ubuntu (sections 10-11's
/// "Install" actions) — the free, license-clean path the user chose over paid
/// Windows-native alternatives, and, for ClickHouse specifically, the only
/// genuinely stable distribution channel (ClickHouse has no officially
/// supported Windows build — confirmed directly: its GitHub releases carry no
/// Windows asset, and the CI-built windows-x86-64 binary isn't reliably
/// published). Both packages are installed the same way this dev machine
/// already has them: via apt, inside the same Ubuntu distro as Redis.
/// </summary>
public sealed class WslDependencyInstaller
{
    private const string Distro = "Ubuntu";

    public Task<(bool ready, string message)> EnsureWslPlatformAsync(Action<string> onProgress) => Task.Run(() =>
    {
        if (IsWslAlreadyAvailable())
            return (true, "WSL2 is already enabled.");

        // Windows Server SKUs don't carry the Store-backed inbox updater that
        // `wsl --install` depends on (confirmed directly: it fails outright on
        // Server with no Store present), so the underlying optional Windows
        // features are enabled directly via DISM instead — the one place WSL2
        // setup genuinely needs to branch between Windows client and Server.
        var isServer = OsDetector.Detect().IsServer;
        var installed = isServer
            ? EnableWslFeaturesViaDism(onProgress)
            : RunClientWslInstall(onProgress, out _);

        // `wsl --install`/DISM can report failure on a machine where WSL2 is
        // already fully working — confirmed directly: `wsl --status` failed
        // here (this installer always runs elevated, and wsl.exe is known to
        // behave inconsistently under an elevated token versus a normal shell
        // for the same user) while `wsl -l -v` correctly showed Ubuntu already
        // Running. A real distro listing is the actual source of truth, not
        // either command's exit code, so re-check before believing failure.
        if (!installed && IsWslAlreadyAvailable())
            installed = true;

        if (!installed)
            return (false, isServer
                ? "Could not enable the WSL2 platform via DISM (Microsoft-Windows-Subsystem-Linux / VirtualMachinePlatform). Enable these Windows features manually, reboot, then re-run this installer."
                : "Could not enable WSL2 via \"wsl --install\". A reboot may be required, then re-run this installer.");

        // Enabling the underlying Windows features (Microsoft-Windows-Subsystem-Linux,
        // VirtualMachinePlatform) for the first time on this machine always needs a
        // reboot before any distro can actually run — there is no way around that.
        if (!IsWslAlreadyAvailable())
            return (false, "WSL2 was enabled but this machine must be restarted before continuing. Restart, then re-run this installer.");

        return (true, "WSL2 enabled.");
    });

    /// <summary>`wsl --status`'s exit code alone isn't reliable evidence WSL2
    /// is unavailable — confirmed directly: on a machine with WSL2 + Ubuntu
    /// already fully working, `--status` reported failure when invoked from
    /// this (always-elevated) installer, while `wsl -l -v` still correctly
    /// showed Ubuntu Running. A real distro listing is the actual source of
    /// truth. Public/static so SystemRequirementsChecker's own WSL2 row uses
    /// the exact same, more reliable check instead of duplicating the gap.</summary>
    public static bool IsWslAlreadyAvailable()
    {
        if (RunWsl(null, null, "--status", out _, out _, TimeSpan.FromSeconds(8))) return true;
        return RunWsl(null, null, "-l -v", out var listOut, out _, TimeSpan.FromSeconds(8)) && listOut.Trim().Length > 0;
    }

    private static bool RunClientWslInstall(Action<string> onProgress, out string output)
    {
        onProgress("Enabling the WSL2 platform (no distro yet)...");
        var ok = RunWsl(null, null, "--install --no-distribution", out var stdout, out var stderr, TimeSpan.FromMinutes(5));
        output = stdout + stderr;
        return ok;
    }

    private static bool EnableWslFeaturesViaDism(Action<string> onProgress)
    {
        onProgress("Enabling WSL2 Windows features via DISM (Windows Server)...");
        var wsl = RunDism("/online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart");
        var vmp = RunDism("/online /enable-feature /featurename:VirtualMachinePlatform /all /norestart");
        // DISM's own exit code 3010 means "succeeded, reboot required" — still a
        // success from this installer's point of view (the reboot is handled by
        // the --status re-check right after this call returns).
        return wsl is 0 or 3010 && vmp is 0 or 3010;
    }

    private static int RunDism(string args)
    {
        try
        {
            var psi = new ProcessStartInfo("dism.exe", args) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
            using var proc = Process.Start(psi);
            if (proc is null) return -1;
            proc.WaitForExit((int)TimeSpan.FromMinutes(5).TotalMilliseconds);
            return proc.ExitCode;
        }
        catch
        {
            return -1;
        }
    }

    public Task<(bool ready, string message)> EnsureUbuntuAsync(Action<string> onProgress) => Task.Run(() =>
    {
        if (RunWsl(null, null, "-l -v", out var listOut, out _, TimeSpan.FromSeconds(8)) && listOut.Contains(Distro, StringComparison.OrdinalIgnoreCase))
            return (true, "Ubuntu is already registered.");

        onProgress("Installing Ubuntu under WSL2 (this can take a few minutes)...");
        var installed = RunWsl(null, null, $"--install -d {Distro} --no-launch", out var stdout, out var stderr, TimeSpan.FromMinutes(10));
        if (!installed)
            return (false, $"Could not install the Ubuntu distribution.\n{stdout}\n{stderr}");

        return (true, "Ubuntu installed.");
    });

    // Suppresses every interactive apt/dpkg prompt (package selections, conffile
    // conflicts) — without this, a conffile prompt (e.g. a locally-modified
    // config.xml) blocks on stdin forever in a non-interactive installer,
    // confirmed directly against this exact ClickHouse conffile conflict.
    private const string AptNonInteractive =
        "export DEBIAN_FRONTEND=noninteractive; " +
        "APT_OPTS='-o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold'; ";

    public async Task<(bool success, string message)> InstallRedisAsync(Action<string> onProgress)
    {
        onProgress("Installing Redis inside WSL2 Ubuntu...");
        var script = AptNonInteractive +
                     "apt-get update && apt-get install -y $APT_OPTS redis-server && " +
                     "sed -i 's/^bind .*/bind 0.0.0.0 -::1/' /etc/redis/redis.conf && " +
                     "systemctl enable --now redis-server";
        return await RunAsRootAsync(script);
    }

    public async Task<(bool success, string message)> InstallClickHouseAsync(Action<string> onProgress)
    {
        onProgress("Installing ClickHouse inside WSL2 Ubuntu...");
        // Only add the keyring/repo if neither is already there — this distro
        // may already have ClickHouse's apt source configured (confirmed
        // directly: re-adding it duplicated the source and produced a GPG
        // NO_PUBKEY failure against the install that was already trusted).
        var script = AptNonInteractive +
            "test -f /etc/apt/sources.list.d/clickhouse.list || " +
            "(curl -fsSL https://packages.clickhouse.com/deb/pool/main/c/clickhouse-keyring/clickhouse-keyring_1.0_all.deb -o /tmp/clickhouse-keyring.deb && " +
            "dpkg -i /tmp/clickhouse-keyring.deb && " +
            "echo 'deb https://packages.clickhouse.com/deb stable main' > /etc/apt/sources.list.d/clickhouse.list); " +
            "apt-get update && apt-get install -y $APT_OPTS clickhouse-server clickhouse-client && " +
            "systemctl enable --now clickhouse-server";
        return await RunAsRootAsync(script);
    }

    /// <summary>
    /// Runs a provisioning script as root inside the distro via `wsl -u root`,
    /// never via `sudo` — a freshly registered WSL2 Ubuntu distro's own default
    /// user has no passwordless sudo (confirmed directly: `sudo -n true` fails
    /// with "interactive authentication is required"), which would otherwise
    /// hang this non-interactive installer forever waiting for a password on
    /// stdin that can never arrive. Running as root via WSL's own `-u` flag
    /// needs no password at all.
    /// </summary>
    private Task<(bool success, string message)> RunAsRootAsync(string script) => Task.Run(() =>
    {
        // systemd (needed for `systemctl enable --now`) only runs inside a WSL2
        // distro when /etc/wsl.conf opts in — recent Ubuntu images default this
        // on, but ensure it explicitly so this doesn't silently no-op on an
        // older/imported image.
        RunWsl(Distro, "root", "-- bash -lc \"grep -q '^systemd=true' /etc/wsl.conf 2>/dev/null || printf '[boot]\\nsystemd=true\\n' >> /etc/wsl.conf\"",
            out _, out _, TimeSpan.FromSeconds(15));

        var ok = RunWsl(Distro, "root", $"-- bash -lc \"{script}\"", out var stdout, out var stderr, TimeSpan.FromMinutes(10));
        return (ok, ok ? "Installed." : stdout + stderr);
    });

    private static bool RunWsl(string? distro, string? user, string args, out string stdout, out string stderr, TimeSpan timeout)
    {
        stdout = "";
        stderr = "";
        try
        {
            var fullArgs = distro is null ? args : user is null ? $"-d {distro} {args}" : $"-d {distro} -u {user} {args}";

            // wsl.exe's OWN generated text (--status, -l -v with no inner command)
            // comes out UTF-16LE when redirected; actual output PASSED THROUGH from
            // a real command running inside the distro (`-- bash -lc "..."`) is the
            // Linux process's own UTF-8 — forcing Unicode decoding on that produces
            // mojibake (confirmed directly against real apt-get/dpkg output).
            var isInnerCommand = args.Contains("--", StringComparison.Ordinal);
            var encoding = isInnerCommand ? Encoding.UTF8 : Encoding.Unicode;

            var psi = new ProcessStartInfo("wsl.exe", fullArgs)
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
                StandardOutputEncoding = encoding,
                StandardErrorEncoding = encoding,
            };
            using var proc = Process.Start(psi);
            if (proc is null) return false;

            if (!proc.WaitForExit((int)timeout.TotalMilliseconds))
            {
                try { proc.Kill(true); } catch { /* best effort */ }
                return false;
            }

            stdout = proc.StandardOutput.ReadToEnd();
            stderr = proc.StandardError.ReadToEnd();
            return proc.ExitCode == 0;
        }
        catch
        {
            return false;
        }
    }
}
