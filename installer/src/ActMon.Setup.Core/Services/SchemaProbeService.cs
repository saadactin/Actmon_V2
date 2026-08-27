using ActMon.Setup.Core.Models;
using Npgsql;

namespace ActMon.Setup.Core.Services;

/// <summary>
/// Organization Setup and Super Admin Setup both need to behave differently
/// depending on whether the target database already has ActMon's schema applied
/// (an existing-database reuse) or is a brand-new, empty database (schema arrives
/// later, during Install) — this answers exactly that question against the real
/// target database, never assuming either way.
/// </summary>
public sealed class SchemaProbeService
{
    public async Task<bool> TableExistsAsync(PostgresConnectionInfo admin, string database, string tableName)
    {
        var csb = new NpgsqlConnectionStringBuilder
        {
            Host = admin.Host,
            Port = admin.Port,
            Username = admin.Username,
            Password = admin.Password,
            Database = database,
            Timeout = 8,
        };
        await using var conn = new NpgsqlConnection(csb.ConnectionString);
        await conn.OpenAsync();
        await using var cmd = new NpgsqlCommand(
            "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = @name", conn);
        cmd.Parameters.AddWithValue("name", tableName);
        return await cmd.ExecuteScalarAsync() is not null;
    }

    public async Task<string?> ScalarStringAsync(PostgresConnectionInfo admin, string database, string sql)
    {
        var csb = new NpgsqlConnectionStringBuilder
        {
            Host = admin.Host, Port = admin.Port, Username = admin.Username, Password = admin.Password,
            Database = database, Timeout = 8,
        };
        await using var conn = new NpgsqlConnection(csb.ConnectionString);
        await conn.OpenAsync();
        await using var cmd = new NpgsqlCommand(sql, conn);
        return (string?)await cmd.ExecuteScalarAsync();
    }

    public async Task<long> ScalarLongAsync(PostgresConnectionInfo admin, string database, string sql)
    {
        var csb = new NpgsqlConnectionStringBuilder
        {
            Host = admin.Host, Port = admin.Port, Username = admin.Username, Password = admin.Password,
            Database = database, Timeout = 8,
        };
        await using var conn = new NpgsqlConnection(csb.ConnectionString);
        await conn.OpenAsync();
        await using var cmd = new NpgsqlCommand(sql, conn);
        var result = await cmd.ExecuteScalarAsync();
        return result is null or DBNull ? 0 : Convert.ToInt64(result);
    }

    public async Task<long> CountUsersWithUsernameAsync(PostgresConnectionInfo admin, string database, string username)
    {
        var csb = new NpgsqlConnectionStringBuilder
        {
            Host = admin.Host, Port = admin.Port, Username = admin.Username, Password = admin.Password,
            Database = database, Timeout = 8,
        };
        await using var conn = new NpgsqlConnection(csb.ConnectionString);
        await conn.OpenAsync();
        await using var cmd = new NpgsqlCommand(
            "SELECT COUNT(*) FROM user_master WHERE lower(user_name) = lower(@u) AND deleted_at IS NULL", conn);
        cmd.Parameters.AddWithValue("u", username);
        var result = await cmd.ExecuteScalarAsync();
        return result is null or DBNull ? 0 : Convert.ToInt64(result);
    }
}
