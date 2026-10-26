"""One shell command for "how busy is this Linux host's CPU right now", used by every SSH collector.

Two /proc/stat readings 1 s apart: busy = everything except idle and iowait, across all cores, so a 4-core host
tops out at 100%. `top -bn1 | ... $2+$4` was used before; a single top iteration is not a measured interval and
us+sy leaves out nice/irq/softirq/steal, so it disagreed with what `top` itself shows on screen.
Prints one number (e.g. 37.4), or nothing if /proc/stat is unreadable.
"""

LINUX_CPU_BUSY_PCT = (
    "a=$(awk '/^cpu /{print $2+$3+$4+$5+$6+$7+$8+$9, $5+$6}' /proc/stat); sleep 1; "
    "b=$(awk '/^cpu /{print $2+$3+$4+$5+$6+$7+$8+$9, $5+$6}' /proc/stat); "
    "echo $a $b | awk '{t=$3-$1; i=$4-$2; if (t>0) printf \"%.1f\\n\", (t-i)*100/t}'"
)
