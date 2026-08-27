using System.Net.Http;
using System.ServiceProcess;
using ActMon.Setup.Core.Models;

namespace ActMon.Setup.Core.Services;

/// <summary>
/// Real, post-install verification for section 20 — every check here performs an
/// actual connection or HTTP request; none report success merely because a file
/// was written or a service object was created.
/// </summary>
public sealed class HealthChecker
{
    public async Task<List<HealthCheckResult>> RunAllAsync(
        InstallerContext ctx,
        string frontendServiceName, string dbServiceName, string cloudServiceName)
    {
        var results = new List<HealthCheckResult>
        {
            await CheckHttpAsync("Frontend", $"http://127.0.0.1:{ctx.FrontendPort}/"),
            await CheckHttpAsync("Database Backend", $"http://127.0.0.1:{ctx.DatabaseBackendPort}/"),
            await CheckHttpAsync("Cloud Backend", $"http://127.0.0.1:{ctx.CloudBackendPort}/"),
        };

        var pg = new PostgresConfigService();
        var (pgOk, pgMsg) = await pg.TestConnectionAsync(new PostgresConnectionInfo
        {
            Host = ctx.PostgresAdmin.Host, Port = ctx.PostgresAdmin.Port,
            Username = ctx.PostgresAppUsername, Password = ctx.PostgresAppPassword,
        });
        results.Add(new HealthCheckResult { Name = "PostgreSQL", Passed = pgOk, Details = pgMsg });

        var redis = new RedisConfigService();
        var (redisOk, redisMsg) = await redis.TestConnectionAsync(ctx.Redis);
        results.Add(new HealthCheckResult { Name = "Redis", Passed = redisOk, Details = redisMsg });

        var ch = new ClickHouseConfigService();
        var (chOk, chMsg) = await ch.TestConnectionAsync(ctx.ClickHouseAdmin);
        results.Add(new HealthCheckResult { Name = "ClickHouse", Passed = chOk, Details = chMsg });

        var svc = new WindowsServiceManager();
        foreach (var (label, name) in new[] { ("Windows Service — Frontend", frontendServiceName), ("Windows Service — Database Backend", dbServiceName), ("Windows Service — Cloud Backend", cloudServiceName) })
        {
            var status = svc.GetStatus(name);
            results.Add(new HealthCheckResult { Name = label, Passed = status == ServiceControllerStatus.Running, Details = status?.ToString() ?? "not found" });
        }

        var probe = new SchemaProbeService();
        try
        {
            var orgName = await probe.ScalarStringAsync(ctx.PostgresAdmin, ctx.PostgresAppDatabase, "SELECT org_name FROM organization_master WHERE org_id = 1");
            results.Add(new HealthCheckResult { Name = "Organization", Passed = !string.IsNullOrEmpty(orgName), Details = orgName ?? "not found" });

            var userCount = await probe.ScalarLongAsync(ctx.PostgresAdmin, ctx.PostgresAppDatabase, "SELECT COUNT(*) FROM user_master WHERE deleted_at IS NULL");
            results.Add(new HealthCheckResult { Name = "Super Admin", Passed = userCount > 0, Details = $"{userCount} user(s)" });
        }
        catch (Exception ex)
        {
            results.Add(new HealthCheckResult { Name = "Organization / Super Admin", Passed = false, Details = ex.Message });
        }

        return results;
    }

    /// <summary>Retries for a short window instead of judging readiness from a
    /// single instant request — Health Check runs immediately after the
    /// Windows Services/Firewall steps (or right after Repair/Upgrade restarts
    /// everything), and a Windows Service reporting "Running" only means the
    /// .NET service host process started, not that the Python/uvicorn backend
    /// it supervises has finished binding its port yet (the same race
    /// InstallEngine's Super Admin step already accounts for). Confirmed
    /// directly: Database Backend showed "connection actively refused" here
    /// while every other check passed, on a backend that was reachable and
    /// healthy moments later.</summary>
    private static async Task<HealthCheckResult> CheckHttpAsync(string name, string url)
    {
        var deadline = DateTime.UtcNow + TimeSpan.FromSeconds(20);
        Exception? lastError = null;
        while (DateTime.UtcNow < deadline)
        {
            try
            {
                using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
                using var resp = await http.GetAsync(url);
                return new HealthCheckResult { Name = name, Passed = resp.IsSuccessStatusCode, Details = $"HTTP {(int)resp.StatusCode}" };
            }
            catch (Exception ex)
            {
                lastError = ex;
                await Task.Delay(TimeSpan.FromSeconds(1));
            }
        }
        return new HealthCheckResult { Name = name, Passed = false, Details = lastError?.Message ?? "Not reachable." };
    }
}
