using System.Collections.ObjectModel;
using ActMon.Setup.Core.Models;
using ActMon.Setup.Core.Services;
using ActMon.Setup.Mvvm;

namespace ActMon.Setup.Pages.Firewall;

public sealed class FirewallRowViewModel
{
    public required int Port { get; init; }
    public required string Label { get; init; }
    public required bool Allowed { get; init; }
}

public sealed class FirewallViewModel : ViewModelBase, IWizardPageViewModel
{
    private readonly InstallerContext _ctx;
    private readonly FirewallManager _firewall = new();
    private bool _isChecking = true;
    private bool _canGoNext;

    public FirewallViewModel(InstallerContext ctx)
    {
        _ctx = ctx;
    }

    public ObservableCollection<FirewallRowViewModel> Rows { get; } = new();
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

    public async Task OnNavigatedToAsync()
    {
        IsChecking = true;
        Rows.Clear();

        foreach (var (port, label) in new[]
                 {
                     (_ctx.FrontendPort, "ActMon web UI"),
                     (_ctx.DatabaseBackendPort, "Database backend"),
                     (_ctx.CloudBackendPort, "Cloud backend"),
                 })
        {
            Rows.Add(new FirewallRowViewModel { Port = port, Label = label, Allowed = await _firewall.RuleExistsAsync(port) });
        }

        CanGoNext = Rows.All(r => r.Allowed);
        IsChecking = false;
    }
}
