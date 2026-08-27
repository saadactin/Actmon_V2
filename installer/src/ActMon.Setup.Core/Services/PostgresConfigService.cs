using System.Text.RegularExpressions;
using ActMon.Setup.Core.Models;
using Npgsql;

namespace ActMon.Setup.Core.Services;

/// <summary>
/// Real PostgreSQL connection testing, database enumeration and (only when the
/// administrator explicitly asks for a new one) database+user creation — sections
/// 8 and 9 of the spec. Never touches an existing database's data; CREATE DATABASE
/// only ever runs after DatabaseExistsAsync has confirmed it's safe to.
/// </summary>
public sealed class PostgresConfigService
{
    private static readonly Regex ValidIdentifier = new(@"^[a-zA-Z_][a-zA-Z0-9_]{0,62}$", RegexOptions.Compiled);

    public static bool IsValidIdentifier(string name) => ValidIdentifier.IsMatch(name);

    private static string BuildConnString(PostgresConnectionInfo info, string database = "postgres") =>
        new NpgsqlConnectionStringBuilder
        {
            Host = info.Host,
            Port = info.Port,
            Username = info.Username,
            Password = info.Password,
            Database = database,
            Timeout = 8,
            CommandTimeout = 8,
        }.ConnectionString;

    public async Task<(bool success, string message)> TestConnectionAsync(PostgresConnectionInfo info)
    {
        try
        {
            await using var conn = new NpgsqlConnection(BuildConnString(info));
            await conn.OpenAsync();
            await using var cmd = new NpgsqlCommand("SELECT version()", conn);
            var version = (string?)await cmd.ExecuteScalarAsync();
            return (true, $"Connected — {version?.Split(',')[0]}");
        }
        catch (PostgresException ex)
        {
            return (false, $"{ex.SqlState}: {ex.MessageText}");
        }
        catch (Exception ex)
        {
            return (false, ex.Message);
        }
    }

    public async Task<List<DatabaseInfo>> ListDatabasesAsync(PostgresConnectionInfo info)
    {
        var result = new List<DatabaseInfo>();
        await using var conn = new NpgsqlConnection(BuildConnString(info));
        await conn.OpenAsync();
        await using var cmd = new NpgsqlCommand(
            "SELECT d.datname, pg_catalog.pg_get_userbyid(d.datdba) AS owner " +
            "FROM pg_catalog.pg_database d WHERE d.datistemplate = false ORDER BY d.datname", conn);
        await using var reader = await cmd.ExecuteReaderAsync();
        while (await reader.ReadAsync())
            result.Add(new DatabaseInfo { Name = reader.GetString(0), Owner = reader.GetString(1) });
        return result;
    }

    public async Task<bool> DatabaseExistsAsync(PostgresConnectionInfo info, string databaseName)
    {
        await using var conn = new NpgsqlConnection(BuildConnString(info));
        await conn.OpenAsync();
        await using var cmd = new NpgsqlCommand("SELECT 1 FROM pg_catalog.pg_database WHERE datname = @name", conn);
        cmd.Parameters.AddWithValue("name", databaseName);
        var result = await cmd.ExecuteScalarAsync();
        return result is not null;
    }

    /// <summary>
    /// Creates the login role (if it doesn't already exist — never resets an
    /// existing role's password) and the database owned by it, then grants only
    /// the privileges ActMon needs. Caller must have already confirmed via
    /// DatabaseExistsAsync that databaseName is free.
    /// </summary>
    public async Task CreateDatabaseAndRoleAsync(PostgresConnectionInfo admin, string databaseName, string appUsername, string appPassword)
    {
        if (!IsValidIdentifier(databaseName)) throw new ArgumentException("Invalid database name.", nameof(databaseName));
        if (!IsValidIdentifier(appUsername)) throw new ArgumentException("Invalid username.", nameof(appUsername));

        await using var conn = new NpgsqlConnection(BuildConnString(admin));
        await conn.OpenAsync();

        var roleExists = await ScalarBoolAsync(conn, "SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = @name", appUsername);
        if (!roleExists)
        {
            var escapedPassword = appPassword.Replace("'", "''");
            await using var createRole = new NpgsqlCommand(
                $"CREATE ROLE \"{appUsername}\" LOGIN PASSWORD '{escapedPassword}'", conn);
            await createRole.ExecuteNonQueryAsync();
        }

        await using var createDb = new NpgsqlCommand(
            $"CREATE DATABASE \"{databaseName}\" OWNER \"{appUsername}\"", conn);
        await createDb.ExecuteNonQueryAsync();

        await using var grant = new NpgsqlCommand(
            $"GRANT ALL PRIVILEGES ON DATABASE \"{databaseName}\" TO \"{appUsername}\"", conn);
        await grant.ExecuteNonQueryAsync();
    }

    /// <summary>Only ever called from Uninstall's separate, explicitly-confirmed
    /// "remove data" step — never as part of removing the application itself.</summary>
    public async Task DropDatabaseAsync(PostgresConnectionInfo admin, string databaseName)
    {
        if (!IsValidIdentifier(databaseName)) throw new ArgumentException("Invalid database name.", nameof(databaseName));

        await using var conn = new NpgsqlConnection(BuildConnString(admin));
        await conn.OpenAsync();

        await using var terminate = new NpgsqlCommand(
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = @name", conn);
        terminate.Parameters.AddWithValue("name", databaseName);
        await terminate.ExecuteNonQueryAsync();

        await using var drop = new NpgsqlCommand($"DROP DATABASE IF EXISTS \"{databaseName}\"", conn);
        await drop.ExecuteNonQueryAsync();
    }

    private static async Task<bool> ScalarBoolAsync(NpgsqlConnection conn, string sql, string param)
    {
        await using var cmd = new NpgsqlCommand(sql, conn);
        cmd.Parameters.AddWithValue("name", param);
        return await cmd.ExecuteScalarAsync() is not null;
    }
}
