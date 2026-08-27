using System.Net.Http;
using System.Net.Http.Json;
using ActMon.Setup.Core.Models;

namespace ActMon.Setup.Core.Services;

/// <summary>Seeds the app's own smtp_configs row via its real
/// /api/v1/settings/smtp endpoint (unauthenticated, same as the setup/admin
/// endpoint) — reuses the app's own validation/encryption instead of writing
/// to the database directly. Entirely optional: called only when the
/// administrator actually filled in an SMTP host in the wizard.</summary>
public sealed class SmtpConfigClient
{
    public async Task<(bool success, string message)> CreateAsync(int databaseBackendPort, InstallerContext ctx)
    {
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(15) };
        var payload = new
        {
            name = "Default SMTP",
            smtp_host = ctx.SmtpHost,
            smtp_port = ctx.SmtpPort,
            smtp_user = string.IsNullOrWhiteSpace(ctx.SmtpUsername) ? null : ctx.SmtpUsername,
            smtp_password = string.IsNullOrWhiteSpace(ctx.SmtpPassword) ? null : ctx.SmtpPassword,
            smtp_tls = ctx.SmtpUseTls,
            sender_email = ctx.SmtpSenderEmail,
            sender_name = ctx.SmtpSenderName,
            is_default = true,
        };

        try
        {
            using var resp = await http.PostAsJsonAsync($"http://127.0.0.1:{databaseBackendPort}/api/v1/settings/smtp", payload);
            var body = await resp.Content.ReadAsStringAsync();
            return (resp.IsSuccessStatusCode, resp.IsSuccessStatusCode ? "SMTP configured." : body);
        }
        catch (Exception ex)
        {
            return (false, ex.Message);
        }
    }
}
