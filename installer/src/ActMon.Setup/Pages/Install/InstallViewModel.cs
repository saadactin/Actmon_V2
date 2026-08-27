using System.Collections.ObjectModel;
using ActMon.Setup.Core.Models;
using ActMon.Setup.Core.Services;
using ActMon.Setup.Mvvm;
using ActMon.Setup.Services;

namespace ActMon.Setup.Pages.Install;

public sealed class InstallViewModel : ViewModelBase, IWizardPageViewModel
{
    private readonly InstallerContext _ctx;
    private readonly InstallEngine _engine = new();
    private bool _hasRun;
    private bool _isRunning;
    private bool _succeeded;
    private bool _failed;
    private string? _errorComponent, _errorProblem, _errorAction, _errorDetails;
    private bool _showDetails;
    private bool _canGoNext;

    public InstallViewModel(InstallerContext ctx)
    {
        _ctx = ctx;
        RetryCommand = new AsyncRelayCommand(RunAsync, () => !_isRunning);
        ToggleDetailsCommand = new RelayCommand(() => ShowDetails = !ShowDetails);
    }

    public ObservableCollection<string> ProgressLines { get; } = new();

    public bool IsRunning { get => _isRunning; private set => SetField(ref _isRunning, value); }
    public bool Succeeded { get => _succeeded; private set => SetField(ref _succeeded, value); }
    public bool Failed { get => _failed; private set => SetField(ref _failed, value); }
    public string? ErrorComponent { get => _errorComponent; private set => SetField(ref _errorComponent, value); }
    public string? ErrorProblem { get => _errorProblem; private set => SetField(ref _errorProblem, value); }
    public string? ErrorAction { get => _errorAction; private set => SetField(ref _errorAction, value); }
    public string? ErrorDetails { get => _errorDetails; private set => SetField(ref _errorDetails, value); }
    public bool ShowDetails { get => _showDetails; private set => SetField(ref _showDetails, value); }

    public AsyncRelayCommand RetryCommand { get; }
    public RelayCommand ToggleDetailsCommand { get; }

    public bool CanGoNext
    {
        get => _canGoNext;
        private set
        {
            if (SetField(ref _canGoNext, value))
                CanGoNextChanged?.Invoke(this, EventArgs.Empty);
        }
    }

    public event EventHandler? CanGoNextChanged;

    public async Task OnNavigatedToAsync()
    {
        if (_hasRun) return;
        _hasRun = true;
        await RunAsync();
    }

    private async Task RunAsync()
    {
        IsRunning = true;
        Succeeded = false;
        Failed = false;
        ShowDetails = false;
        ProgressLines.Clear();
        CanGoNext = false;

        InstallStepResult result;
        try
        {
            var payload = PayloadResolver.Resolve();
            result = await _engine.RunAsync(_ctx, payload, line => ProgressLines.Add(line));
        }
        catch (Exception ex)
        {
            result = new InstallStepResult
            {
                Success = false,
                ErrorComponent = "Installer",
                ErrorProblem = "Could not locate the files this installer needs to deploy.",
                ErrorRecommendedAction = "Reinstall/repair this ActMon.exe download and try again.",
                ErrorDetails = ex.ToString(),
            };
        }

        IsRunning = false;
        if (result.Success)
        {
            Succeeded = true;
            CanGoNext = true;
        }
        else
        {
            Failed = true;
            ErrorComponent = result.ErrorComponent;
            ErrorProblem = result.ErrorProblem;
            ErrorAction = result.ErrorRecommendedAction;
            ErrorDetails = result.ErrorDetails;
        }
    }
}
