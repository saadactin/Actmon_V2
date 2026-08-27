using ActMon.Setup.Core.Models;
using ActMon.Setup.Core.Services;
using ActMon.Setup.Mvvm;

namespace ActMon.Setup.Pages.RedisConfiguration;

public sealed class RedisConfigurationViewModel : ViewModelBase, IWizardPageViewModel
{
    private readonly InstallerContext _ctx;
    private readonly DependencyDetector _detector = new();
    private readonly RedisConfigService _redis = new();
    private readonly WslDependencyInstaller _installer = new();

    private bool _isDetecting = true;
    private bool _isInstalled;
    private bool _isInstalling;
    private string? _installMessage;
    private string _host = "localhost";
    private int _port = 6379;
    private string _password = "";
    private bool _isTesting;
    private bool? _connectionOk;
    private string _connectionMessage = "";

    public RedisConfigurationViewModel(InstallerContext ctx)
    {
        _ctx = ctx;
        TestConnectionCommand = new AsyncRelayCommand(TestConnectionAsync, () => !_isTesting);
        InstallCommand = new AsyncRelayCommand(InstallAsync, () => !_isInstalling);
    }

    public bool IsDetecting { get => _isDetecting; private set => SetField(ref _isDetecting, value); }
    public bool IsInstalled { get => _isInstalled; private set => SetField(ref _isInstalled, value); }
    public bool IsInstalling { get => _isInstalling; private set => SetField(ref _isInstalling, value); }
    public string? InstallMessage { get => _installMessage; private set => SetField(ref _installMessage, value); }
    public AsyncRelayCommand InstallCommand { get; }

    private async Task InstallAsync()
    {
        IsInstalling = true;
        InstallMessage = null;

        var (platformReady, platformMsg) = await _installer.EnsureWslPlatformAsync(m => InstallMessage = m);
        if (!platformReady) { InstallMessage = platformMsg; IsInstalling = false; return; }

        var (ubuntuReady, ubuntuMsg) = await _installer.EnsureUbuntuAsync(m => InstallMessage = m);
        if (!ubuntuReady) { InstallMessage = ubuntuMsg; IsInstalling = false; return; }

        var (success, message) = await _installer.InstallRedisAsync(m => InstallMessage = m);
        InstallMessage = success ? "Redis installed inside WSL2 Ubuntu." : $"Install failed: {message}";
        if (success) IsInstalled = true;
        IsInstalling = false;
    }

    public string Host { get => _host; set => SetField(ref _host, value); }
    public int Port { get => _port; set => SetField(ref _port, value); }
    public string Password { get => _password; set => SetField(ref _password, value); }

    public bool IsTesting { get => _isTesting; private set => SetField(ref _isTesting, value); }
    public bool? ConnectionOk { get => _connectionOk; private set => SetField(ref _connectionOk, value); }
    public string ConnectionMessage { get => _connectionMessage; private set => SetField(ref _connectionMessage, value); }

    public AsyncRelayCommand TestConnectionCommand { get; }

    private bool _canGoNext;
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
        IsDetecting = true;
        var status = await _detector.DetectRedisViaWslAsync();
        IsInstalled = status.State == DependencyState.Installed;
        IsDetecting = false;
    }

    private async Task TestConnectionAsync()
    {
        IsTesting = true;
        ConnectionOk = null;
        ConnectionMessage = "Testing…";

        var info = new RedisConnectionInfo { Host = Host, Port = Port, Password = Password };
        var (success, message) = await _redis.TestConnectionAsync(info);
        ConnectionOk = success;
        ConnectionMessage = message;
        IsTesting = false;

        if (success)
        {
            _ctx.Redis.Host = Host;
            _ctx.Redis.Port = Port;
            _ctx.Redis.Password = Password;
        }
        CanGoNext = success;
    }
}
