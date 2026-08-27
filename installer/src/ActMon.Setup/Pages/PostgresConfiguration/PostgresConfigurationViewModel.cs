using System.Collections.ObjectModel;
using ActMon.Setup.Core.Models;
using ActMon.Setup.Core.Services;
using ActMon.Setup.Mvvm;

namespace ActMon.Setup.Pages.PostgresConfiguration;

public enum DbSelectionMode { UseExisting, CreateNew }

public sealed class PostgresConfigurationViewModel : ViewModelBase, IWizardPageViewModel
{
    private readonly InstallerContext _ctx;
    private readonly DependencyDetector _detector = new();
    private readonly PostgresConfigService _pg = new();
    private readonly PostgresInstaller _installer = new();

    private bool _isDetecting = true;
    private bool _isInstalled;
    private bool _isInstalling;
    private string? _installMessage;
    private string _host = "localhost";
    private int _port = 5432;
    private string _username = "postgres";
    private string _password = "";
    private bool _isTesting;
    private bool? _connectionOk;
    private string _connectionMessage = "";
    private bool _isLoadingDatabases;
    private DbSelectionMode _mode = DbSelectionMode.UseExisting;
    private DatabaseInfo? _selectedDatabase;
    private bool _existingConfirmed;
    private string _newDbName = "";
    private string _newDbUsername = "";
    private string _newDbPassword = "";
    private string _newDbConfirmPassword = "";
    private string? _createError;
    private bool _dbAlreadyExistsConflict;
    private bool _isCreating;
    private bool _created;
    private bool _canGoNext;

    public PostgresConfigurationViewModel(InstallerContext ctx)
    {
        _ctx = ctx;
        TestConnectionCommand = new AsyncRelayCommand(TestConnectionAsync, () => !_isTesting && !string.IsNullOrWhiteSpace(Host));
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
        var generatedPassword = SecretGenerator.GenerateHex(12);
        var (success, message) = await _installer.DownloadAndInstallAsync(
            generatedPassword, "postgresql-actmon", Port, line => InstallMessage = line);

        if (success)
        {
            IsInstalled = true;
            Username = "postgres";
            Password = generatedPassword;
            InstallMessage = $"PostgreSQL installed. Superuser password: {generatedPassword} (already filled in below — write it down, it will not be shown again).";
        }
        else
        {
            InstallMessage = $"Install failed: {message}";
        }
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
    public ObservableCollection<DatabaseInfo> Databases { get; } = new();

    public bool UseExisting
    {
        get => _mode == DbSelectionMode.UseExisting;
        set { if (value) { Mode = DbSelectionMode.UseExisting; } }
    }

    public bool UseCreateNew
    {
        get => _mode == DbSelectionMode.CreateNew;
        set { if (value) { Mode = DbSelectionMode.CreateNew; } }
    }

    private DbSelectionMode Mode
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

    public DatabaseInfo? SelectedDatabase { get => _selectedDatabase; set => SetField(ref _selectedDatabase, value); }
    public bool ExistingConfirmed { get => _existingConfirmed; private set => SetField(ref _existingConfirmed, value); }

    public string NewDbName { get => _newDbName; set => SetField(ref _newDbName, value); }
    public string NewDbUsername { get => _newDbUsername; set => SetField(ref _newDbUsername, value); }
    public string NewDbPassword { get => _newDbPassword; set => SetField(ref _newDbPassword, value); }
    public string NewDbConfirmPassword { get => _newDbConfirmPassword; set => SetField(ref _newDbConfirmPassword, value); }
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
        var status = await _detector.DetectPostgreSqlAsync();
        IsInstalled = status.State == Core.Models.DependencyState.Installed;
        IsDetecting = false;
        Recompute();
    }

    private async Task TestConnectionAsync()
    {
        IsTesting = true;
        ConnectionOk = null;
        ConnectionMessage = "Testing…";

        var info = new PostgresConnectionInfo { Host = Host, Port = Port, Username = Username, Password = Password };
        var (success, message) = await _pg.TestConnectionAsync(info);
        ConnectionOk = success;
        ConnectionMessage = message;
        IsTesting = false;

        if (success)
        {
            _ctx.PostgresAdmin.Host = Host;
            _ctx.PostgresAdmin.Port = Port;
            _ctx.PostgresAdmin.Username = Username;
            _ctx.PostgresAdmin.Password = Password;
            await LoadDatabasesAsync(info);
        }
        Recompute();
    }

    private async Task LoadDatabasesAsync(PostgresConnectionInfo info)
    {
        IsLoadingDatabases = true;
        Databases.Clear();
        try
        {
            foreach (var db in await _pg.ListDatabasesAsync(info))
                Databases.Add(db);
        }
        catch
        {
            // Listing is a convenience, not a gate — the admin can still type a
            // database name under "Create New" even if enumeration itself failed.
        }
        IsLoadingDatabases = false;
    }

    private void ConfirmExisting()
    {
        if (SelectedDatabase is null) return;
        _ctx.PostgresAppDatabase = SelectedDatabase.Name;
        _ctx.PostgresAppUsername = Username;
        _ctx.PostgresAppPassword = Password;
        ExistingConfirmed = true;
        Recompute();
    }

    private async Task CreateDatabaseAsync()
    {
        CreateError = null;
        DbAlreadyExistsConflict = false;

        if (!PostgresConfigService.IsValidIdentifier(NewDbName))
        {
            CreateError = "Database name must start with a letter or underscore and contain only letters, digits and underscores.";
            return;
        }
        if (!PostgresConfigService.IsValidIdentifier(NewDbUsername))
        {
            CreateError = "Username must start with a letter or underscore and contain only letters, digits and underscores.";
            return;
        }
        if (string.IsNullOrWhiteSpace(NewDbPassword) || NewDbPassword.Length < 8)
        {
            CreateError = "Password must be at least 8 characters.";
            return;
        }
        if (NewDbPassword != NewDbConfirmPassword)
        {
            CreateError = "Passwords do not match.";
            return;
        }

        IsCreating = true;
        var adminInfo = new PostgresConnectionInfo { Host = Host, Port = Port, Username = Username, Password = Password };
        try
        {
            if (await _pg.DatabaseExistsAsync(adminInfo, NewDbName))
            {
                DbAlreadyExistsConflict = true;
                return;
            }

            await _pg.CreateDatabaseAndRoleAsync(adminInfo, NewDbName, NewDbUsername, NewDbPassword);

            _ctx.PostgresAppDatabase = NewDbName;
            _ctx.PostgresAppUsername = NewDbUsername;
            _ctx.PostgresAppPassword = NewDbPassword;
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
