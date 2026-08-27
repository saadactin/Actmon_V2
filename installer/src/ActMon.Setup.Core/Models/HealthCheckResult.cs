namespace ActMon.Setup.Core.Models;

public sealed class HealthCheckResult
{
    public required string Name { get; init; }
    public required bool Passed { get; init; }
    public required string Details { get; init; }
}
