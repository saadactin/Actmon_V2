using System.Collections.ObjectModel;
using ActMon.Setup.Core.Models;
using ActMon.Setup.Core.Services;
using ActMon.Setup.Mvvm;

namespace ActMon.Setup.Pages.HealthCheck;

public sealed class HealthRowViewModel
{
    public required string Name { get; init; }
    public required bool Passed { get; init; }
    public required string Details { get; init; }
}

public sealed class HealthCheckViewModel : ViewModelBase, IWizardPageViewModel
{
    private readonly InstallerContext _ctx;
    private readonly Core.Services.HealthChecker _checker = new();
    private bool _isChecking = true;
    private bool _canGoNext;

    public HealthCheckViewModel(InstallerContext ctx)
    {
        _ctx = ctx;
        RecheckCommand = new AsyncRelayCommand(OnNavigatedToAsync);
    }

    public ObservableCollection<HealthRowViewModel> Rows { get; } = new();
    public bool IsChecking { get => _isChecking; private set => SetField(ref _isChecking, value); }
    public AsyncRelayCommand RecheckCommand { get; }

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
        IsChecking = true;
        Rows.Clear();

        var results = await _checker.RunAllAsync(_ctx, Core.Services.InstallEngine.FrontendServiceName,
            Core.Services.InstallEngine.DatabaseServiceName, Core.Services.InstallEngine.CloudServiceName);

        foreach (var r in results)
            Rows.Add(new HealthRowViewModel { Name = r.Name, Passed = r.Passed, Details = r.Details });

        CanGoNext = Rows.All(r => r.Passed);
        IsChecking = false;
    }
}
