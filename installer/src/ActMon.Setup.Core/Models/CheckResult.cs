namespace ActMon.Setup.Core.Models;

public enum CheckStatus
{
    Ready,
    Warning,
    Required,
}

public sealed class CheckResult
{
    public required string Requirement { get; init; }
    public required CheckStatus Status { get; init; }
    public required string Details { get; init; }

    /// <summary>Only meaningful when Status == Required — explains why installation cannot proceed.</summary>
    public string? BlockingReason { get; init; }

    public bool IsBlocking => Status == CheckStatus.Required;
}
