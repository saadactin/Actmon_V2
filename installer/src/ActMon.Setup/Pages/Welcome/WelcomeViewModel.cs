using System.IO;
using ActMon.Setup.Core;
using ActMon.Setup.Core.Models;
using ActMon.Setup.Core.Services;
using ActMon.Setup.Mvvm;

namespace ActMon.Setup.Pages.Welcome;

public sealed class WelcomeViewModel : ViewModelBase, IWizardPageViewModel
{
    private readonly InstallerContext _ctx;
    private string _installDirectory;
    private string _directoryMessage = "";
    private string _directoryMessageBrushKey = "MutedBrush";
    private bool _canGoNext = true;

    public WelcomeViewModel(InstallerContext ctx)
    {
        _ctx = ctx;
        _installDirectory = _ctx.InstallDirectory;
        BrowseCommand = new RelayCommand(Browse);
        ValidateDirectory();
    }

    public string ProductName => AppInfo.ProductName;
    public string Tagline => AppInfo.ProductTagline;
    public string Version => AppInfo.Version;
    public string Publisher => AppInfo.Publisher;
    public string InstallationType => "Full platform (frontend + database backend + cloud backend)";
    public string DefaultInstallDirectory => AppInfo.DefaultInstallDirectory;

    /// <summary>Two-way bound to the path TextBox — edited directly or via
    /// Browse. Every change re-validates (writable + disk space) and, once
    /// valid, is written straight back into the shared InstallerContext so
    /// every later page and the Install engine itself sees the chosen path.</summary>
    public string InstallDirectory
    {
        get => _installDirectory;
        set
        {
            if (!SetField(ref _installDirectory, value)) return;
            ValidateDirectory();
        }
    }

    public string DirectoryMessage
    {
        get => _directoryMessage;
        private set => SetField(ref _directoryMessage, value);
    }

    public string DirectoryMessageBrushKey
    {
        get => _directoryMessageBrushKey;
        private set => SetField(ref _directoryMessageBrushKey, value);
    }

    public RelayCommand BrowseCommand { get; }

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

    public Task OnNavigatedToAsync() => Task.CompletedTask;

    private void Browse()
    {
        var dialog = new Microsoft.Win32.OpenFolderDialog
        {
            Title = "Choose the ActMon installation directory",
            InitialDirectory = Directory.Exists(InstallDirectory) ? InstallDirectory : DefaultInstallDirectory,
            Multiselect = false,
        };
        if (dialog.ShowDialog() == true)
            InstallDirectory = dialog.FolderName;
    }

    private void ValidateDirectory()
    {
        var result = InstallDirectoryValidator.Validate(InstallDirectory);
        DirectoryMessage = result.Message;
        DirectoryMessageBrushKey = result.Status switch
        {
            InstallDirectoryStatus.Ok => "SuccessBrush",
            InstallDirectoryStatus.LowDiskSpaceWarning => "WarningBrush",
            _ => "DangerBrush",
        };

        CanGoNext = result.Status != InstallDirectoryStatus.Invalid;
        if (CanGoNext)
            _ctx.InstallDirectory = Path.GetFullPath(InstallDirectory);
    }
}
