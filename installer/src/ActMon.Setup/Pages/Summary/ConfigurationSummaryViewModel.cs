using ActMon.Setup.Core.Models;

namespace ActMon.Setup.Pages.Summary;

public sealed class ConfigurationSummaryViewModel : SummaryPageViewModelBase
{
    public ConfigurationSummaryViewModel(InstallerContext ctx)
        : base(ctx, "Configuration Summary", "Final review before installing. Passwords are never shown here.")
    {
    }
}
