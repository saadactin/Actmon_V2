using System.Collections.ObjectModel;
using ActMon.Setup.Core.Models;
using ActMon.Setup.Core.Services;
using ActMon.Setup.Mvvm;

namespace ActMon.Setup.Pages.DependencyPreCheck;

public sealed class DependencyRowViewModel : ViewModelBase
{
    public required string Name { get; init; }
    public required string StatusGlyph { get; init; }
    public required string StatusBrushKey { get; init; }
    public required string StatusLabel { get; init; }
    public required string Details { get; init; }
    public required bool NeedsInstall { get; init; }
}

public sealed class DependencyPreCheckViewModel : ViewModelBase, IWizardPageViewModel
{
    private readonly InstallerContext _ctx;
    private readonly DependencyDetector _detector = new();
    private bool _isBusy = true;
    private bool _canGoNext;

    public DependencyPreCheckViewModel(InstallerContext ctx)
    {
        _ctx = ctx;
    }

    public ObservableCollection<DependencyRowViewModel> Rows { get; } = new();

    public bool IsBusy
    {
        get => _isBusy;
        private set => SetField(ref _isBusy, value);
    }

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
        IsBusy = true;
        CanGoNext = false;
        Rows.Clear();

        var postgres = await _detector.DetectPostgreSqlAsync();
        var redis = await _detector.DetectRedisViaWslAsync();
        var clickhouse = await _detector.DetectClickHouseAsync();

        foreach (var dep in new[] { postgres, redis, clickhouse })
            Rows.Add(ToRow(dep));

        // Dependency Pre-check never blocks Next on its own — a missing dependency
        // is resolved via [Install] on this page or picked back up when its own
        // configuration page runs DetectXxxAsync again; the wizard just needs the
        // administrator to have looked at this screen once.
        CanGoNext = true;
        IsBusy = false;
    }

    private static DependencyRowViewModel ToRow(DependencyStatus d) => new()
    {
        Name = d.Name,
        StatusGlyph = d.State == DependencyState.Installed ? "✓" : "⚠",
        StatusBrushKey = d.State == DependencyState.Installed ? "SuccessBrush" : "WarningBrush",
        StatusLabel = d.State == DependencyState.Installed ? "Installed" : "Not Installed",
        Details = d.Details + (d.Version is not null ? $" — {d.Version}" : "") + (d.InstallPath is not null ? $" ({d.InstallPath})" : ""),
        NeedsInstall = d.State != DependencyState.Installed,
    };
}
