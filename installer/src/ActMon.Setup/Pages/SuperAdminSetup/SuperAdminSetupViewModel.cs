using System.Text.RegularExpressions;
using ActMon.Setup.Core.Services;
using ActMon.Setup.Core.Models;
using ActMon.Setup.Mvvm;

namespace ActMon.Setup.Pages.SuperAdminSetup;

public sealed class SuperAdminSetupViewModel : ViewModelBase, IWizardPageViewModel
{
    private static readonly Regex EmailRegex = new(@"^[^@\s]+@[^@\s]+\.[^@\s]+$", RegexOptions.Compiled);

    private readonly InstallerContext _ctx;
    private readonly SchemaProbeService _probe = new();

    private bool _isChecking = true;
    private bool _adminAlreadyExists;
    private string _fullName = "";
    private string _email = "";
    private string _username = "";
    private string _password = "";
    private string _confirmPassword = "";
    private string? _validationError;
    private bool _confirmed;
    private string? _probeError;
    private bool _canGoNext;

    public SuperAdminSetupViewModel(InstallerContext ctx)
    {
        _ctx = ctx;
        ConfirmCommand = new AsyncRelayCommand(ConfirmAsync);
    }

    public bool IsChecking { get => _isChecking; private set => SetField(ref _isChecking, value); }
    public bool AdminAlreadyExists { get => _adminAlreadyExists; private set => SetField(ref _adminAlreadyExists, value); }
    public string? ProbeError { get => _probeError; private set => SetField(ref _probeError, value); }

    public string FullName { get => _fullName; set => SetField(ref _fullName, value); }
    public string Email { get => _email; set => SetField(ref _email, value); }
    public string Username { get => _username; set => SetField(ref _username, value); }
    public string Password { get => _password; set => SetField(ref _password, value); }
    public string ConfirmPassword { get => _confirmPassword; set => SetField(ref _confirmPassword, value); }
    public string? ValidationError { get => _validationError; private set => SetField(ref _validationError, value); }
    public bool Confirmed { get => _confirmed; private set => SetField(ref _confirmed, value); }

    public AsyncRelayCommand ConfirmCommand { get; }

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
            var hasTable = await _probe.TableExistsAsync(_ctx.PostgresAdmin, _ctx.PostgresAppDatabase, "user_master");
            if (hasTable)
            {
                var count = await _probe.ScalarLongAsync(_ctx.PostgresAdmin, _ctx.PostgresAppDatabase,
                    "SELECT COUNT(*) FROM user_master WHERE deleted_at IS NULL");
                if (count > 0)
                {
                    AdminAlreadyExists = true;
                    CanGoNext = true;
                }
            }
        }
        catch (Exception ex)
        {
            ProbeError = $"Could not check for an existing Super Admin: {ex.Message}";
        }
        IsChecking = false;
    }

    private async Task ConfirmAsync()
    {
        var name = FullName.Trim();
        var email = Email.Trim();
        var username = Username.Trim();

        if (string.IsNullOrEmpty(name))
        {
            ValidationError = "Full name is required.";
            return;
        }
        if (!EmailRegex.IsMatch(email))
        {
            ValidationError = "A valid email address is required.";
            return;
        }
        if (string.IsNullOrEmpty(username))
        {
            ValidationError = "Username is required.";
            return;
        }
        if (Password.Length < 6)
        {
            ValidationError = "Password must be at least 6 characters.";
            return;
        }
        if (Password != ConfirmPassword)
        {
            ValidationError = "Passwords do not match.";
            return;
        }

        try
        {
            var hasTable = await _probe.TableExistsAsync(_ctx.PostgresAdmin, _ctx.PostgresAppDatabase, "user_master");
            if (hasTable)
            {
                var taken = await _probe.CountUsersWithUsernameAsync(_ctx.PostgresAdmin, _ctx.PostgresAppDatabase, username);
                if (taken > 0)
                {
                    ValidationError = $"Username '{username}' is already taken.";
                    return;
                }
            }
        }
        catch (Exception ex)
        {
            ValidationError = $"Could not verify username uniqueness: {ex.Message}";
            return;
        }

        ValidationError = null;
        _ctx.SuperAdminFullName = name;
        _ctx.SuperAdminEmail = email;
        _ctx.SuperAdminUsername = username;
        _ctx.SuperAdminPassword = Password;
        Confirmed = true;
        CanGoNext = true;
    }
}
