namespace ActMon.Setup.Core.Models;

public sealed class PostgresConnectionInfo
{
    public string Host { get; set; } = "localhost";
    public int Port { get; set; } = 5432;
    public string Username { get; set; } = "postgres";
    public string Password { get; set; } = "";
}

public sealed class DatabaseInfo
{
    public required string Name { get; init; }
    public required string Owner { get; init; }
}
