namespace ActMon.Setup.Core.Models;

public sealed class InstallStepResult
{
    public required bool Success { get; init; }
    public string? ErrorComponent { get; init; }
    public string? ErrorProblem { get; init; }
    public string? ErrorRecommendedAction { get; init; }
    public string? ErrorDetails { get; init; }
}
