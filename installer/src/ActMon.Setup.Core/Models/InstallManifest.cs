using System.Text.Json;
using ActMon.Setup.Core.Services;

namespace ActMon.Setup.Core.Models;

/// <summary>
/// Written once, right after a successful Install, at a fixed well-known path —
/// this is how a later run of ActMon.exe knows an installation already exists
/// (section 22) and can offer Modify/Repair/Upgrade/Uninstall instead of the
/// fresh-install wizard, and it's what Repair reloads to re-run Install with the
/// exact same settings instead of asking the administrator to retype everything.
/// </summary>
public sealed class InstallManifest
{
    public const string Path = @"C:\ProgramData\ActMon\install-manifest.json";

    public required string InstallDirectory { get; init; }
    public required string Version { get; init; }
    public required int FrontendPort { get; init; }
    public required int DatabaseBackendPort { get; init; }
    public required int CloudBackendPort { get; init; }
    public required string PostgresHost { get; init; }
    public required int PostgresPort { get; init; }
    public required string PostgresDatabase { get; init; }
    public required string PostgresUsername { get; init; }
    public required string RedisHost { get; init; }
    public required int RedisPort { get; init; }
    public required string ClickHouseHost { get; init; }
    public required int ClickHousePort { get; init; }
    public required string ClickHouseDatabase { get; init; }
    public required string OrganizationName { get; init; }
    public required string InstalledAtUtc { get; init; }

    // Not `required` — old manifests written before this field existed must
    // still deserialize; AllowRemoteAccess defaults true to match nginx's
    // long-standing de-facto behavior (an unqualified "listen PORT" already
    // binds every interface).
    public bool AllowRemoteAccess { get; init; } = true;
    public string PublicHostOrIp { get; init; } = "";

    public static InstallManifest? TryLoad()
    {
        if (!File.Exists(Path)) return null;
        try
        {
            return JsonSerializer.Deserialize<InstallManifest>(File.ReadAllText(Path));
        }
        catch
        {
            return null;
        }
    }

    public void Save()
    {
        Directory.CreateDirectory(System.IO.Path.GetDirectoryName(Path)!);
        File.WriteAllText(Path, JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true }));
    }

    public static InstallManifest FromContext(InstallerContext ctx, string version) => new()
    {
        InstallDirectory = ctx.InstallDirectory,
        Version = version,
        FrontendPort = ctx.FrontendPort,
        DatabaseBackendPort = ctx.DatabaseBackendPort,
        CloudBackendPort = ctx.CloudBackendPort,
        PostgresHost = ctx.PostgresAdmin.Host,
        PostgresPort = ctx.PostgresAdmin.Port,
        PostgresDatabase = ctx.PostgresAppDatabase,
        PostgresUsername = ctx.PostgresAppUsername,
        RedisHost = ctx.Redis.Host,
        RedisPort = ctx.Redis.Port,
        ClickHouseHost = ctx.ClickHouseAdmin.Host,
        ClickHousePort = ctx.ClickHouseAdmin.Port,
        ClickHouseDatabase = ctx.ClickHouseAppDatabase,
        OrganizationName = ctx.OrganizationName,
        InstalledAtUtc = DateTime.UtcNow.ToString("O"),
        AllowRemoteAccess = ctx.AllowRemoteAccess,
        PublicHostOrIp = ctx.PublicHostOrIp,
    };

    /// <summary>Rehydrates an InstallerContext from a saved manifest — used by
    /// Repair to re-run Install with exactly the settings already on disk,
    /// without asking the administrator to retype everything. Passwords are
    /// deliberately NOT in the manifest (never written to a JSON file) — Repair
    /// re-reads them from the existing .env files instead.</summary>
    public InstallerContext ToContext(string postgresPassword, string redisPassword, string clickHousePassword)
    {
        var ctx = new InstallerContext
        {
            InstallDirectory = InstallDirectory,
            FrontendPort = FrontendPort,
            DatabaseBackendPort = DatabaseBackendPort,
            CloudBackendPort = CloudBackendPort,
            PostgresAppDatabase = PostgresDatabase,
            PostgresAppUsername = PostgresUsername,
            PostgresAppPassword = postgresPassword,
            ClickHouseAppDatabase = ClickHouseDatabase,
            OrganizationName = OrganizationName,
            UsingExistingOrg = true,
            AllowRemoteAccess = AllowRemoteAccess,
            PublicHostOrIp = PublicHostOrIp,
        };
        ctx.PostgresAdmin.Host = PostgresHost;
        ctx.PostgresAdmin.Port = PostgresPort;
        ctx.PostgresAdmin.Username = PostgresUsername;
        ctx.PostgresAdmin.Password = postgresPassword;
        ctx.Redis.Host = RedisHost;
        ctx.Redis.Port = RedisPort;
        ctx.Redis.Password = redisPassword;
        ctx.ClickHouseAdmin.Host = ClickHouseHost;
        ctx.ClickHouseAdmin.Port = ClickHousePort;
        ctx.ClickHouseAdmin.Database = ClickHouseDatabase;
        ctx.ClickHouseAdmin.Password = clickHousePassword;
        return ctx;
    }

    /// <summary>Rehydrates a full InstallerContext straight off disk — reads
    /// this manifest's own fields (including, crucially, InstallDirectory) plus
    /// the passwords back out of the existing deployment's own .env file. This
    /// is what lets Repair, Upgrade and Modify all reuse the exact settings
    /// already on this machine instead of asking the administrator to retype
    /// everything, and what keeps the installation directory pinned to where
    /// ActMon already lives unless they explicitly change it in the wizard.</summary>
    public InstallerContext LoadFullContext()
    {
        var dbEnvPath = System.IO.Path.Combine(InstallDirectory, "database", ".env");
        var postgresPassword = EnvFileWriter.ReadExistingValue(dbEnvPath, "DB_PASS") ?? "";
        var redisPassword = EnvFileWriter.ExtractRedisPasswordFromUrl(EnvFileWriter.ReadExistingValue(dbEnvPath, "REDIS_URL"));
        var clickHousePassword = EnvFileWriter.ReadExistingValue(dbEnvPath, "ACTMON_LOGS_CH_PASSWORD") ?? "";
        return ToContext(postgresPassword, redisPassword, clickHousePassword);
    }
}
