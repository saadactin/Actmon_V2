using System.Collections.ObjectModel;
using ActMon.Setup.Core.Models;
using ActMon.Setup.Core.Services;
using ActMon.Setup.Mvvm;

namespace ActMon.Setup.Pages.SystemRequirements;

public sealed class CheckRowViewModel
{
    public required string Requirement { get; init; }
    public required string StatusGlyph { get; init; }
    public required string StatusBrushKey { get; init; }
    public required string Details { get; init; }
}

public sealed class SystemRequirementsViewModel : ViewModelBase, IWizardPageViewModel
{
    private readonly InstallerContext _ctx;
    private readonly SystemRequirementsChecker _checker = new();
    private bool _isBusy = true;
    private bool _canGoNext;
    private string? _blockingSummary;

    public SystemRequirementsViewModel(InstallerContext ctx)
    {
        _ctx = ctx;
    }

    public ObservableCollection<CheckRowViewModel> Rows { get; } = new();

    public bool IsBusy
    {
        get => _isBusy;
        private set => SetField(ref _isBusy, value);
    }

    public string? BlockingSummary
    {
        get => _blockingSummary;
        private set => SetField(ref _blockingSummary, value);
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
        BlockingSummary = null;

        var results = await _checker.RunAllAsync(_ctx.InstallDirectory);

        foreach (var r in results)
        {
            Rows.Add(new CheckRowViewModel
            {
                Requirement = r.Requirement,
                StatusGlyph = r.Status switch
                {
                    CheckStatus.Ready => "✓",
                    CheckStatus.Warning => "⚠",
                    CheckStatus.Required => "✕",
                    _ => "?",
                },
                StatusBrushKey = r.Status switch
                {
                    CheckStatus.Ready => "SuccessBrush",
                    CheckStatus.Warning => "WarningBrush",
                    CheckStatus.Required => "DangerBrush",
                    _ => "MutedBrush",
                },
                Details = r.Details,
            });
        }

        var blockers = results.Where(r => r.IsBlocking).ToList();
        if (blockers.Count > 0)
        {
            BlockingSummary = "Installation cannot continue until every ✕ item above is resolved:\n" +
                               string.Join("\n", blockers.Select(b => $"• {b.Requirement}: {b.BlockingReason}"));
        }

        CanGoNext = blockers.Count == 0;
        IsBusy = false;
    }
}
