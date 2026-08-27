using System.Text.RegularExpressions;
using ActMon.Setup.Core.Models;
using ActMon.Setup.Mvvm;

namespace ActMon.Setup.Pages.SmtpConfiguration;

/// <summary>
/// Entirely optional — sign-in never depends on SMTP (see InstallEngine/the
/// backend's own login route), so this only controls whether the one-time
/// login code can be emailed. Defaults to skipped; the administrator can
/// configure it now, or later from ActMon's own Settings.
/// </summary>
public sealed class SmtpConfigurationViewModel : ViewModelBase, IWizardPageViewModel
{
    private static readonly Regex EmailRegex = new(@"^[^@\s]+@[^@\s]+\.[^@\s]+$", RegexOptions.Compiled);

    private readonly InstallerContext _ctx;
    private bool _configureNow;
    private string? _validationError;

    public SmtpConfigurationViewModel(InstallerContext ctx)
    {
        _ctx = ctx;
        _configureNow = !string.IsNullOrWhiteSpace(ctx.SmtpHost);
    }

    public bool ConfigureNow
    {
        get => _configureNow;
        set
        {
            if (!SetField(ref _configureNow, value)) return;
            OnPropertyChanged(nameof(CanGoNext));
            Revalidate();
        }
    }

    public string Host { get => _ctx.SmtpHost; set { _ctx.SmtpHost = value; OnPropertyChanged(); Revalidate(); } }
    public int Port { get => _ctx.SmtpPort; set { _ctx.SmtpPort = value; OnPropertyChanged(); } }
    public string Username { get => _ctx.SmtpUsername; set { _ctx.SmtpUsername = value; OnPropertyChanged(); } }
    public string Password { get => _ctx.SmtpPassword; set { _ctx.SmtpPassword = value; OnPropertyChanged(); } }
    public bool UseTls { get => _ctx.SmtpUseTls; set { _ctx.SmtpUseTls = value; OnPropertyChanged(); } }
    public string SenderEmail { get => _ctx.SmtpSenderEmail; set { _ctx.SmtpSenderEmail = value; OnPropertyChanged(); Revalidate(); } }
    public string SenderName { get => _ctx.SmtpSenderName; set { _ctx.SmtpSenderName = value; OnPropertyChanged(); } }

    public string? ValidationError { get => _validationError; private set => SetField(ref _validationError, value); }

    public bool CanGoNext => !ConfigureNow || ValidationError is null;

    public event EventHandler? CanGoNextChanged;

    public Task OnNavigatedToAsync()
    {
        Revalidate();
        return Task.CompletedTask;
    }

    private void Revalidate()
    {
        var wasValid = CanGoNext;
        if (!ConfigureNow)
        {
            ValidationError = null;
        }
        else if (string.IsNullOrWhiteSpace(Host))
        {
            ValidationError = "SMTP host is required.";
        }
        else if (!EmailRegex.IsMatch(SenderEmail.Trim()))
        {
            ValidationError = "A valid sender email address is required.";
        }
        else
        {
            ValidationError = null;
        }

        if (wasValid != CanGoNext)
            CanGoNextChanged?.Invoke(this, EventArgs.Empty);
    }
}
