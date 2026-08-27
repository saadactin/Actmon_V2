using ActMon.Setup.Mvvm;

namespace ActMon.Setup.Pages.Placeholder;

/// <summary>Stands in for a step this milestone hasn't built yet, so the shell stays
/// navigable end-to-end for review without pretending unbuilt stages are done.</summary>
public sealed class PlaceholderViewModel : IWizardPageViewModel
{
    public PlaceholderViewModel(string stepTitle)
    {
        StepTitle = stepTitle;
    }

    public string StepTitle { get; }
    public bool CanGoNext => false;
    public event EventHandler? CanGoNextChanged { add { } remove { } }
    public Task OnNavigatedToAsync() => Task.CompletedTask;
}
