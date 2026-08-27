using System.Net.Http.Headers;
using System.Text;
using System.Text.RegularExpressions;
using ActMon.Setup.Core.Models;

namespace ActMon.Setup.Core.Services;

/// <summary>
/// Real ClickHouse connection testing, database enumeration and creation via its
/// HTTP interface (default :8123) — section 11. Credentials travel as a Basic
/// Auth header, never as URL query parameters, so they never land in a proxy or
/// access log verbatim (section 16).
/// </summary>
public sealed class ClickHouseConfigService
{
    private static readonly Regex ValidIdentifier = new(@"^[a-zA-Z_][a-zA-Z0-9_]{0,62}$", RegexOptions.Compiled);
    public static bool IsValidIdentifier(string name) => ValidIdentifier.IsMatch(name);

    private static HttpClient BuildClient(ClickHouseConnectionInfo info)
    {
        var http = new HttpClient { Timeout = TimeSpan.FromSeconds(8) };
        if (!string.IsNullOrEmpty(info.Username))
        {
            var raw = Encoding.UTF8.GetBytes($"{info.Username}:{info.Password}");
            http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Basic", Convert.ToBase64String(raw));
        }
        return http;
    }

    private static string BaseUrl(ClickHouseConnectionInfo info) => $"http://{info.Host}:{info.Port}/";

    public async Task<(bool success, string message)> TestConnectionAsync(ClickHouseConnectionInfo info)
    {
        try
        {
            using var http = BuildClient(info);
            var url = BaseUrl(info) + "?query=" + Uri.EscapeDataString("SELECT version()");
            var response = await http.GetAsync(url);
            var body = (await response.Content.ReadAsStringAsync()).Trim();

            if (!response.IsSuccessStatusCode)
                return (false, $"HTTP {(int)response.StatusCode}: {body}");

            return (true, $"Connected — ClickHouse {body}");
        }
        catch (Exception ex)
        {
            return (false, ex.Message);
        }
    }

    public async Task<List<string>> ListDatabasesAsync(ClickHouseConnectionInfo info)
    {
        using var http = BuildClient(info);
        var url = BaseUrl(info) + "?query=" + Uri.EscapeDataString("SHOW DATABASES");
        var response = await http.GetAsync(url);
        response.EnsureSuccessStatusCode();
        var body = await response.Content.ReadAsStringAsync();
        return body.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToList();
    }

    public async Task<bool> DatabaseExistsAsync(ClickHouseConnectionInfo info, string databaseName)
    {
        var existing = await ListDatabasesAsync(info);
        return existing.Contains(databaseName, StringComparer.Ordinal);
    }

    public async Task CreateDatabaseAsync(ClickHouseConnectionInfo info, string databaseName)
    {
        if (!IsValidIdentifier(databaseName)) throw new ArgumentException("Invalid database name.", nameof(databaseName));

        using var http = BuildClient(info);
        var url = BaseUrl(info) + "?query=" + Uri.EscapeDataString($"CREATE DATABASE \"{databaseName}\"");
        var response = await http.PostAsync(url, content: null);
        if (!response.IsSuccessStatusCode)
        {
            var body = await response.Content.ReadAsStringAsync();
            throw new InvalidOperationException($"ClickHouse returned HTTP {(int)response.StatusCode}: {body}");
        }
    }

    /// <summary>Only ever called from Uninstall's separate, explicitly-confirmed
    /// "remove data" step — never as part of removing the application itself.</summary>
    public async Task DropDatabaseAsync(ClickHouseConnectionInfo info, string databaseName)
    {
        if (!IsValidIdentifier(databaseName)) throw new ArgumentException("Invalid database name.", nameof(databaseName));

        using var http = BuildClient(info);
        var url = BaseUrl(info) + "?query=" + Uri.EscapeDataString($"DROP DATABASE IF EXISTS \"{databaseName}\"");
        var response = await http.PostAsync(url, content: null);
        if (!response.IsSuccessStatusCode)
        {
            var body = await response.Content.ReadAsStringAsync();
            throw new InvalidOperationException($"ClickHouse returned HTTP {(int)response.StatusCode}: {body}");
        }
    }
}
