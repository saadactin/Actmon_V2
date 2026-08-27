using ActMon.Setup.Core;

namespace ActMon.Setup.Core.Models;

/// <summary>
/// Shared mutable state carried across wizard pages — one instance for the whole
/// run. Grows as each stage of the section-3 flow is implemented; fields here
/// mirror exactly what the installer spec's later sections (8-14) ask each page
/// to collect, so pages don't duplicate storage for the same value. Lives in
/// Core (not the WPF project) because the Install engine's own orchestration
/// code — env writers, health checks — reads it just as directly as the wizard
/// pages that filled it in.
/// </summary>
public sealed class InstallerContext
{
    public string InstallDirectory { get; set; } = AppInfo.DefaultInstallDirectory;

    // Section 7 — Port Configuration
    public int FrontendPort { get; set; } = 9182;
    public int DatabaseBackendPort { get; set; } = 8003;
    public int CloudBackendPort { get; set; } = 8004;

    // Network access for the frontend/nginx: whether it's reachable from other
    // machines at all (binds 127.0.0.1 instead of 0.0.0.0 when false), and, when
    // it is, which host/IP to actually show people (localhost only resolves on
    // this machine — a remote user needs this machine's real LAN/public address
    // or hostname instead).
    public bool AllowRemoteAccess { get; set; } = true;
    public string PublicHostOrIp { get; set; } = "";

    // Sections 8-9 — PostgreSQL: the admin creds used to test/list/create, and the
    // final app-level credentials ActMon's own .env files will be written with
    // (equal to the admin creds when "use existing" reuses the same login; a
    // freshly created role+password when "create new" was chosen).
    public PostgresConnectionInfo PostgresAdmin { get; } = new();
    public string PostgresAppDatabase { get; set; } = "";
    public string PostgresAppUsername { get; set; } = "";
    public string PostgresAppPassword { get; set; } = "";

    // Section 10 — Redis (via WSL2 + Ubuntu)
    public RedisConnectionInfo Redis { get; } = new();

    // Section 11 — ClickHouse
    public ClickHouseConnectionInfo ClickHouseAdmin { get; } = new();
    public string ClickHouseAppDatabase { get; set; } = "";

    // Section 12 — Organization. OrganizationName seeds org #1 (via ORG_NAME) when
    // the target database's schema hasn't been applied yet; UsingExistingOrg records
    // that org #1 already existed and its name was only confirmed, not written.
    public string OrganizationName { get; set; } = "";
    public bool UsingExistingOrg { get; set; }

    // Section 13 — Super Admin. Actual account creation happens during Install
    // (via the backend's own /api/v1/setup/admin, once it's running) — this page
    // only validates and stores what to send it.
    public string SuperAdminFullName { get; set; } = "";
    public string SuperAdminEmail { get; set; } = "";
    public string SuperAdminUsername { get; set; } = "";
    public string SuperAdminPassword { get; set; } = "";

    // SMTP — entirely optional. Sign-in itself never requires it (the backend
    // degrades to password-only login when no SMTP is configured), so this is
    // purely about enabling the one-time-code email step; left blank (Host
    // empty) it's simply skipped and can be configured later from within
    // ActMon's own Settings.
    public string SmtpHost { get; set; } = "";
    public int SmtpPort { get; set; } = 587;
    public string SmtpUsername { get; set; } = "";
    public string SmtpPassword { get; set; } = "";
    public bool SmtpUseTls { get; set; } = true;
    public string SmtpSenderEmail { get; set; } = "";
    public string SmtpSenderName { get; set; } = "ActMon Monitor";
}
