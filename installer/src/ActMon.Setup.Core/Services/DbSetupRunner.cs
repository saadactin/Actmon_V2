using System.Diagnostics;
using ActMon.Setup.Core.Models;

namespace ActMon.Setup.Core.Services;

/// <summary>Runs the frozen actmon-db-setup.exe (schema.sql + config seed + baseline
/// tenant, exactly the real db_setup.py — see its own docstring) with real DB
/// creds as environment variables, bypassing any of its own .env-file discovery
/// entirely. It always exits after printing a "SUMMARY_JSON:" line whether the
/// database was fresh or already provisioned — genuinely idempotent, so calling
/// it is always safe.</summary>
public sealed class DbSetupRunner
{
    public async Task<DbSetupResult> RunAsync(string exePath, PostgresConnectionInfo admin, string databaseName, string orgName, string adminEmail)
    {
        var psi = new ProcessStartInfo(exePath)
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
            WorkingDirectory = Path.GetDirectoryName(exePath),
        };
        psi.Environment["DB_HOST"] = admin.Host;
        psi.Environment["DB_PORT"] = admin.Port.ToString();
        psi.Environment["DB_USER"] = admin.Username;
        psi.Environment["DB_PASS"] = admin.Password;
        psi.Environment["DB_NAME"] = databaseName;
        psi.Environment["ORG_NAME"] = orgName;
        psi.Environment["ADMIN_EMAIL"] = adminEmail;

        using var proc = Process.Start(psi)!;
        var stdout = await proc.StandardOutput.ReadToEndAsync();
        var stderr = await proc.StandardError.ReadToEndAsync();
        await proc.WaitForExitAsync();

        var summaryLine = stdout.Split('\n').FirstOrDefault(l => l.StartsWith("SUMMARY_JSON:", StringComparison.Ordinal));

        return new DbSetupResult
        {
            Success = proc.ExitCode == 0,
            RawOutput = stdout + stderr,
            SummaryJson = summaryLine?["SUMMARY_JSON:".Length..].Trim(),
        };
    }
}
