using System.Text;
using ActMon.Setup.Core.Models;

namespace ActMon.Setup.Core.Services;

/// <summary>
/// Writes the two backend .env files with exactly the keys traced from
/// Backend/database/.env.example and Backend/cloud/.env — never invented names.
/// JWT_SECRET and ACTMON_ENCRYPTION_KEY are shared verbatim between both files
/// (the app's own docs require this: same JWT verification, one encryption key).
/// </summary>
public static class EnvFileWriter
{
    /// <summary>Reads one key's value out of an existing .env file, or null if the
    /// file or key doesn't exist. Used to preserve JWT_SECRET/ACTMON_ENCRYPTION_KEY
    /// across a re-run — regenerating ACTMON_ENCRYPTION_KEY on an install that
    /// already has data would make every previously-encrypted credential in the
    /// database permanently unreadable, per its own documented "no fallback" rule.</summary>
    public static string? ReadExistingValue(string path, string key)
    {
        if (!File.Exists(path)) return null;
        var prefix = key + "=";
        var line = File.ReadAllLines(path).FirstOrDefault(l => l.StartsWith(prefix, StringComparison.Ordinal));
        var value = line?[prefix.Length..].Trim();
        return string.IsNullOrEmpty(value) ? null : value;
    }

    public static void WriteDatabaseEnv(string path, InstallerContext ctx, string jwtSecret, string encryptionKey)
    {
        var sb = new StringBuilder();
        sb.AppendLine($"DB_HOST={ctx.PostgresAdmin.Host}");
        sb.AppendLine($"DB_PORT={ctx.PostgresAdmin.Port}");
        sb.AppendLine($"DB_USER={ctx.PostgresAppUsername}");
        sb.AppendLine($"DB_PASS={ctx.PostgresAppPassword}");
        sb.AppendLine($"DB_NAME={ctx.PostgresAppDatabase}");
        sb.AppendLine();
        sb.AppendLine($"ORG_NAME={ctx.OrganizationName}");
        sb.AppendLine($"ADMIN_EMAIL={ctx.SuperAdminEmail}");
        sb.AppendLine();
        sb.AppendLine($"JWT_SECRET={jwtSecret}");
        sb.AppendLine($"ACTMON_ENCRYPTION_KEY={encryptionKey}");
        sb.AppendLine();
        sb.AppendLine("GROQ_API_KEY=");
        sb.AppendLine();
        sb.AppendLine("SMTP_HOST=");
        sb.AppendLine("SMTP_PORT=587");
        sb.AppendLine("SMTP_USER=");
        sb.AppendLine("SMTP_PASS=");
        sb.AppendLine("SMTP_FROM=");
        sb.AppendLine();
        sb.AppendLine("ACTMON_MYSQL_SSH_USERNAME=");
        sb.AppendLine("ACTMON_MYSQL_SSH_PASSWORD=");
        sb.AppendLine();
        sb.AppendLine($"REDIS_URL={BuildRedisUrl(ctx)}");
        sb.AppendLine();
        sb.AppendLine("ACTMON_LOGS_ENABLED=true");
        sb.AppendLine($"ACTMON_LOGS_CH_HOST={ctx.ClickHouseAdmin.Host}");
        sb.AppendLine($"ACTMON_LOGS_CH_PORT={ctx.ClickHouseAdmin.Port}");
        sb.AppendLine($"ACTMON_LOGS_CH_USER={ctx.ClickHouseAdmin.Username}");
        sb.AppendLine($"ACTMON_LOGS_CH_PASSWORD={ctx.ClickHouseAdmin.Password}");
        sb.AppendLine($"ACTMON_LOGS_CH_DB={ctx.ClickHouseAppDatabase}");

        File.WriteAllText(path, sb.ToString());
    }

    public static void WriteCloudEnv(string path, InstallerContext ctx, string jwtSecret, string encryptionKey)
    {
        var passEncoded = Uri.EscapeDataString(ctx.PostgresAppPassword);
        var databaseUrl = $"postgresql://{ctx.PostgresAppUsername}:{passEncoded}@{ctx.PostgresAdmin.Host}:{ctx.PostgresAdmin.Port}/{ctx.PostgresAppDatabase}";

        var sb = new StringBuilder();
        sb.AppendLine($"DATABASE_URL={databaseUrl}");
        sb.AppendLine($"DB_USER={ctx.PostgresAppUsername}");
        sb.AppendLine($"DB_PASS={ctx.PostgresAppPassword}");
        sb.AppendLine($"DB_HOST={ctx.PostgresAdmin.Host}");
        sb.AppendLine($"DB_PORT={ctx.PostgresAdmin.Port}");
        sb.AppendLine($"DB_NAME={ctx.PostgresAppDatabase}");
        sb.AppendLine();
        sb.AppendLine($"CLOUD_SERVICE_PORT={ctx.CloudBackendPort}");
        sb.AppendLine();
        sb.AppendLine($"JWT_SECRET={jwtSecret}");
        sb.AppendLine($"ACTMON_ENCRYPTION_KEY={encryptionKey}");

        File.WriteAllText(path, sb.ToString());
    }

    private static string BuildRedisUrl(InstallerContext ctx)
    {
        var auth = string.IsNullOrEmpty(ctx.Redis.Password) ? "" : $":{Uri.EscapeDataString(ctx.Redis.Password)}@";
        return $"redis://{auth}{ctx.Redis.Host}:{ctx.Redis.Port}/0";
    }

    /// <summary>Pulls the password back out of a REDIS_URL written by
    /// BuildRedisUrl — used when re-hydrating an InstallerContext from a
    /// previous install's .env for Repair/Upgrade/Modify, since the manifest
    /// itself never stores passwords.</summary>
    public static string ExtractRedisPasswordFromUrl(string? redisUrl)
    {
        if (string.IsNullOrEmpty(redisUrl)) return "";
        try
        {
            var uri = new Uri(redisUrl);
            var userInfo = uri.UserInfo;
            if (string.IsNullOrEmpty(userInfo)) return "";
            var parts = userInfo.Split(':', 2);
            return Uri.UnescapeDataString(parts.Length > 1 ? parts[1] : parts[0]);
        }
        catch
        {
            return "";
        }
    }
}
