using System.Diagnostics;
using System.IO;
using ActMon.Setup.Core.Models;
using ActMon.Setup.Core.Services;
using ActMon.Setup.Mvvm;

namespace ActMon.Setup.Pages.Complete;

public sealed class InstallationCompleteViewModel : ViewModelBase, IWizardPageViewModel
{
    private readonly InstallerContext _ctx;

    public InstallationCompleteViewModel(InstallerContext ctx)
    {
        _ctx = ctx;
        OpenActMonCommand = new RelayCommand(() => Process.Start(new ProcessStartInfo(ActMonUrl) { UseShellExecute = true }));
        ViewLogsCommand = new RelayCommand(() => Process.Start(new ProcessStartInfo(Path.Combine(_ctx.InstallDirectory, "logs")) { UseShellExecute = true }));
    }

    public string ActMonUrl => ActMonUrlBuilder.Build(_ctx);
    public int DatabaseBackendPort => _ctx.DatabaseBackendPort;
    public int CloudBackendPort => _ctx.CloudBackendPort;
    public string OrganizationName => _ctx.OrganizationName;
    public string SuperAdminUsername => string.IsNullOrEmpty(_ctx.SuperAdminUsername) ? "(existing account)" : _ctx.SuperAdminUsername;

    public RelayCommand OpenActMonCommand { get; }
    public RelayCommand ViewLogsCommand { get; }

    public bool CanGoNext => true;
    public event EventHandler? CanGoNextChanged { add { } remove { } }
    public Task OnNavigatedToAsync() => Task.CompletedTask;
}
