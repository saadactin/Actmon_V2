using ActMon.Setup.Core.Models;

namespace ActMon.Setup.Pages.Summary;

public sealed class ApplicationConfigurationViewModel : SummaryPageViewModelBase
{
    public ApplicationConfigurationViewModel(InstallerContext ctx)
        : base(ctx, "Application Configuration", "Everything collected so far. Go Back to change anything before continuing.")
    {
    }
}
