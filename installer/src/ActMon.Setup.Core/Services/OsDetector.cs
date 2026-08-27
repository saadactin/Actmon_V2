using System.Management;
using System.Runtime.InteropServices;
using ActMon.Setup.Core.Models;
using Microsoft.Win32;

namespace ActMon.Setup.Core.Services;

/// <summary>
/// Single source of truth for "which Windows is this, exactly, and is it one
/// ActMon supports" — used by the System Requirements page (to show a clear
/// Compatible/Not Compatible verdict with the detected OS and build) and by any
/// service whose own behavior legitimately differs between a Windows client
/// edition and Windows Server (WSL2 enablement being the main one; Services,
/// firewall rules, ACLs and paths are all identical Win32/sc.exe/netsh calls on
/// both, so nothing else needs to branch on this).
///
/// Registry (HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion) is read for the
/// exact build/UBR/edition — Win32_OperatingSystem's own Version/Caption strings
/// are the same across several distinct Windows 10/11 builds and don't expose
/// UBR (the revision number, e.g. the ".3737" in 22631.3737) at all. WMI is only
/// used for ProductType, which is the one field that reliably tells client apart
/// from server/domain-controller.
/// </summary>
public static class OsDetector
{
    private const string CurrentVersionKey = @"SOFTWARE\Microsoft\Windows NT\CurrentVersion";

    // Lowest build accepted per family. Windows 11 and Server builds are, by
    // definition, never below their own family's first release, so only the
    // Windows 10 floor is meaningful here — set at 1809 (17763), the oldest
    // still-serviced channel (LTSC 2019) as of this writing. Older Windows 10
    // builds (and anything pre-Windows 10) are long past end of service.
    private const int MinWindows10Build = 17763;
    private const int MinWindows11Build = 22000;
    private const int MinServerBuild = 14393; // Windows Server 2016

    public static OsCompatibilityInfo Detect()
    {
        var (build, ubr, major) = ReadVersionFromRegistry();
        var caption = ReadRegistryString("ProductName") ?? "Unknown Windows";
        var editionId = ReadRegistryString("EditionID") ?? "Unknown";
        var isServerProduct = DetectIsServerViaWmi(caption, editionId);

        var family = isServerProduct
            ? WindowsProductFamily.WindowsServer
            : build >= MinWindows11Build
                ? WindowsProductFamily.Windows11Client
                : WindowsProductFamily.Windows10Client;

        var (isSupported, reason) = Evaluate(family, major, build);

        return new OsCompatibilityInfo
        {
            Caption = caption,
            Edition = FriendlyEdition(editionId),
            Family = family,
            Major = major,
            Build = build,
            Ubr = ubr,
            Architecture = DetectArchitecture(),
            IsSupported = isSupported,
            UnsupportedReason = reason,
        };
    }

    private static (bool isSupported, string? reason) Evaluate(WindowsProductFamily family, int major, int build)
    {
        if (major < 10 || build == 0)
            return (false, "ActMon requires Windows 10 (1809 or later), Windows 11, or Windows Server 2016 or later.");

        return family switch
        {
            WindowsProductFamily.Windows10Client when build < MinWindows10Build =>
                (false, $"This Windows 10 build ({build}) is older than the oldest ActMon supports (1809 / build {MinWindows10Build}). Update Windows or use a supported release."),
            WindowsProductFamily.WindowsServer when build < MinServerBuild =>
                (false, $"This Windows Server build ({build}) is older than Windows Server 2016 (build {MinServerBuild}), the oldest ActMon supports."),
            WindowsProductFamily.Windows10Client or WindowsProductFamily.Windows11Client or WindowsProductFamily.WindowsServer => (true, null),
            _ => (false, "Could not positively identify this Windows edition as one ActMon supports."),
        };
    }

    private static string FriendlyEdition(string editionId) => editionId switch
    {
        "Core" => "Home",
        "CoreN" => "Home N",
        "Professional" => "Pro",
        "ProfessionalN" => "Pro N",
        "ProfessionalWorkstation" => "Pro for Workstations",
        "Enterprise" => "Enterprise",
        "EnterpriseS" => "Enterprise LTSC",
        "Education" => "Education",
        "ServerStandard" => "Standard",
        "ServerStandardCore" => "Standard (Core)",
        "ServerDatacenter" => "Datacenter",
        "ServerDatacenterCore" => "Datacenter (Core)",
        "ServerDatacenterAzure" => "Datacenter: Azure Edition",
        _ => editionId,
    };

    private static bool DetectIsServerViaWmi(string caption, string editionId)
    {
        try
        {
            using var searcher = new ManagementObjectSearcher("SELECT ProductType FROM Win32_OperatingSystem");
            foreach (ManagementObject os in searcher.Get())
            {
                var productType = Convert.ToInt32(os["ProductType"] ?? 1);
                return productType is 2 or 3; // 1 = workstation, 2 = domain controller, 3 = server
            }
        }
        catch { /* fall through to the string-based fallback below */ }

        return caption.Contains("Server", StringComparison.OrdinalIgnoreCase)
            || editionId.StartsWith("Server", StringComparison.OrdinalIgnoreCase);
    }

    private static string DetectArchitecture() => RuntimeInformation.OSArchitecture switch
    {
        Architecture.X64 => "x64",
        Architecture.Arm64 => "ARM64",
        Architecture.X86 => "x86 (32-bit)",
        var other => other.ToString(),
    };

    private static (int build, int ubr, int major) ReadVersionFromRegistry()
    {
        // CurrentMajorVersionNumber is a REG_DWORD, not a string — reading it
        // with the string-valued helper (an `as string` cast) always returned
        // null, silently falling back to the legacy CurrentVersion string
        // (REG_SZ, frozen at "6.3" on every modern Windows 10/11 machine for
        // app-compat reasons) and reporting major=6 on every real Windows
        // 10/11/Server install — which then failed the "major < 10" gate below
        // regardless of how new the actual build was. Confirmed directly: a
        // genuine Windows 10 22H2 install (build 26200) was misreported as
        // unsupported by exactly this path.
        var major = ReadRegistryDword("CurrentMajorVersionNumber") ?? ParseMajorFromLegacyVersion();

        var buildStr = ReadRegistryString("CurrentBuildNumber") ?? ReadRegistryString("CurrentBuild");
        var build = int.TryParse(buildStr, out var b) ? b : 0;

        var ubr = ReadRegistryDword("UBR") ?? 0;

        return (build, ubr, major);
    }

    /// <summary>Pre-Windows-10 images (and some locked-down images) don't carry
    /// CurrentMajorVersionNumber as a DWORD — CurrentVersion ("6.3" etc.) is the
    /// only place major is still available on those.</summary>
    private static int ParseMajorFromLegacyVersion()
    {
        var legacy = ReadRegistryString("CurrentVersion");
        if (legacy is null) return 0;
        var parts = legacy.Split('.');
        return parts.Length > 0 && int.TryParse(parts[0], out var m) ? m : 0;
    }

    private static string? ReadRegistryString(string valueName)
    {
        try
        {
            using var key = Registry.LocalMachine.OpenSubKey(CurrentVersionKey);
            return key?.GetValue(valueName) as string;
        }
        catch
        {
            return null;
        }
    }

    private static int? ReadRegistryDword(string valueName)
    {
        try
        {
            using var key = Registry.LocalMachine.OpenSubKey(CurrentVersionKey);
            return key?.GetValue(valueName) is int i ? i : null;
        }
        catch
        {
            return null;
        }
    }
}
