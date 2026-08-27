using ActMon.Setup.Models;
using ActMon.Setup.Mvvm;

namespace ActMon.Setup.Shell;

public sealed class WizardStepEntry : ViewModelBase
{
    private bool _isCurrent;
    private bool _isCompleted;

    public required WizardStepId Id { get; init; }
    public required string Title { get; init; }

    public bool IsCurrent
    {
        get => _isCurrent;
        set => SetField(ref _isCurrent, value);
    }

    public bool IsCompleted
    {
        get => _isCompleted;
        set => SetField(ref _isCompleted, value);
    }
}
