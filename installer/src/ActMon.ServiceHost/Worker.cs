using System.Diagnostics;
using ActMon.Setup.Core.Models;

namespace ActMon.ServiceHost;

/// <summary>
/// Supervises one frozen ActMon backend exe as a child process for the lifetime
/// of this Windows Service. Restarts it on an unexpected exit (with backoff, so a
/// crash-looping backend doesn't spin this service at 100% CPU); on service stop,
/// kills the whole child process tree and returns.
/// </summary>
public sealed class Worker : BackgroundService
{
    private readonly ILogger<Worker> _logger;
    private readonly ServiceHostConfig _config;
    private readonly JobObject _job = new();
    private Process? _child;

    public Worker(ILogger<Worker> logger, ServiceHostConfig config)
    {
        _logger = logger;
        _config = config;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var backoff = TimeSpan.FromSeconds(2);
        var maxBackoff = TimeSpan.FromSeconds(30);

        while (!stoppingToken.IsCancellationRequested)
        {
            var startedAt = DateTime.UtcNow;
            try
            {
                await RunOnceAsync(stoppingToken);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Backend process supervision failed unexpectedly.");
            }

            if (stoppingToken.IsCancellationRequested) break;

            // A backend that ran for a while before dying gets to try again soon;
            // one that dies immediately backs off further each time.
            if (DateTime.UtcNow - startedAt > TimeSpan.FromMinutes(2))
                backoff = TimeSpan.FromSeconds(2);
            else
                backoff = TimeSpan.FromSeconds(Math.Min(backoff.TotalSeconds * 2, maxBackoff.TotalSeconds));

            _logger.LogWarning("Backend exited — restarting in {Backoff}s.", backoff.TotalSeconds);
            try { await Task.Delay(backoff, stoppingToken); } catch (OperationCanceledException) { break; }
        }
    }

    private async Task RunOnceAsync(CancellationToken stoppingToken)
    {
        var psi = new ProcessStartInfo
        {
            FileName = _config.ExecutablePath,
            WorkingDirectory = _config.WorkingDirectory,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        foreach (var (key, value) in _config.EnvironmentVariables)
            psi.Environment[key] = value;

        _child = new Process { StartInfo = psi, EnableRaisingEvents = true };

        var logPath = Path.Combine(_config.LogDirectory, Path.GetFileNameWithoutExtension(_config.ExecutablePath) + ".log");
        Directory.CreateDirectory(Path.GetDirectoryName(logPath)!);
        await using var log = new StreamWriter(new FileStream(logPath, FileMode.Append, FileAccess.Write, FileShare.Read)) { AutoFlush = true };

        _child.OutputDataReceived += (_, e) => { if (e.Data is not null) log.WriteLine($"[{DateTime.Now:HH:mm:ss}] {e.Data}"); };
        _child.ErrorDataReceived += (_, e) => { if (e.Data is not null) log.WriteLine($"[{DateTime.Now:HH:mm:ss}] ERR {e.Data}"); };

        _logger.LogInformation("Starting backend: {Exe}", _config.ExecutablePath);
        _child.Start();
        _job.Assign(_child.Handle); // OS-guaranteed: this child dies if this service does, cooperative or not.
        _child.BeginOutputReadLine();
        _child.BeginErrorReadLine();

        using var reg = stoppingToken.Register(() =>
        {
            try
            {
                if (_child is { HasExited: false }) _child.Kill(entireProcessTree: true);
            }
            catch { /* already exiting */ }
        });

        await _child.WaitForExitAsync(stoppingToken);
        _logger.LogInformation("Backend exited with code {Code}.", _child.ExitCode);
    }

    public override void Dispose()
    {
        _job.Dispose();
        base.Dispose();
    }
}
