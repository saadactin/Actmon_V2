using System.Diagnostics;
using System.Management;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.ServiceProcess;
using ActMon.Setup.Core.Models;

namespace ActMon.Setup.Core.Services;

/// <summary>
/// Real, synchronous-where-cheap / async-where-slow checks for section 5 of the
/// installer spec ("System Requirements Pre-check"). Every check here inspects
/// actual machine state — nothing is assumed or hardcoded true.
/// </summary>
public sealed class SystemRequirementsChecker
{
    public const int MinCpuCores = 4;
    public const double MinRamGb = 8.0;

    // Measured directly: the actual deployed footprint (database backend,
    // cloud backend, db-setup, nginx, frontend, agent installers,
    // ServiceHost) totals ~950 MB. MinFreeDiskGb is that plus real margin
    // for the copy itself and initial logs/config — not a speculative
    // number for months of future monitoring-data growth, which is an
    // operational concern for the admin to monitor later, not an install
    // prerequisite. WarnFreeDiskGb is a soft, non-blocking heads-up only.
    public const double MinFreeDiskGb = 2.0;
    public const double WarnFreeDiskGb = 5.0;

    public async Task<IReadOnlyList<CheckResult>> RunAllAsync(string installDrive, CancellationToken ct = default)
    {
        var results = new List<CheckResult>
        {
            CheckOperatingSystem(),
            CheckArchitecture(),
            CheckCpu(),
            CheckRam(),
            CheckDisk(installDrive),
            CheckAdministrator(),
            CheckWindowsServicesAvailable(),
            CheckWsl2Support(),
            CheckVcRedist(),
            await CheckInternetConnectivityAsync(ct),
            CheckFirewallStatus(),
        };
        return results;
    }

    /// <summary>Detects the exact OS (edition, build, architecture) via
    /// <see cref="OsDetector"/> and turns it into a single clear Compatible /
    /// Not Compatible verdict — never the generic "not Windows Server" wording
    /// a supported client edition would otherwise get lumped into.</summary>
    private static CheckResult CheckOperatingSystem()
    {
        try
        {
            var os = OsDetector.Detect();
            // DisplayVersion (derived from the build number) rather than the raw
            // registry Caption — ProductName is known to lag behind on machines
            // upgraded in place (e.g. a genuine Windows 11 install whose registry
            // still says "Windows 10 Pro"); the build number is authoritative.
            var label = $"{os.DisplayVersion} {os.Edition}, {os.Architecture}, build {os.FullBuildString}";

            if (!os.IsSupported)
            {
                return new CheckResult
                {
                    Requirement = "Operating System",
                    Status = CheckStatus.Required,
                    Details = $"{label} — Not Compatible",
                    BlockingReason = os.UnsupportedReason ?? "This Windows version is not supported by ActMon.",
                };
            }

            return new CheckResult
            {
                Requirement = "Operating System",
                Status = CheckStatus.Ready,
                Details = $"{label} — Compatible ({(os.IsServer ? "Windows Server" : "Windows client")})",
            };
        }
        catch (Exception ex)
        {
            return new CheckResult
            {
                Requirement = "Operating System",
                Status = CheckStatus.Warning,
                Details = $"Could not determine OS version ({ex.Message})",
            };
        }
    }

    /// <summary>Redis and ClickHouse are provisioned inside WSL2 + Ubuntu
    /// (<see cref="WslDependencyInstaller"/>) on both Windows client and
    /// Windows Server — but Server editions never ship the Store-backed `wsl
    /// --install` path, so this only checks that WSL2 itself is reachable
    /// (already enabled, or enablable at Install time via DISM on Server /
    /// `wsl --install` on client) rather than assuming one universal command
    /// works everywhere.</summary>
    private static CheckResult CheckWsl2Support()
    {
        try
        {
            var os = OsDetector.Detect();
            if (WslDependencyInstaller.IsWslAlreadyAvailable())
            {
                return new CheckResult { Requirement = "WSL2 (for Redis/ClickHouse)", Status = CheckStatus.Ready, Details = "WSL2 is already enabled on this machine." };
            }

            var howToEnable = os.IsServer
                ? "will be enabled via DISM (Microsoft-Windows-Subsystem-Linux, VirtualMachinePlatform) during Install — a reboot may be required first"
                : "will be enabled via \"wsl --install\" during Install";
            return new CheckResult
            {
                Requirement = "WSL2 (for Redis/ClickHouse)",
                Status = CheckStatus.Warning,
                Details = $"Not yet enabled — {howToEnable}.",
            };
        }
        catch (Exception ex)
        {
            return new CheckResult { Requirement = "WSL2 (for Redis/ClickHouse)", Status = CheckStatus.Warning, Details = $"Could not check WSL2 status ({ex.Message})" };
        }
    }

    private static CheckResult CheckArchitecture()
    {
        // Is64BitOperatingSystem is also true on ARM64 — but PostgreSQL,
        // ClickHouse and ActMon's own backends are all shipped as native x64
        // binaries, so ARM64 is called out explicitly rather than accepted as
        // "64-bit and therefore fine".
        var arch = RuntimeInformation.OSArchitecture;
        var isX64 = arch == Architecture.X64;
        return new CheckResult
        {
            Requirement = "CPU architecture",
            Status = isX64 ? CheckStatus.Ready : CheckStatus.Required,
            Details = isX64 ? "x64" : $"{arch} detected — not x64",
            BlockingReason = isX64 ? null : "ActMon's bundled components (PostgreSQL, ClickHouse, backends) are x64-only. ARM64 Windows can run them under emulation, but this is not supported.",
        };
    }

    private static CheckResult CheckCpu()
    {
        var cores = Environment.ProcessorCount;
        string name = "Unknown CPU";
        try
        {
            using var searcher = new ManagementObjectSearcher("SELECT Name FROM Win32_Processor");
            foreach (ManagementObject cpu in searcher.Get())
            {
                name = (cpu["Name"] as string)?.Trim() ?? name;
                break;
            }
        }
        catch { /* WMI unavailable — fall back to core count only */ }

        var ok = cores >= MinCpuCores;
        return new CheckResult
        {
            Requirement = "CPU",
            Status = ok ? CheckStatus.Ready : CheckStatus.Warning,
            Details = $"{name} — {cores} logical processors" + (ok ? "" : $" (recommended: {MinCpuCores}+)"),
        };
    }

    private static CheckResult CheckRam()
    {
        try
        {
            using var searcher = new ManagementObjectSearcher("SELECT TotalVisibleMemorySize FROM Win32_OperatingSystem");
            foreach (ManagementObject os in searcher.Get())
            {
                var kb = Convert.ToUInt64(os["TotalVisibleMemorySize"]);
                var gb = kb / 1024.0 / 1024.0;
                var ok = gb >= MinRamGb;
                return new CheckResult
                {
                    Requirement = "RAM",
                    Status = ok ? CheckStatus.Ready : CheckStatus.Warning,
                    Details = $"{gb:F1} GB" + (ok ? "" : $" (recommended: {MinRamGb:F0}+ GB — PostgreSQL, Redis/WSL2, ClickHouse and the ActMon services all run on this box)"),
                };
            }
        }
        catch (Exception ex)
        {
            return new CheckResult { Requirement = "RAM", Status = CheckStatus.Warning, Details = $"Could not determine RAM ({ex.Message})" };
        }

        return new CheckResult { Requirement = "RAM", Status = CheckStatus.Warning, Details = "Could not determine RAM" };
    }

    private static CheckResult CheckDisk(string installDrive)
    {
        try
        {
            var root = Path.GetPathRoot(installDrive) ?? "C:\\";
            var drive = new DriveInfo(root);
            var freeGb = drive.AvailableFreeSpace / 1024.0 / 1024.0 / 1024.0;

            if (freeGb < MinFreeDiskGb)
            {
                return new CheckResult
                {
                    Requirement = "Available disk space",
                    Status = CheckStatus.Required,
                    Details = $"{freeGb:F1} GB free on {root}",
                    BlockingReason = $"At least {MinFreeDiskGb:F0} GB free is required on {root} for ActMon, PostgreSQL and ClickHouse data.",
                };
            }

            var warn = freeGb < WarnFreeDiskGb;
            return new CheckResult
            {
                Requirement = "Available disk space",
                Status = warn ? CheckStatus.Warning : CheckStatus.Ready,
                Details = $"{freeGb:F1} GB free on {root}" + (warn ? $" (comfortable headroom is {WarnFreeDiskGb:F0}+ GB once monitoring data accumulates)" : ""),
            };
        }
        catch (Exception ex)
        {
            return new CheckResult { Requirement = "Available disk space", Status = CheckStatus.Warning, Details = $"Could not check disk space ({ex.Message})" };
        }
    }

    private static CheckResult CheckAdministrator()
    {
        using var identity = WindowsIdentity.GetCurrent();
        var principal = new WindowsPrincipal(identity);
        var isAdmin = principal.IsInRole(WindowsBuiltInRole.Administrator);
        return new CheckResult
        {
            Requirement = "Administrator privileges",
            Status = isAdmin ? CheckStatus.Ready : CheckStatus.Required,
            Details = isAdmin ? $"Running elevated as {identity.Name}" : $"Running as {identity.Name} (not elevated)",
            BlockingReason = isAdmin ? null : "Re-launch the installer with \"Run as administrator\" — it needs to create services, firewall rules and install dependencies.",
        };
    }

    private static CheckResult CheckWindowsServicesAvailable()
    {
        try
        {
            using var sc = new ServiceController("Winmgmt");
            _ = sc.Status; // throws if the SCM itself is unreachable
            return new CheckResult { Requirement = "Windows Services", Status = CheckStatus.Ready, Details = "Service Control Manager accessible" };
        }
        catch (Exception ex)
        {
            return new CheckResult
            {
                Requirement = "Windows Services",
                Status = CheckStatus.Required,
                Details = $"Service Control Manager unreachable ({ex.Message})",
                BlockingReason = "ActMon runs as Windows Services — the Service Control Manager must be reachable.",
            };
        }
    }

    private static CheckResult CheckVcRedist()
    {
        // PostgreSQL's and ClickHouse's official Windows builds both depend on the
        // VC++ 2015-2022 x64 runtime. Its presence is recorded under this key by
        // Microsoft's own redistributable installer.
        const string keyPath = @"SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\X64";
        try
        {
            using var key = Microsoft.Win32.Registry.LocalMachine.OpenSubKey(keyPath);
            var installed = key?.GetValue("Installed") is int i && i == 1;
            var version = key?.GetValue("Version") as string;
            return new CheckResult
            {
                Requirement = "Visual C++ Redistributable (x64)",
                Status = installed ? CheckStatus.Ready : CheckStatus.Warning,
                Details = installed ? $"Installed ({version})" : "Not detected — will be installed automatically if PostgreSQL/ClickHouse need it",
            };
        }
        catch (Exception ex)
        {
            return new CheckResult { Requirement = "Visual C++ Redistributable (x64)", Status = CheckStatus.Warning, Details = $"Could not check ({ex.Message})" };
        }
    }

    private static async Task<CheckResult> CheckInternetConnectivityAsync(CancellationToken ct)
    {
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
        try
        {
            using var response = await http.GetAsync("https://www.microsoft.com/favicon.ico", HttpCompletionOption.ResponseHeadersRead, ct);
            return new CheckResult
            {
                Requirement = "Internet connectivity",
                Status = CheckStatus.Ready,
                Details = "Reachable — needed to download PostgreSQL/ClickHouse/WSL2 Ubuntu if not already installed",
            };
        }
        catch (Exception ex)
        {
            return new CheckResult
            {
                Requirement = "Internet connectivity",
                Status = CheckStatus.Warning,
                Details = $"Not reachable ({ex.GetType().Name}) — dependency installers cannot be downloaded; already-installed dependencies can still be detected and reused",
            };
        }
    }

    private static CheckResult CheckFirewallStatus()
    {
        try
        {
            var psi = new ProcessStartInfo("netsh", "advfirewall show allprofiles state")
            {
                RedirectStandardOutput = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            using var proc = Process.Start(psi)!;
            var output = proc.StandardOutput.ReadToEnd();
            proc.WaitForExit(5000);

            var onCount = output.Split('\n').Count(l => l.TrimStart().StartsWith("State", StringComparison.OrdinalIgnoreCase) && l.Contains("ON", StringComparison.OrdinalIgnoreCase));
            return new CheckResult
            {
                Requirement = "Windows Firewall",
                Status = CheckStatus.Ready,
                Details = onCount > 0 ? $"Active on {onCount} profile(s) — ActMon's ports will need explicit allow rules" : "Firewall appears disabled on all profiles",
            };
        }
        catch (Exception ex)
        {
            return new CheckResult { Requirement = "Windows Firewall", Status = CheckStatus.Warning, Details = $"Could not query firewall state ({ex.Message})" };
        }
    }
}
