namespace ActMon.Setup.Core.Models;

public sealed class PortCheckResult
{
    public required int Port { get; init; }
    public required bool IsAvailable { get; init; }
    public int? Pid { get; init; }
    public string? ProcessName { get; init; }
}
