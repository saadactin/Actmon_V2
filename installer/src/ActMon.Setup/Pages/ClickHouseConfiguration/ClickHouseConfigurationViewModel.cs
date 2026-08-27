using System.Collections.ObjectModel;
using ActMon.Setup.Core.Models;
using ActMon.Setup.Core.Services;
using ActMon.Setup.Mvvm;

namespace ActMon.Setup.Pages.ClickHouseConfiguration;

public enum ChDbMode { UseExisting, CreateNew }

public sealed class ClickHouseConfigurationViewModel : ViewModelBase, IWizardPageViewModel
{
    private readonly InstallerContext _ctx;
    private readonly DependencyDetector _detector = new();
    private readonly ClickHouseConfigService _ch = new();
    private readonly WslDependencyInstaller _installer = new();

    private bool _isDetecting = true;
    private bool _isInstalled;
    private bool _isInstalling;
    private string? _installMessage;
    private string _host = "localhost";
    private int _port = 8123;
    private string _username = "default";
    private string _password = "";
    private bool _isTesting;
    private bool? _connectionOk;
    private string _connectionMessage = "";
    private bool _isLoadingDatabases;
    private ChDbMode _mode = ChDbMode.UseExisting;
    private string? _selectedDatabase;
    private bool _existingConfirmed;
    private string _newDbName = "";
    private string? _createError;
    private bool _dbAlreadyExistsConflict;
    private bool _isCreating;
    private bool _created;
    private bool _canGoNext;

    public ClickHouseConfigurationViewModel(InstallerContext ctx)
    {
        _ctx = ctx;
        TestConnectionCommand = new AsyncRelayCommand(TestConnectionAsync, () => !_isTesting);
        ConfirmExistingCommand = new RelayCommand(ConfirmExisting, () => SelectedDatabase is not null);
        CreateDatabaseCommand = new AsyncRelayCommand(CreateDatabaseAsync, () => !_isCreating);
        ChooseAnotherNameCommand = new RelayCommand(() => { DbAlreadyExistsConflict = false; NewDbName = ""; });
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

        var (success, message) = await _installer.InstallClickHouseAsync(m => InstallMessage = m);
        InstallMessage = success ? "ClickHouse installed inside WSL2 Ubuntu." : $"Install failed: {message}";
        if (success) IsInstalled = true;
        IsInstalling = false;
    }

    public string Host { get => _host; set => SetField(ref _host, value); }
    public int Port { get => _port; set => SetField(ref _port, value); }
    public string Username { get => _username; set => SetField(ref _username, value); }
    public string Password { get => _password; set => SetField(ref _password, value); }

    public bool IsTesting { get => _isTesting; private set => SetField(ref _isTesting, value); }
    public bool? ConnectionOk { get => _connectionOk; private set => SetField(ref _connectionOk, value); }
    public string ConnectionMessage { get => _connectionMessage; private set => SetField(ref _connectionMessage, value); }

    public bool IsLoadingDatabases { get => _isLoadingDatabases; private set => SetField(ref _isLoadingDatabases, value); }
    public ObservableCollection<string> Databases { get; } = new();

    public bool UseExisting { get => _mode == ChDbMode.UseExisting; set { if (value) Mode = ChDbMode.UseExisting; } }
    public bool UseCreateNew { get => _mode == ChDbMode.CreateNew; set { if (value) Mode = ChDbMode.CreateNew; } }

    private ChDbMode Mode
    {
        get => _mode;
        set
        {
            if (SetField(ref _mode, value))
            {
                OnPropertyChanged(nameof(UseExisting));
                OnPropertyChanged(nameof(UseCreateNew));
            }
        }
    }

    public string? SelectedDatabase { get => _selectedDatabase; set => SetField(ref _selectedDatabase, value); }
    public bool ExistingConfirmed { get => _existingConfirmed; private set => SetField(ref _existingConfirmed, value); }
    public string NewDbName { get => _newDbName; set => SetField(ref _newDbName, value); }
    public string? CreateError { get => _createError; private set => SetField(ref _createError, value); }
    public bool DbAlreadyExistsConflict { get => _dbAlreadyExistsConflict; private set => SetField(ref _dbAlreadyExistsConflict, value); }
    public bool IsCreating { get => _isCreating; private set => SetField(ref _isCreating, value); }
    public bool Created { get => _created; private set => SetField(ref _created, value); }

    public AsyncRelayCommand TestConnectionCommand { get; }
    public RelayCommand ConfirmExistingCommand { get; }
    public AsyncRelayCommand CreateDatabaseCommand { get; }
    public RelayCommand ChooseAnotherNameCommand { get; }

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
        var status = await _detector.DetectClickHouseAsync();
        IsInstalled = status.State == DependencyState.Installed;
        IsDetecting = false;
    }

    private async Task TestConnectionAsync()
    {
        IsTesting = true;
        ConnectionOk = null;
        ConnectionMessage = "Testing…";

        var info = new ClickHouseConnectionInfo { Host = Host, Port = Port, Username = Username, Password = Password };
        var (success, message) = await _ch.TestConnectionAsync(info);
        ConnectionOk = success;
        ConnectionMessage = message;
        IsTesting = false;

        if (success)
        {
            _ctx.ClickHouseAdmin.Host = Host;
            _ctx.ClickHouseAdmin.Port = Port;
            _ctx.ClickHouseAdmin.Username = Username;
            _ctx.ClickHouseAdmin.Password = Password;
            await LoadDatabasesAsync(info);
        }
        Recompute();
    }

    private async Task LoadDatabasesAsync(ClickHouseConnectionInfo info)
    {
        IsLoadingDatabases = true;
        Databases.Clear();
        try
        {
            foreach (var db in await _ch.ListDatabasesAsync(info))
                Databases.Add(db);
        }
        catch { /* enumeration is a convenience, not a gate */ }
        IsLoadingDatabases = false;
    }

    private void ConfirmExisting()
    {
        if (SelectedDatabase is null) return;
        _ctx.ClickHouseAppDatabase = SelectedDatabase;
        _ctx.ClickHouseAdmin.Database = SelectedDatabase;
        ExistingConfirmed = true;
        Recompute();
    }

    private async Task CreateDatabaseAsync()
    {
        CreateError = null;
        DbAlreadyExistsConflict = false;

        if (!ClickHouseConfigService.IsValidIdentifier(NewDbName))
        {
            CreateError = "Database name must start with a letter or underscore and contain only letters, digits and underscores.";
            return;
        }

        IsCreating = true;
        var info = new ClickHouseConnectionInfo { Host = Host, Port = Port, Username = Username, Password = Password };
        try
        {
            if (await _ch.DatabaseExistsAsync(info, NewDbName))
            {
                DbAlreadyExistsConflict = true;
                return;
            }

            await _ch.CreateDatabaseAsync(info, NewDbName);
            _ctx.ClickHouseAppDatabase = NewDbName;
            _ctx.ClickHouseAdmin.Database = NewDbName;
            Created = true;
        }
        catch (Exception ex)
        {
            CreateError = $"Could not create database: {ex.Message}";
        }
        finally
        {
            IsCreating = false;
            Recompute();
        }
    }

    private void Recompute()
    {
        CanGoNext = ConnectionOk == true && (ExistingConfirmed || Created);
    }
}
