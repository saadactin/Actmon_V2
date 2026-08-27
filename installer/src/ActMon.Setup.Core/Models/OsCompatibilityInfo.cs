namespace ActMon.Setup.Core.Models;

public enum WindowsProductFamily
{
    Unknown,
    Windows10Client,
    Windows11Client,
    WindowsServer,
}

/// <summary>
/// Structured result of detecting exactly which Windows this machine is running —
/// caption, edition, exact build/UBR, architecture, and whether it's a supported
/// client or server release. Built once by <see cref="Services.OsDetector"/> and
/// consumed both by the System Requirements page (to show a single clear
/// Compatible/Not Compatible verdict) and by any service that needs to branch its
/// own behavior between Windows client and Windows Server (e.g. WSL2 setup).
/// </summary>
public sealed class OsCompatibilityInfo
{
    public required string Caption { get; init; }
    public required string Edition { get; init; }
    public required WindowsProductFamily Family { get; init; }
    public required int Major { get; init; }
    public required int Build { get; init; }
    public required int Ubr { get; init; }
    public required string Architecture { get; init; }
    public required bool IsSupported { get; init; }
    public string? UnsupportedReason { get; init; }

    public bool IsServer => Family == WindowsProductFamily.WindowsServer;

    public string DisplayVersion => Family switch
    {
        WindowsProductFamily.WindowsServer => ServerReleaseName(Build),
        WindowsProductFamily.Windows11Client => "Windows 11",
        WindowsProductFamily.Windows10Client => "Windows 10",
        _ => Caption,
    };

    public string FullBuildString => Ubr > 0 ? $"{Build}.{Ubr}" : Build.ToString();

    private static string ServerReleaseName(int build) => build switch
    {
        >= 26100 => "Windows Server 2025",
        >= 20348 => "Windows Server 2022",
        >= 17763 => "Windows Server 2019",
        >= 14393 => "Windows Server 2016",
        _ => "Windows Server",
    };
}
