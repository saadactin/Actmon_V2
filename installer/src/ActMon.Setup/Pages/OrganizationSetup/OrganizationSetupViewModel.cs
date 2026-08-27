using ActMon.Setup.Core.Services;
using ActMon.Setup.Core.Models;
using ActMon.Setup.Mvvm;

namespace ActMon.Setup.Pages.OrganizationSetup;

public sealed class OrganizationSetupViewModel : ViewModelBase, IWizardPageViewModel
{
    private readonly InstallerContext _ctx;
    private readonly SchemaProbeService _probe = new();

    private bool _isChecking = true;
    private bool _schemaHasOrganization;
    private string _existingOrgName = "";
    private bool _existingConfirmed;
    private string _newOrgName = "";
    private string? _validationError;
    private bool _newConfirmed;
    private string? _probeError;
    private bool _canGoNext;

    public OrganizationSetupViewModel(InstallerContext ctx)
    {
        _ctx = ctx;
        ConfirmExistingCommand = new RelayCommand(ConfirmExisting);
        ConfirmNewCommand = new RelayCommand(ConfirmNew);
    }

    public bool IsChecking { get => _isChecking; private set => SetField(ref _isChecking, value); }
    public bool SchemaHasOrganization { get => _schemaHasOrganization; private set => SetField(ref _schemaHasOrganization, value); }
    public string ExistingOrgName { get => _existingOrgName; private set => SetField(ref _existingOrgName, value); }
    public bool ExistingConfirmed { get => _existingConfirmed; private set => SetField(ref _existingConfirmed, value); }

    public string NewOrgName { get => _newOrgName; set => SetField(ref _newOrgName, value); }
    public string? ValidationError { get => _validationError; private set => SetField(ref _validationError, value); }
    public bool NewConfirmed { get => _newConfirmed; private set => SetField(ref _newConfirmed, value); }
    public string? ProbeError { get => _probeError; private set => SetField(ref _probeError, value); }

    public RelayCommand ConfirmExistingCommand { get; }
    public RelayCommand ConfirmNewCommand { get; }

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
        ProbeError = null;
        try
        {
            var hasTable = await _probe.TableExistsAsync(_ctx.PostgresAdmin, _ctx.PostgresAppDatabase, "organization_master");
            if (hasTable)
            {
                var name = await _probe.ScalarStringAsync(_ctx.PostgresAdmin, _ctx.PostgresAppDatabase,
                    "SELECT org_name FROM organization_master WHERE org_id = 1");
                if (!string.IsNullOrWhiteSpace(name))
                {
                    SchemaHasOrganization = true;
                    ExistingOrgName = name;
                }
            }
        }
        catch (Exception ex)
        {
            ProbeError = $"Could not check for an existing organization: {ex.Message}";
        }
        IsChecking = false;
    }

    private void ConfirmExisting()
    {
        _ctx.OrganizationName = ExistingOrgName;
        _ctx.UsingExistingOrg = true;
        ExistingConfirmed = true;
        CanGoNext = true;
    }

    private void ConfirmNew()
    {
        var name = NewOrgName.Trim();
        if (name.Length is < 2 or > 120)
        {
            ValidationError = "Organization name must be between 2 and 120 characters.";
            return;
        }

        ValidationError = null;
        _ctx.OrganizationName = name;
        _ctx.UsingExistingOrg = false;
        NewConfirmed = true;
        CanGoNext = true;
    }
}
