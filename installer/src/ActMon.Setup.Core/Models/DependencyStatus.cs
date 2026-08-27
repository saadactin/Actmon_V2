namespace ActMon.Setup.Core.Models;

public enum DependencyState
{
    /// <summary>Detected, already usable — never touch it, just ask for credentials.</summary>
    Installed,
    /// <summary>Not detected — installer can offer to install it.</summary>
    NotInstalled,
    /// <summary>Detection itself failed (e.g. WSL unavailable to even ask) — treat like NotInstalled but say why.</summary>
    Unknown,
}

public sealed class DependencyStatus
{
    public required string Name { get; init; }
    public required DependencyState State { get; init; }
    public string? Version { get; init; }
    public string? InstallPath { get; init; }
    public string? ServiceStatus { get; init; }
    public required string Details { get; init; }
}
