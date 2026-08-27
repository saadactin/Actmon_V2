using ActMon.Setup.Core.Models;
using ActMon.Setup.Mvvm;
using ActMon.Setup.Pages.ExistingInstallation;

namespace ActMon.Setup.Shell;

/// <summary>
/// The window's real top-level view model — decides once, at startup, between
/// the fresh-install wizard and the "ActMon is already installed" screen
/// (section 22), based on whether an install manifest exists.
/// </summary>
public sealed class RootViewModel : ViewModelBase
{
    private readonly InstallManifest? _manifest;

    public RootViewModel()
    {
        _manifest = InstallManifest.TryLoad();
        if (_manifest is not null)
        {
            IsExistingInstall = true;
            ExistingInstall = new ExistingInstallationViewModel(_manifest, ShowWizard);
        }
        else
        {
            IsExistingInstall = false;
            Wizard = new WizardShellViewModel();
        }
    }

    private bool _isExistingInstall;
    public bool IsExistingInstall { get => _isExistingInstall; private set => SetField(ref _isExistingInstall, value); }

    private ExistingInstallationViewModel? _existingInstall;
    public ExistingInstallationViewModel? ExistingInstall { get => _existingInstall; private set => SetField(ref _existingInstall, value); }

    private WizardShellViewModel? _wizard;
    public WizardShellViewModel? Wizard { get => _wizard; private set => SetField(ref _wizard, value); }

    /// <summary>"Modify" drops into the same wizard a fresh install uses — every
    /// page's own detection (already-installed dependencies, already-provisioned
    /// database/org/admin) means walking through it again is safe and correct,
    /// not a blind re-entry of everything from scratch.</summary>
    private void ShowWizard()
    {
        IsExistingInstall = false;
        // Pre-populate from the existing install (path, ports, DB/Redis/ClickHouse
        // settings) so Modify starts from what's already on this machine rather
        // than the fresh-install defaults — the installation directory in
        // particular must be preserved unless explicitly changed on the Welcome
        // page. Best-effort: if the existing .env can't be read for some reason,
        // fall back to a fresh context rather than blocking Modify entirely.
        InstallerContext? existingContext = null;
        try { existingContext = _manifest?.LoadFullContext(); }
        catch { /* fall back to a fresh wizard below */ }

        Wizard = new WizardShellViewModel(existingContext);
    }
}
