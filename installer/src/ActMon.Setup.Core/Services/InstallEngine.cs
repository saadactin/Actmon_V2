using ActMon.Setup.Core.Models;

namespace ActMon.Setup.Core.Services;

/// <summary>
/// Section 17's Install step, in order. Every sub-step here does real work
/// (copies real files, writes real config, runs the real db-setup exe, creates
/// real Windows Services, adds real firewall rules) — nothing is simulated for
/// the progress display. On failure, stops immediately and returns exactly what
/// section 17 asks for: which component, what actually went wrong, and what to
/// do about it — never leaving a half-registered service or a half-written
/// config file for the next step to trip over silently.
/// </summary>
public sealed class InstallEngine
{
    public const string DatabaseServiceName = "ActMonDatabaseService";
    public const string CloudServiceName = "ActMonCloudService";
    public const string FrontendServiceName = "ActMonFrontendService";
    public const string ProductVersion = AppInfo.Version;

    private readonly WindowsServiceManager _services = new();
    private readonly FirewallManager _firewall = new();
    private readonly DbSetupRunner _dbSetup = new();
    private readonly SuperAdminClient _superAdmin = new();
    private readonly SmtpConfigClient _smtp = new();
    private readonly ShortcutManager _shortcuts = new();
    private readonly AddRemoveProgramsManager _addRemovePrograms = new();

    public string DatabaseDir { get; private set; } = "";
    public string CloudDir { get; private set; } = "";
    public string FrontendDir { get; private set; } = "";
    public string NginxDir { get; private set; } = "";
    public string ServiceHostExe { get; private set; } = "";

    public async Task<InstallStepResult> RunAsync(InstallerContext ctx, InstallPayload payload, Action<string> onProgress, CancellationToken ct = default)
    {
        DatabaseDir = Path.Combine(ctx.InstallDirectory, "database");
        CloudDir = Path.Combine(ctx.InstallDirectory, "cloud");
        FrontendDir = Path.Combine(ctx.InstallDirectory, "frontend", "dist");
        NginxDir = Path.Combine(ctx.InstallDirectory, "nginx");
        var serviceHostDir = Path.Combine(ctx.InstallDirectory, "servicehost");
        var dbSetupDir = Path.Combine(DatabaseDir, "db-setup");
        var logsDir = Path.Combine(ctx.InstallDirectory, "logs");
        ServiceHostExe = Path.Combine(serviceHostDir, "ActMon.ServiceHost.exe");

        try
        {
            // Stopping (and removing) any already-registered ActMon services
            // has to happen before files get deployed, not just later when
            // they're re-registered: a running service keeps its own .exe
            // locked, and re-running Install — Retry after a failure, or a
            // genuine Repair/Upgrade/Modify — otherwise fails deploying over
            // it with "the process cannot access the file ... used by another
            // process", confirmed directly against a database service left
            // running from a prior successful attempt.
            onProgress("Stopping existing services (if any)...");
            foreach (var name in new[] { DatabaseServiceName, CloudServiceName, FrontendServiceName })
            {
                if (_services.Exists(name))
                    await _services.DeleteAsync(name);
            }

            onProgress("Creating install directories...");
            foreach (var d in new[] { DatabaseDir, CloudDir, FrontendDir, NginxDir, serviceHostDir, dbSetupDir, logsDir })
                Directory.CreateDirectory(d);

            onProgress("Deploying application files...");
            FileSystemHelper.CopyDirectory(payload.DatabaseServerDir, DatabaseDir);
            FileSystemHelper.CopyDirectory(payload.CloudServerDir, CloudDir);
            FileSystemHelper.CopyDirectory(payload.NginxDir, NginxDir);
            FileSystemHelper.CopyDirectory(payload.FrontendDistDir, FrontendDir);
            // The database backend's own "download agent" feature serves
            // pre-built actmon-agent.exe/.msi/.deb/.rpm from "<its own
            // directory>/agent/dist" — these aren't produced by any build this
            // installer runs itself, so without this they're simply absent
            // and every agent download 404s ("has not been built on this
            // server"), confirmed directly.
            if (Directory.Exists(payload.AgentDistDir))
                FileSystemHelper.CopyDirectory(payload.AgentDistDir, Path.Combine(DatabaseDir, "agent", "dist"));
            // actmon-db-setup.exe is a PyInstaller onedir build — it needs its
            // whole sibling "_internal" folder (schema.sql, config seed SQL,
            // the embedded Python runtime) sitting next to it at runtime, not
            // just the .exe itself. Copying the exe alone (as this used to)
            // left it unable to find schema.sql at all. It also can't just
            // land directly in DatabaseDir: that already has its own
            // unrelated "_internal" folder from actmon-database-server.exe,
            // so db-setup gets its own subfolder instead of merging the two.
            var dbSetupSourceDir = Path.GetDirectoryName(payload.DbSetupExePath)
                ?? throw new InvalidOperationException($"Could not determine the directory containing {payload.DbSetupExePath}.");
            FileSystemHelper.CopyDirectory(dbSetupSourceDir, dbSetupDir);
            // ActMon.ServiceHost.exe is a framework-dependent build too: the .exe
            // is just a native apphost stub that loads ActMon.ServiceHost.dll (plus
            // its .deps.json/.runtimeconfig.json and every referenced assembly —
            // Npgsql, StackExchange.Redis, the Generic Host packages, etc.) from
            // the same folder. Copying only the .exe (as this used to) left every
            // service dying instantly with ".NET Runtime" event 1023 ("The
            // application to execute does not exist: ...ActMon.ServiceHost.dll"),
            // which the Service Control Manager only ever reported as a generic
            // "did not respond in a timely fashion" — confirmed directly.
            var serviceHostSourceDir = Path.GetDirectoryName(payload.ServiceHostExePath)
                ?? throw new InvalidOperationException($"Could not determine the directory containing {payload.ServiceHostExePath}.");
            FileSystemHelper.CopyDirectory(serviceHostSourceDir, serviceHostDir);
            ct.ThrowIfCancellationRequested();

            onProgress("Creating secure configuration...");
            var dbEnvPath = Path.Combine(DatabaseDir, ".env");
            var cloudEnvPath = Path.Combine(CloudDir, ".env");
            // Re-running Install (Repair, or simply re-installing over an existing
            // deployment) must never rotate these — see ReadExistingValue's own note.
            var jwtSecret = EnvFileWriter.ReadExistingValue(dbEnvPath, "JWT_SECRET") ?? SecretGenerator.GenerateHex();
            var encKey = EnvFileWriter.ReadExistingValue(dbEnvPath, "ACTMON_ENCRYPTION_KEY") ?? SecretGenerator.GenerateBase64Key();
            EnvFileWriter.WriteDatabaseEnv(dbEnvPath, ctx, jwtSecret, encKey);
            EnvFileWriter.WriteCloudEnv(cloudEnvPath, ctx, jwtSecret, encKey);
            FileSystemHelper.RestrictToAdministrators(dbEnvPath);
            FileSystemHelper.RestrictToAdministrators(cloudEnvPath);

            onProgress("Configuring application...");
            var nginxConfPath = Path.Combine(NginxDir, "conf", "nginx.conf");
            NginxConfigWriter.Write(nginxConfPath, ctx, FrontendDir);
            ct.ThrowIfCancellationRequested();

            onProgress("Provisioning database schema...");
            var appAdmin = new PostgresConnectionInfo
            {
                Host = ctx.PostgresAdmin.Host, Port = ctx.PostgresAdmin.Port,
                Username = ctx.PostgresAppUsername, Password = ctx.PostgresAppPassword,
            };
            var dbSetupExePath = Path.Combine(dbSetupDir, Path.GetFileName(payload.DbSetupExePath));
            var setupResult = await _dbSetup.RunAsync(dbSetupExePath, appAdmin, ctx.PostgresAppDatabase, ctx.OrganizationName, ctx.SuperAdminEmail);
            if (!setupResult.Success)
            {
                return Failure("Database schema", "Schema provisioning failed.", "Review the provisioning log for the exact SQL error, then Retry.", setupResult.RawOutput);
            }
            ct.ThrowIfCancellationRequested();

            onProgress("Creating Windows Services...");
            var dbReg = await RegisterServiceAsync(DatabaseServiceName, "ActMon Database Backend",
                Path.Combine(DatabaseDir, "actmon-database-server.exe"), DatabaseDir, logsDir,
                new Dictionary<string, string> { ["ACTMON_BIND_HOST"] = "127.0.0.1", ["ACTMON_BIND_PORT"] = ctx.DatabaseBackendPort.ToString() },
                serviceHostDir, "db-service.config.json");
            if (dbReg is { Success: false }) return dbReg;

            var cloudReg = await RegisterServiceAsync(CloudServiceName, "ActMon Cloud Backend",
                Path.Combine(CloudDir, "actmon-cloud-server.exe"), CloudDir, logsDir,
                new Dictionary<string, string>
                {
                    ["ACTMON_BIND_HOST"] = "127.0.0.1",
                    ["ACTMON_BIND_PORT"] = ctx.CloudBackendPort.ToString(),
                    // Bypasses the cloud backend's own fragile relative-path .env
                    // lookup (verified during development to silently no-op under
                    // a frozen build's different folder depth) — authoritative here.
                    ["DATABASE_URL"] = $"postgresql://{ctx.PostgresAppUsername}:{Uri.EscapeDataString(ctx.PostgresAppPassword)}@{ctx.PostgresAdmin.Host}:{ctx.PostgresAdmin.Port}/{ctx.PostgresAppDatabase}",
                    ["DB_USER"] = ctx.PostgresAppUsername,
                    ["DB_PASS"] = ctx.PostgresAppPassword,
                    ["DB_HOST"] = ctx.PostgresAdmin.Host,
                    ["DB_PORT"] = ctx.PostgresAdmin.Port.ToString(),
                    ["DB_NAME"] = ctx.PostgresAppDatabase,
                    ["JWT_SECRET"] = jwtSecret,
                    ["ACTMON_ENCRYPTION_KEY"] = encKey,
                },
                serviceHostDir, "cloud-service.config.json");
            if (cloudReg is { Success: false }) return cloudReg;

            var frontendReg = await RegisterServiceAsync(FrontendServiceName, "ActMon Frontend (nginx)",
                Path.Combine(NginxDir, "nginx.exe"), NginxDir, logsDir,
                new Dictionary<string, string>(),
                serviceHostDir, "frontend-service.config.json");
            if (frontendReg is { Success: false }) return frontendReg;
            ct.ThrowIfCancellationRequested();

            onProgress("Configuring firewall...");
            foreach (var (port, desc) in new[] { (ctx.FrontendPort, "ActMon web UI"), (ctx.DatabaseBackendPort, "ActMon database backend"), (ctx.CloudBackendPort, "ActMon cloud backend") })
            {
                if (!await _firewall.RuleExistsAsync(port))
                    await _firewall.AddInboundRuleAsync(port, desc);
            }

            onProgress("Starting services...");
            foreach (var name in new[] { DatabaseServiceName, CloudServiceName, FrontendServiceName })
            {
                if (!await _services.StartAsync(name, TimeSpan.FromSeconds(30)))
                    return Failure(name, "Service did not reach the Running state within 30 seconds.", $"Check {logsDir} for the backend's own startup errors, then Retry.", null);
            }
            ct.ThrowIfCancellationRequested();

            if (!string.IsNullOrEmpty(ctx.SuperAdminUsername) || !string.IsNullOrWhiteSpace(ctx.SmtpHost))
            {
                // The Windows Service reaching "Running" only means the .NET
                // service host process started — not that the Python/uvicorn
                // backend it supervises has finished importing, connecting to
                // PostgreSQL and binding its port yet. Poll for real readiness
                // instead of guessing a fixed delay, once, before either of the
                // two calls below that actually need it reachable.
                onProgress("Waiting for the database backend to respond...");
                if (!await _superAdmin.WaitUntilReadyAsync(ctx.DatabaseBackendPort, TimeSpan.FromSeconds(45)))
                    return Failure("Super Admin", "The database backend did not start responding in time.", $"Check {logsDir} for the backend's own startup errors, then Retry.", null);

                if (!string.IsNullOrEmpty(ctx.SuperAdminUsername))
                {
                    onProgress("Creating Super Admin...");
                    var (adminOk, adminMsg) = await _superAdmin.CreateAsync(ctx.DatabaseBackendPort, ctx);
                    if (!adminOk)
                        return Failure("Super Admin", "Could not create the Super Admin account.", "Confirm the database backend is reachable, then Retry.", adminMsg);
                }

                if (!string.IsNullOrWhiteSpace(ctx.SmtpHost))
                {
                    // Non-fatal on purpose: sign-in never depends on SMTP (the
                    // backend degrades to password-only login without it), so a
                    // typo here shouldn't block the rest of Install — it can
                    // always be fixed from ActMon's own Settings afterward.
                    onProgress("Configuring SMTP...");
                    var (smtpOk, smtpMsg) = await _smtp.CreateAsync(ctx.DatabaseBackendPort, ctx);
                    onProgress(smtpOk ? "SMTP configured." : $"SMTP configuration failed — you can set it up later from ActMon's own Settings ({smtpMsg}).");
                }
            }

            onProgress("Creating shortcuts and Add/Remove Programs entry...");
            var installedExePath = Path.Combine(ctx.InstallDirectory, "ActMon.exe");
            var currentExePath = Environment.ProcessPath;
            if (!string.IsNullOrEmpty(currentExePath) && !string.Equals(currentExePath, installedExePath, StringComparison.OrdinalIgnoreCase))
                File.Copy(currentExePath, installedExePath, overwrite: true);

            _shortcuts.CreateStartMenuShortcut(installedExePath, ActMonUrlBuilder.Build(ctx));

            var estimatedSizeKb = 0;
            try
            {
                estimatedSizeKb = (int)(Directory.EnumerateFiles(ctx.InstallDirectory, "*", SearchOption.AllDirectories)
                    .Sum(f => new FileInfo(f).Length) / 1024);
            }
            catch { /* best effort — Add/Remove Programs shows an estimate, not billing */ }
            _addRemovePrograms.Register(ctx.InstallDirectory, installedExePath, ProductVersion, estimatedSizeKb);

            InstallManifest.FromContext(ctx, ProductVersion).Save();

            onProgress("Installation complete.");
            return new InstallStepResult { Success = true };
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex)
        {
            return Failure("Install", "An unexpected error occurred.", "Review the details below, then Retry.", ex.ToString());
        }
    }

    private async Task<InstallStepResult?> RegisterServiceAsync(
        string serviceName, string displayName, string exePath, string workingDir, string logDirectory,
        Dictionary<string, string> env, string serviceHostDir, string configFileName)
    {
        var configPath = Path.Combine(serviceHostDir, configFileName);
        new ServiceHostConfig { ExecutablePath = exePath, WorkingDirectory = workingDir, LogDirectory = logDirectory, EnvironmentVariables = env }.Save(configPath);
        FileSystemHelper.RestrictToAdministrators(configPath);

        if (_services.Exists(serviceName))
            await _services.DeleteAsync(serviceName);

        var (created, output) = await _services.CreateAsync(new ServiceRegistration(
            serviceName, displayName, ServiceHostExe, new[] { "--config", configPath }));

        if (!created)
            return Failure(displayName, "Could not create the Windows Service.", "Confirm this installer is running elevated, then Retry.", output);

        await _services.SetDescriptionAsync(serviceName, $"{displayName} — managed by ActMon Setup.");
        await _services.SetFailureActionsAsync(serviceName);
        return null;
    }

    private static InstallStepResult Failure(string component, string problem, string action, string? details) => new()
    {
        Success = false,
        ErrorComponent = component,
        ErrorProblem = problem,
        ErrorRecommendedAction = action,
        ErrorDetails = details,
    };
}
