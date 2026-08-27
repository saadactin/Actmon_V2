using System.Collections.ObjectModel;
using System.Windows.Input;
using ActMon.Setup.Core.Models;
using ActMon.Setup.Models;
using ActMon.Setup.Mvvm;
using ActMon.Setup.Pages.DependencyPreCheck;
using ActMon.Setup.Pages.Placeholder;
using ActMon.Setup.Pages.PortConfiguration;
using ActMon.Setup.Pages.PostgresConfiguration;
using ActMon.Setup.Pages.RedisConfiguration;
using ActMon.Setup.Pages.ClickHouseConfiguration;
using ActMon.Setup.Pages.OrganizationSetup;
using ActMon.Setup.Pages.SuperAdminSetup;
using ActMon.Setup.Pages.SmtpConfiguration;
using ActMon.Setup.Pages.Summary;
using ActMon.Setup.Pages.Install;
using ActMon.Setup.Pages.WindowsServices;
using ActMon.Setup.Pages.Firewall;
using ActMon.Setup.Pages.HealthCheck;
using ActMon.Setup.Pages.Complete;
using ActMon.Setup.Pages.SystemRequirements;
using ActMon.Setup.Pages.Welcome;

namespace ActMon.Setup.Shell;

public sealed class WizardShellViewModel : ViewModelBase
{
    private static readonly (WizardStepId Id, string Title)[] StepDefinitions =
    {
        (WizardStepId.Welcome, "Welcome"),
        (WizardStepId.SystemRequirements, "System Requirements"),
        (WizardStepId.DependencyPreCheck, "Dependency Pre-check"),
        (WizardStepId.PortConfiguration, "Port Configuration"),
        (WizardStepId.PostgreSqlConfiguration, "PostgreSQL Configuration"),
        (WizardStepId.RedisConfiguration, "Redis Configuration"),
        (WizardStepId.ClickHouseConfiguration, "ClickHouse Configuration"),
        (WizardStepId.OrganizationSetup, "Organization Setup"),
        (WizardStepId.SuperAdminSetup, "Super Admin Setup"),
        (WizardStepId.SmtpConfiguration, "SMTP Configuration"),
        (WizardStepId.ApplicationConfiguration, "Application Configuration"),
        (WizardStepId.ConfigurationSummary, "Configuration Summary"),
        (WizardStepId.Install, "Install"),
        (WizardStepId.WindowsServices, "Windows Services"),
        (WizardStepId.Firewall, "Firewall"),
        (WizardStepId.HealthCheck, "Health Check"),
        (WizardStepId.InstallationComplete, "Installation Complete"),
    };

    private readonly InstallerContext _ctx;
    private readonly Dictionary<WizardStepId, IWizardPageViewModel> _pageCache = new();
    private int _currentIndex;
    private IWizardPageViewModel? _currentPage;
    private bool _isNavigating;

    /// <summary>existingContext is supplied when the wizard is entered via
    /// "Modify" on an already-installed machine (RootViewModel) — it carries
    /// over everything already on disk, most importantly InstallDirectory, so
    /// Modify never silently resets the install path back to the default.
    /// Omitted (null) for a genuinely fresh install, which starts from
    /// InstallerContext's own defaults.</summary>
    public WizardShellViewModel(InstallerContext? existingContext = null)
    {
        _ctx = existingContext ?? new InstallerContext();
        Steps = new ObservableCollection<WizardStepEntry>(
            StepDefinitions.Select(d => new WizardStepEntry { Id = d.Id, Title = d.Title }));

        NextCommand = new AsyncRelayCommand(NextAsync, () => !_isNavigating && (CurrentPage?.CanGoNext ?? false));
        BackCommand = new RelayCommand(Back, () => !_isNavigating && _currentIndex > 0);
        CancelCommand = new RelayCommand(Cancel);

        _ = NavigateToAsync(0);
    }

    public ObservableCollection<WizardStepEntry> Steps { get; }

    public IWizardPageViewModel? CurrentPage
    {
        get => _currentPage;
        private set => SetField(ref _currentPage, value);
    }

    public string NextButtonLabel => _currentIndex >= StepDefinitions.Length - 1 ? "Finish" : "Next";

    public ICommand NextCommand { get; }
    public ICommand BackCommand { get; }
    public ICommand CancelCommand { get; }

    private async Task NextAsync()
    {
        if (_currentIndex < StepDefinitions.Length - 1)
            await NavigateToAsync(_currentIndex + 1);
    }

    private void Back()
    {
        if (_currentIndex > 0)
            _ = NavigateToAsync(_currentIndex - 1);
    }

    private static void Cancel() => System.Windows.Application.Current.Shutdown();

    private async Task NavigateToAsync(int index)
    {
        _isNavigating = true;
        CommandManager.InvalidateRequerySuggested();

        if (CurrentPage is not null)
            CurrentPage.CanGoNextChanged -= OnCurrentPageCanGoNextChanged;

        for (var i = 0; i < Steps.Count; i++)
        {
            Steps[i].IsCurrent = i == index;
            Steps[i].IsCompleted = i < index;
        }

        _currentIndex = index;
        var stepId = StepDefinitions[index].Id;

        if (!_pageCache.TryGetValue(stepId, out var page))
        {
            page = CreatePage(stepId, StepDefinitions[index].Title);
            _pageCache[stepId] = page;
        }

        CurrentPage = page;
        OnPropertyChanged(nameof(NextButtonLabel));
        page.CanGoNextChanged += OnCurrentPageCanGoNextChanged;

        await page.OnNavigatedToAsync();

        _isNavigating = false;
        CommandManager.InvalidateRequerySuggested();
    }

    private void OnCurrentPageCanGoNextChanged(object? sender, EventArgs e) =>
        CommandManager.InvalidateRequerySuggested();

    private IWizardPageViewModel CreatePage(WizardStepId id, string title) => id switch
    {
        WizardStepId.Welcome => new WelcomeViewModel(_ctx),
        WizardStepId.SystemRequirements => new SystemRequirementsViewModel(_ctx),
        WizardStepId.DependencyPreCheck => new DependencyPreCheckViewModel(_ctx),
        WizardStepId.PortConfiguration => new PortConfigurationViewModel(_ctx),
        WizardStepId.PostgreSqlConfiguration => new PostgresConfigurationViewModel(_ctx),
        WizardStepId.RedisConfiguration => new RedisConfigurationViewModel(_ctx),
        WizardStepId.ClickHouseConfiguration => new ClickHouseConfigurationViewModel(_ctx),
        WizardStepId.OrganizationSetup => new OrganizationSetupViewModel(_ctx),
        WizardStepId.SuperAdminSetup => new SuperAdminSetupViewModel(_ctx),
        WizardStepId.SmtpConfiguration => new SmtpConfigurationViewModel(_ctx),
        WizardStepId.ApplicationConfiguration => new ApplicationConfigurationViewModel(_ctx),
        WizardStepId.ConfigurationSummary => new ConfigurationSummaryViewModel(_ctx),
        WizardStepId.Install => new InstallViewModel(_ctx),
        WizardStepId.WindowsServices => new WindowsServicesViewModel(_ctx),
        WizardStepId.Firewall => new FirewallViewModel(_ctx),
        WizardStepId.HealthCheck => new HealthCheckViewModel(_ctx),
        WizardStepId.InstallationComplete => new InstallationCompleteViewModel(_ctx),
        _ => new PlaceholderViewModel(title),
    };
}
