namespace ActMon.Setup.Core.Models;

public sealed class DbSetupResult
{
    public required bool Success { get; init; }
    public required string RawOutput { get; init; }
    public string? SummaryJson { get; init; }
}
