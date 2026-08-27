using System.IO;
using ActMon.Setup.Core.Models;

namespace ActMon.Setup.Services;

/// <summary>
/// Locates every artifact the Install engine deploys. In the final packaged
/// ActMon.exe these all sit in a "payload" folder shipped next to it; during
/// development (running from the IDE/dotnet build output) they're still under
/// installer/packaging, so this falls back to that layout when "payload" isn't
/// found — letting InstallEngine be exercised for real without waiting on the
/// final single-exe packaging step.
/// </summary>
public static class PayloadResolver
{
    public static InstallPayload Resolve()
    {
        var packagedRoot = Path.Combine(AppContext.BaseDirectory, "payload");
        if (Directory.Exists(packagedRoot))
        {
            return new InstallPayload
            {
                DatabaseServerDir = Path.Combine(packagedRoot, "database-server"),
                CloudServerDir = Path.Combine(packagedRoot, "cloud-server"),
                DbSetupExePath = Path.Combine(packagedRoot, "db-setup", "actmon-db-setup.exe"),
                NginxDir = Path.Combine(packagedRoot, "nginx"),
                FrontendDistDir = Path.Combine(packagedRoot, "frontend-dist"),
                ServiceHostExePath = Path.Combine(packagedRoot, "servicehost", "ActMon.ServiceHost.exe"),
                AgentDistDir = Path.Combine(packagedRoot, "agent-dist"),
            };
        }

        var packagingDir = FindDevPackagingDir();
        return new InstallPayload
        {
            DatabaseServerDir = Path.Combine(packagingDir, "dist", "actmon-database-server"),
            CloudServerDir = Path.Combine(packagingDir, "dist", "actmon-cloud-server"),
            DbSetupExePath = Path.Combine(packagingDir, "dist", "actmon-db-setup", "actmon-db-setup.exe"),
            NginxDir = Path.Combine(packagingDir, "vendor", "nginx"),
            FrontendDistDir = Path.Combine(packagingDir, "..", "..", "frontend", "dist"),
            ServiceHostExePath = Path.Combine(packagingDir, "..", "src", "ActMon.ServiceHost", "bin", "Debug", "net8.0-windows", "ActMon.ServiceHost.exe"),
            // Pre-built (checked-in) agent installers — not produced by any
            // build this installer runs itself, unlike everything else above.
            AgentDistDir = Path.Combine(packagingDir, "..", "..", "Backend", "agent", "dist"),
        };
    }

    private static string FindDevPackagingDir()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            var candidate = Path.Combine(dir.FullName, "installer", "packaging");
            if (Directory.Exists(candidate)) return candidate;

            // Also handle being run from inside installer/src/ActMon.Setup/bin/...
            candidate = Path.Combine(dir.FullName, "packaging");
            if (Directory.Exists(candidate) && dir.Name == "installer") return candidate;

            dir = dir.Parent;
        }
        throw new DirectoryNotFoundException("Could not locate installer/packaging from " + AppContext.BaseDirectory);
    }
}
