namespace ActMon.Setup.Mvvm;

/// <summary>Implemented by every step's view model. The shell calls
/// OnNavigatedToAsync each time the step becomes current (so it can run its
/// checks fresh — e.g. re-testing a port or a DB connection after Back/Next),
/// and reads CanGoNext to gate the Next button.</summary>
public interface IWizardPageViewModel
{
    Task OnNavigatedToAsync();
    bool CanGoNext { get; }
    event EventHandler? CanGoNextChanged;
}
