using System.Runtime.InteropServices;

namespace ActMon.ServiceHost;

/// <summary>
/// Wraps a Win32 Job Object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE. Assigning the
/// supervised backend process to this job means Windows itself kills that process
/// the instant this service's handle to the job closes — including on a crash or
/// a hard kill of this process (Stop-Process, Task Manager "End Task", a stuck SCM
/// stop timing out) — with zero cooperation required from this process's own
/// shutdown code. Without this, an abrupt kill of the supervisor orphans the
/// backend as an invisible, un-managed process.
/// </summary>
public sealed class JobObject : IDisposable
{
    private readonly IntPtr _handle;

    public JobObject()
    {
        _handle = CreateJobObject(IntPtr.Zero, null);

        var info = new JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        var extendedInfo = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION { BasicLimitInformation = info };

        var length = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        var ptr = Marshal.AllocHGlobal(length);
        try
        {
            Marshal.StructureToPtr(extendedInfo, ptr, false);
            if (!SetInformationJobObject(_handle, JobObjectInfoType.ExtendedLimitInformation, ptr, (uint)length))
                throw new InvalidOperationException($"SetInformationJobObject failed: {Marshal.GetLastWin32Error()}");
        }
        finally
        {
            Marshal.FreeHGlobal(ptr);
        }
    }

    public void Assign(IntPtr processHandle)
    {
        if (!AssignProcessToJobObject(_handle, processHandle))
            throw new InvalidOperationException($"AssignProcessToJobObject failed: {Marshal.GetLastWin32Error()}");
    }

    public void Dispose()
    {
        if (_handle != IntPtr.Zero) CloseHandle(_handle);
    }

    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

    private enum JobObjectInfoType
    {
        ExtendedLimitInformation = 9,
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string? lpName);

    [DllImport("kernel32.dll")]
    private static extern bool SetInformationJobObject(IntPtr hJob, JobObjectInfoType infoType, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength);

    [DllImport("kernel32.dll")]
    private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr hObject);
}
