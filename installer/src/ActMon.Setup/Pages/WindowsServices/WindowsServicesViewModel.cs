using System.Collections.ObjectModel;
using System.ServiceProcess;
using ActMon.Setup.Core.Services;
using ActMon.Setup.Mvvm;

namespace ActMon.Setup.Pages.WindowsServices;

public sealed class ServiceRowViewModel
{
    public required string DisplayName { get; init; }
    public required bool Exists { get; init; }
    public required bool Running { get; init; }
    public required string StartupType { get; init; }
}

public sealed class WindowsServicesViewModel : ViewModelBase, IWizardPageViewModel
{
    private readonly WindowsServiceManager _services = new();
    private bool _isChecking = true;
    private bool _canGoNext;

    public WindowsServicesViewModel(Core.Models.InstallerContext ctx)
    {
        // ctx isn't needed here — the services this page checks were already
        // named and created by the Install step — but every page constructor
        // takes it for a uniform factory in WizardShellViewModel.
    }

    public ObservableCollection<ServiceRowViewModel> Rows { get; } = new();

    public bool IsChecking { get => _isChecking; private set => SetField(ref _isChecking, value); }

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

    public Task OnNavigatedToAsync()
    {
        IsChecking = true;
        Rows.Clear();

        foreach (var (label, name) in new[]
                 {
                     ("Database Backend", Core.Services.InstallEngine.DatabaseServiceName),
                     ("Cloud Backend", Core.Services.InstallEngine.CloudServiceName),
                     ("Frontend (nginx)", Core.Services.InstallEngine.FrontendServiceName),
                 })
        {
            var exists = _services.Exists(name);
            var status = exists ? _services.GetStatus(name) : null;
            var startType = "unknown";
            if (exists)
            {
                try { using var sc = new ServiceController(name); startType = sc.StartType.ToString(); }
                catch { /* leave as unknown */ }
            }

            Rows.Add(new ServiceRowViewModel
            {
                DisplayName = label,
                Exists = exists,
                Running = status == ServiceControllerStatus.Running,
                StartupType = startType,
            });
        }

        CanGoNext = Rows.All(r => r.Exists && r.Running);
        IsChecking = false;
        return Task.CompletedTask;
    }
}
