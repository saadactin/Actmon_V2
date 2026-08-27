using ActMon.Setup.Core.Models;

namespace ActMon.Setup.Core.Services;

/// <summary>
/// Section 23 — removes the ActMon application (services, firewall rules,
/// deployed files) and, only ever as a second, separately-confirmed step, the
/// application's own PostgreSQL/ClickHouse databases. Never touches
/// PostgreSQL, Redis or ClickHouse themselves, and never removes data without
/// that explicit second confirmation.
/// </summary>
public sealed class UninstallEngine
{
    private readonly WindowsServiceManager _services = new();
    private readonly FirewallManager _firewall = new();
    private readonly ShortcutManager _shortcuts = new();
    private readonly AddRemoveProgramsManager _addRemovePrograms = new();

    public async Task RemoveApplicationAsync(InstallManifest manifest, Action<string> onProgress)
    {
        onProgress("Stopping and removing Windows Services...");
        foreach (var name in new[] { InstallEngine.DatabaseServiceName, InstallEngine.CloudServiceName, InstallEngine.FrontendServiceName })
        {
            if (_services.Exists(name))
                await _services.DeleteAsync(name);
        }

        onProgress("Removing firewall rules...");
        foreach (var port in new[] { manifest.FrontendPort, manifest.DatabaseBackendPort, manifest.CloudBackendPort })
            await _firewall.RemoveRuleAsync(port);

        onProgress("Removing shortcut and Add/Remove Programs entry...");
        _shortcuts.RemoveStartMenuShortcut();
        _addRemovePrograms.Unregister();

        onProgress("Removing deployed files...");
        if (Directory.Exists(manifest.InstallDirectory))
        {
            // If Uninstall was launched via the shortcut or Add/Remove Programs,
            // the running process's own exe lives inside this directory — Windows
            // won't let a running executable delete itself, so this can leave
            // that one file behind even though everything else is removed.
            try { Directory.Delete(manifest.InstallDirectory, recursive: true); }
            catch (Exception ex) { onProgress($"Could not fully remove {manifest.InstallDirectory} (this is expected if ActMon.exe there is still running): {ex.Message}"); }
        }

        onProgress("Application removed.");
        if (File.Exists(InstallManifest.Path))
            File.Delete(InstallManifest.Path);
    }

    /// <summary>Drops the app's own PostgreSQL and ClickHouse databases —
    /// separate, deliberately harder-to-reach method so a caller can never
    /// invoke it by accident alongside RemoveApplicationAsync.</summary>
    public async Task<(bool success, string message)> RemoveDataAsync(InstallManifest manifest, PostgresConnectionInfo postgresAdmin, ClickHouseConnectionInfo clickHouseAdmin, Action<string> onProgress)
    {
        try
        {
            onProgress("Dropping PostgreSQL database...");
            var pg = new PostgresConfigService();
            await pg.DropDatabaseAsync(postgresAdmin, manifest.PostgresDatabase);

            onProgress("Dropping ClickHouse database...");
            var ch = new ClickHouseConfigService();
            await ch.DropDatabaseAsync(clickHouseAdmin, manifest.ClickHouseDatabase);

            onProgress("Data removed.");
            return (true, "Data removed.");
        }
        catch (Exception ex)
        {
            return (false, ex.Message);
        }
    }
}
