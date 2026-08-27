using System.Diagnostics;
using System.Net.Http;
using System.ServiceProcess;
using ActMon.Setup.Core.Models;
using Microsoft.Win32;

namespace ActMon.Setup.Core.Services;

/// <summary>
/// Real detection for section 6 (Dependency Pre-check) — PostgreSQL and ClickHouse
/// as native Windows services, Redis via WSL2 + Ubuntu (the free, license-clean
/// path the user chose over Memurai). Every method inspects actual machine state;
/// nothing here assumes a dependency is present or absent.
/// </summary>
public sealed class DependencyDetector
{
    public Task<DependencyStatus> DetectPostgreSqlAsync() => Task.Run(() =>
    {
        var svc = FindService(name => name.StartsWith("postgresql", StringComparison.OrdinalIgnoreCase));
        if (svc is null)
        {
            return new DependencyStatus
            {
                Name = "PostgreSQL",
                State = DependencyState.NotInstalled,
                Details = "No PostgreSQL Windows service detected.",
            };
        }

        var (path, version) = ResolvePostgresBinary(svc.ServiceName);
        return new DependencyStatus
        {
            Name = "PostgreSQL",
            State = DependencyState.Installed,
            Version = version,
            InstallPath = path,
            ServiceStatus = svc.Status.ToString(),
            Details = $"Service '{svc.ServiceName}' — {svc.Status}" + (version is not null ? $", version {version}" : ""),
        };
    });

    public Task<DependencyStatus> DetectClickHouseAsync() => Task.Run(async () =>
    {
        var svc = FindService(name => name.Contains("clickhouse", StringComparison.OrdinalIgnoreCase));

        // A service entry proves it's installed even if stopped; a live HTTP ping
        // proves it's actually reachable right now — both are worth reporting.
        var reachable = await PingHttpAsync("http://127.0.0.1:8123/ping");

        if (svc is null && !reachable)
        {
            return new DependencyStatus
            {
                Name = "ClickHouse",
                State = DependencyState.NotInstalled,
                Details = "No ClickHouse Windows service detected, and http://127.0.0.1:8123 is not responding.",
            };
        }

        return new DependencyStatus
        {
            Name = "ClickHouse",
            State = DependencyState.Installed,
            ServiceStatus = svc?.Status.ToString(),
            Details = svc is not null
                ? $"Service '{svc.ServiceName}' — {svc.Status}" + (reachable ? ", HTTP interface responding on :8123" : "")
                : "HTTP interface responding on :8123 (running outside a Windows service)",
        };
    });

    public Task<DependencyStatus> DetectRedisViaWslAsync() => Task.Run(() =>
    {
        if (!TryRunWsl(null, "--status", out var statusOut, out _, TimeSpan.FromSeconds(5)) || string.IsNullOrWhiteSpace(statusOut))
        {
            return new DependencyStatus
            {
                Name = "Redis (via WSL2 + Ubuntu)",
                State = DependencyState.NotInstalled,
                Details = "WSL2 is not installed or not enabled on this machine.",
            };
        }

        if (!TryRunWsl(null, "-l -v", out var listOut, out _, TimeSpan.FromSeconds(5)) ||
            !listOut.Contains("Ubuntu", StringComparison.OrdinalIgnoreCase))
        {
            return new DependencyStatus
            {
                Name = "Redis (via WSL2 + Ubuntu)",
                State = DependencyState.NotInstalled,
                Details = "WSL2 is enabled, but no Ubuntu distribution is registered yet.",
            };
        }

        var hasVersion = TryRunWsl("Ubuntu", "-- redis-server --version", out var verOut, out _, TimeSpan.FromSeconds(8));
        if (!hasVersion || string.IsNullOrWhiteSpace(verOut))
        {
            return new DependencyStatus
            {
                Name = "Redis (via WSL2 + Ubuntu)",
                State = DependencyState.NotInstalled,
                Details = "WSL2 Ubuntu is present, but redis-server is not installed inside it.",
            };
        }

        TryRunWsl("Ubuntu", "-- redis-cli ping", out var pingOut, out _, TimeSpan.FromSeconds(8));
        var alive = pingOut.Trim().Equals("PONG", StringComparison.OrdinalIgnoreCase);

        return new DependencyStatus
        {
            Name = "Redis (via WSL2 + Ubuntu)",
            State = DependencyState.Installed,
            Version = verOut.Trim(),
            ServiceStatus = alive ? "Running" : "Installed, not responding",
            Details = alive ? "redis-cli ping → PONG" : "Installed inside WSL2 Ubuntu, but not currently responding to PING",
        };
    });

    private static ServiceController? FindService(Func<string, bool> nameMatches)
    {
        try
        {
            return ServiceController.GetServices().FirstOrDefault(s => nameMatches(s.ServiceName));
        }
        catch
        {
            return null;
        }
    }

    private static (string? path, string? version) ResolvePostgresBinary(string serviceName)
    {
        try
        {
            using var key = Registry.LocalMachine.OpenSubKey($@"SYSTEM\CurrentControlSet\Services\{serviceName}");
            var imagePath = key?.GetValue("ImagePath") as string;
            if (string.IsNullOrWhiteSpace(imagePath)) return (null, null);

            // ImagePath looks like: "C:\Program Files\PostgreSQL\17\bin\pg_ctl.exe" runservice -N ... -D "...\data"
            var exePath = imagePath.TrimStart('"').Split('"')[0];
            var binDir = Path.GetDirectoryName(exePath);
            var installDir = binDir is not null ? Path.GetDirectoryName(binDir) : null; // .../PostgreSQL/17
            var version = installDir is not null ? Path.GetFileName(installDir) : null;
            return (installDir, version);
        }
        catch
        {
            return (null, null);
        }
    }

    private static async Task<bool> PingHttpAsync(string url)
    {
        try
        {
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(3) };
            using var resp = await http.GetAsync(url);
            return resp.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    private static bool TryRunWsl(string? distro, string args, out string stdout, out string stderr, TimeSpan timeout)
    {
        stdout = "";
        stderr = "";
        try
        {
            var fullArgs = distro is null ? args : $"-d {distro} {args}";
            var psi = new ProcessStartInfo("wsl.exe", fullArgs)
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
                StandardOutputEncoding = System.Text.Encoding.Unicode,
                StandardErrorEncoding = System.Text.Encoding.Unicode,
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
