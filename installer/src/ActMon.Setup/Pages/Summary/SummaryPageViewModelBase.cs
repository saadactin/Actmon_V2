using ActMon.Setup.Core.Models;
using ActMon.Setup.Core.Services;
using ActMon.Setup.Mvvm;

namespace ActMon.Setup.Pages.Summary;

/// <summary>
/// Sections 14 (Application Configuration) and 15 (Configuration Summary) both
/// show the same read-only review of everything collected so far — this shared
/// base (and the one SummaryPage view keyed on it) avoids building the same
/// display twice for what the spec treats as two separate wizard steps.
/// </summary>
public abstract class SummaryPageViewModelBase : ViewModelBase, IWizardPageViewModel
{
    protected readonly InstallerContext Ctx;

    protected SummaryPageViewModelBase(InstallerContext ctx, string heading, string subheading)
    {
        Ctx = ctx;
        Heading = heading;
        Subheading = subheading;
    }

    public string Heading { get; }
    public string Subheading { get; }

    public string InstallDirectory => Ctx.InstallDirectory;

    public string PostgresHost => Ctx.PostgresAdmin.Host;
    public int PostgresPort => Ctx.PostgresAdmin.Port;
    public string PostgresDatabase => Ctx.PostgresAppDatabase;
    public string PostgresUsername => Ctx.PostgresAppUsername;

    public string RedisHost => Ctx.Redis.Host;
    public int RedisPort => Ctx.Redis.Port;

    public string ClickHouseHost => Ctx.ClickHouseAdmin.Host;
    public int ClickHousePort => Ctx.ClickHouseAdmin.Port;
    public string ClickHouseDatabase => Ctx.ClickHouseAppDatabase;
    public string ClickHouseUsername => Ctx.ClickHouseAdmin.Username;

    public string OrganizationName => Ctx.OrganizationName;

    public string SuperAdminUsername => Ctx.SuperAdminUsername;
    public string SuperAdminStatusText => string.IsNullOrEmpty(Ctx.SuperAdminUsername)
        ? "(using existing Super Admin already in this database)"
        : Ctx.SuperAdminUsername;

    public int FrontendPort => Ctx.FrontendPort;
    public int DatabaseBackendPort => Ctx.DatabaseBackendPort;
    public int CloudBackendPort => Ctx.CloudBackendPort;
    public string NetworkAccess => Ctx.AllowRemoteAccess ? "Other machines on the network" : "This machine only (localhost)";
    public string ActMonUrl => ActMonUrlBuilder.Build(Ctx);

    public bool CanGoNext => true;
    public event EventHandler? CanGoNextChanged { add { } remove { } }
    public Task OnNavigatedToAsync() => Task.CompletedTask;
}
