using ActMon.Setup.Core.Services;
using ActMon.Setup.Mvvm;

namespace ActMon.Setup.Pages.PortConfiguration;

public sealed class PortRowViewModel : ViewModelBase
{
    private readonly PortChecker _checker;
    private readonly WindowsServiceManager _services;
    private readonly Action _notifyChanged;
    private readonly string _ownProcessName;
    private readonly string _ownServiceName;
    private int _port;
    private bool _isChecking;
    private bool _isAvailable;
    private bool _isOwnService;
    private string _statusText = "";
    private string? _processName;

    /// <summary>ownProcessName/ownServiceName identify the exact ActMon
    /// component this row configures (e.g. "actmon-database-server.exe" /
    /// ActMonDatabaseService) — used to recognize when a reported "in use"
    /// port is actually held by ActMon's own already-running service from an
    /// earlier attempt, rather than a genuine third-party conflict.</summary>
    public PortRowViewModel(string label, int initialPort, PortChecker checker, Action notifyChanged, string ownProcessName, string ownServiceName)
    {
        Label = label;
        _port = initialPort;
        _checker = checker;
        _services = new WindowsServiceManager();
        _notifyChanged = notifyChanged;
        _ownProcessName = ownProcessName;
        _ownServiceName = ownServiceName;
        RecheckCommand = new AsyncRelayCommand(RecheckAsync, () => !IsChecking);
    }

    public string Label { get; }

    public int Port
    {
        get => _port;
        set
        {
            if (SetField(ref _port, value))
                _ = RecheckAsync();
        }
    }

    public bool IsChecking
    {
        get => _isChecking;
        private set => SetField(ref _isChecking, value);
    }

    public bool IsAvailable
    {
        get => _isAvailable;
        private set => SetField(ref _isAvailable, value);
    }

    public string StatusText
    {
        get => _statusText;
        private set => SetField(ref _statusText, value);
    }

    /// <summary>Name of the process currently holding this port, if any — lets
    /// the parent page tell "ActMon's own already-running service" (which
    /// Install will safely stop and replace) apart from a genuinely
    /// conflicting third-party process, without re-parsing StatusText.</summary>
    public string? ProcessName
    {
        get => _processName;
        private set => SetField(ref _processName, value);
    }

    /// <summary>True when the process holding this port matches this row's
    /// own ActMon component AND a same-named ActMon service is actually
    /// registered — matching process name alone isn't treated as enough
    /// evidence, since an unrelated process could coincidentally share it.</summary>
    public bool IsOwnService
    {
        get => _isOwnService;
        private set => SetField(ref _isOwnService, value);
    }

    /// <summary>What actually gates Next: genuinely available, or already
    /// held by this exact ActMon service, which Install stops and replaces
    /// before redeploying rather than treating as a conflict.</summary>
    public bool IsUsable => IsAvailable || IsOwnService;

    public AsyncRelayCommand RecheckCommand { get; }

    public async Task RecheckAsync()
    {
        if (_port is < 1 or > 65535)
        {
            IsAvailable = false;
            IsOwnService = false;
            StatusText = "Invalid port number";
            _notifyChanged();
            return;
        }

        IsChecking = true;
        StatusText = "Checking…";
        var result = await _checker.CheckAsync(_port);
        IsAvailable = result.IsAvailable;
        ProcessName = result.ProcessName;
        IsOwnService = !result.IsAvailable
            && string.Equals(result.ProcessName, _ownProcessName, StringComparison.OrdinalIgnoreCase)
            && _services.Exists(_ownServiceName);

        StatusText = result.IsAvailable
            ? "Available"
            : IsOwnService
                ? $"In use by ActMon's own service (PID {result.Pid}) — will be replaced during Install"
                : $"In use — PID {result.Pid?.ToString() ?? "?"} ({result.ProcessName ?? "unknown process"})";
        IsChecking = false;
        _notifyChanged();
    }
}
