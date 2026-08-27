using System.Net.Http;
using System.Net.Http.Json;
using ActMon.Setup.Core.Models;

namespace ActMon.Setup.Core.Services;

/// <summary>Calls the app's own first-run setup endpoint (Backend/database/app/routes/setup/setup_routes.py)
/// once the database backend service is up — reuses the real account-creation
/// logic instead of re-implementing it (and its password handling) here.</summary>
public sealed class SuperAdminClient
{
    public async Task<(bool success, string message)> CreateAsync(int databaseBackendPort, InstallerContext ctx)
    {
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(15) };
        var payload = new
        {
            employee_name = ctx.SuperAdminFullName,
            email = ctx.SuperAdminEmail,
            username = ctx.SuperAdminUsername,
            password = ctx.SuperAdminPassword,
        };

        try
        {
            using var resp = await http.PostAsJsonAsync($"http://127.0.0.1:{databaseBackendPort}/api/v1/setup/admin", payload);
            var body = await resp.Content.ReadAsStringAsync();
            return (resp.IsSuccessStatusCode, resp.IsSuccessStatusCode ? "Super Admin created." : body);
        }
        catch (Exception ex)
        {
            return (false, ex.Message);
        }
    }

    /// <summary>Polls until the database backend actually answers an HTTP
    /// request, rather than assuming a fixed delay after the Windows Service
    /// reports "Running" is enough — that status only means the .NET service
    /// host process itself started, not that the Python/uvicorn backend it
    /// supervises has finished importing modules, connecting to PostgreSQL and
    /// binding its port yet. Confirmed directly: a 2-second fixed delay was
    /// too short and produced "connection actively refused" on Create.</summary>
    public async Task<bool> WaitUntilReadyAsync(int databaseBackendPort, TimeSpan timeout)
    {
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(3) };
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            try
            {
                using var resp = await http.GetAsync($"http://127.0.0.1:{databaseBackendPort}/api/v1/setup/status");
                return true; // any HTTP response at all proves the backend is listening
            }
            catch
            {
                await Task.Delay(TimeSpan.FromSeconds(1));
            }
        }
        return false;
    }

    public async Task<bool> NeedsSetupAsync(int databaseBackendPort)
    {
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
        try
        {
            var status = await http.GetFromJsonAsync<SetupStatus>($"http://127.0.0.1:{databaseBackendPort}/api/v1/setup/status");
            return status?.needs_setup ?? true;
        }
        catch
        {
            return true;
        }
    }

    private sealed class SetupStatus
    {
        public bool needs_setup { get; set; }
    }
}
