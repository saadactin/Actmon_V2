using ActMon.Setup.Core.Models;

namespace ActMon.Setup.Core.Services;

/// <summary>Single place that decides what URL to show/open for "the running
/// ActMon instance" — localhost when remote access isn't enabled or no
/// public host/IP was given, the configured public host/IP otherwise. Used
/// by the Start Menu shortcut, Installation Complete, and the "already
/// installed" screen, so all three always agree.</summary>
public static class ActMonUrlBuilder
{
    public static string Build(bool allowRemoteAccess, string? publicHostOrIp, int frontendPort)
    {
        var host = allowRemoteAccess && !string.IsNullOrWhiteSpace(publicHostOrIp) ? publicHostOrIp.Trim() : "localhost";
        return $"http://{host}:{frontendPort}";
    }

    public static string Build(InstallerContext ctx) => Build(ctx.AllowRemoteAccess, ctx.PublicHostOrIp, ctx.FrontendPort);
}
