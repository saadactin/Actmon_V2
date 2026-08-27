using System.Collections.ObjectModel;
using ActMon.Setup.Core.Models;
using ActMon.Setup.Core.Services;
using ActMon.Setup.Mvvm;
using ActMon.Setup.Services;

namespace ActMon.Setup.Pages.ExistingInstallation;

public sealed class ExistingInstallationViewModel : ViewModelBase
{
    private readonly InstallManifest _manifest;
    private readonly Action _onModify;
    private readonly InstallEngine _installEngine = new();
    private readonly UninstallEngine _uninstallEngine = new();

    private bool _isBusy;
    private string _busyLabel = "";
    private bool _showUninstallConfirm;
    private bool _alsoRemoveData;
    private bool _done;
    private string? _doneMessage;
    private string? _errorMessage;

    public ExistingInstallationViewModel(InstallManifest manifest, Action onModify)
    {
        _manifest = manifest;
        _onModify = onModify;

        ModifyCommand = new RelayCommand(_onModify, () => !_isBusy);
        RepairCommand = new AsyncRelayCommand(() => RunEngineAsync("Repairing ActMon..."), () => !_isBusy);
        UpgradeCommand = new AsyncRelayCommand(() => RunEngineAsync("Upgrading ActMon..."), () => !_isBusy);
        ShowUninstallCommand = new RelayCommand(() => ShowUninstallConfirm = true, () => !_isBusy);
        CancelUninstallCommand = new RelayCommand(() => ShowUninstallConfirm = false);
        ConfirmUninstallCommand = new AsyncRelayCommand(UninstallAsync, () => !_isBusy);
    }

    public string InstallDirectory => _manifest.InstallDirectory;
    public string Version => _manifest.Version;
    public string OrganizationName => _manifest.OrganizationName;
    public string InstalledAt => DateTime.TryParse(_manifest.InstalledAtUtc, out var d) ? d.ToLocalTime().ToString("g") : _manifest.InstalledAtUtc;
    public string ActMonUrl => ActMonUrlBuilder.Build(_manifest.AllowRemoteAccess, _manifest.PublicHostOrIp, _manifest.FrontendPort);

    public ObservableCollection<string> ProgressLines { get; } = new();

    public bool IsBusy { get => _isBusy; private set => SetField(ref _isBusy, value); }
    public string BusyLabel { get => _busyLabel; private set => SetField(ref _busyLabel, value); }
    public bool ShowUninstallConfirm { get => _showUninstallConfirm; private set => SetField(ref _showUninstallConfirm, value); }
    public bool AlsoRemoveData { get => _alsoRemoveData; set => SetField(ref _alsoRemoveData, value); }
    public bool Done { get => _done; private set => SetField(ref _done, value); }
    public string? DoneMessage { get => _doneMessage; private set => SetField(ref _doneMessage, value); }
    public string? ErrorMessage { get => _errorMessage; private set => SetField(ref _errorMessage, value); }

    public RelayCommand ModifyCommand { get; }
    public AsyncRelayCommand RepairCommand { get; }
    public AsyncRelayCommand UpgradeCommand { get; }
    public RelayCommand ShowUninstallCommand { get; }
    public RelayCommand CancelUninstallCommand { get; }
    public AsyncRelayCommand ConfirmUninstallCommand { get; }

    private async Task RunEngineAsync(string label)
    {
        IsBusy = true;
        BusyLabel = label;
        Done = false;
        ErrorMessage = null;
        ProgressLines.Clear();

        try
        {
            var ctx = _manifest.LoadFullContext();
            var payload = PayloadResolver.Resolve();
            var result = await _installEngine.RunAsync(ctx, payload, line => ProgressLines.Add(line));

            if (result.Success)
            {
                Done = true;
                DoneMessage = $"{label.TrimEnd('.', '.', '.')} completed successfully.";
            }
            else
            {
                ErrorMessage = $"{result.ErrorComponent}: {result.ErrorProblem} {result.ErrorRecommendedAction}";
            }
        }
        catch (Exception ex)
        {
            ErrorMessage = ex.Message;
        }
        finally
        {
            IsBusy = false;
        }
    }

    private async Task UninstallAsync()
    {
        IsBusy = true;
        BusyLabel = "Uninstalling ActMon...";
        Done = false;
        ErrorMessage = null;
        ProgressLines.Clear();
        ShowUninstallConfirm = false;

        try
        {
            await _uninstallEngine.RemoveApplicationAsync(_manifest, line => ProgressLines.Add(line));

            if (AlsoRemoveData)
            {
                var dbEnvPath = System.IO.Path.Combine(_manifest.InstallDirectory, "database", ".env");
                var postgresPassword = EnvFileWriter.ReadExistingValue(dbEnvPath, "DB_PASS") ?? "";
                var clickHousePassword = EnvFileWriter.ReadExistingValue(dbEnvPath, "ACTMON_LOGS_CH_PASSWORD") ?? "";

                var postgresAdmin = new PostgresConnectionInfo { Host = _manifest.PostgresHost, Port = _manifest.PostgresPort, Username = _manifest.PostgresUsername, Password = postgresPassword };
                var clickHouseAdmin = new ClickHouseConnectionInfo { Host = _manifest.ClickHouseHost, Port = _manifest.ClickHousePort, Database = _manifest.ClickHouseDatabase, Password = clickHousePassword };

                var (ok, msg) = await _uninstallEngine.RemoveDataAsync(_manifest, postgresAdmin, clickHouseAdmin, line => ProgressLines.Add(line));
                if (!ok) { ErrorMessage = msg; IsBusy = false; return; }
            }

            Done = true;
            DoneMessage = "ActMon has been uninstalled.";
        }
        catch (Exception ex)
        {
            ErrorMessage = ex.Message;
        }
        finally
        {
            IsBusy = false;
        }
    }
}
