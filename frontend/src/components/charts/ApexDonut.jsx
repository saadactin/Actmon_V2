import { useMemo } from 'react';
import Chart from 'react-apexcharts';
import { useIsDark, useThemeStore } from '@/theme/themeStore';

function cssVar(name) {
  if (typeof window === 'undefined') return '#888';
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
}

/**
 * ApexCharts rounded donut with a big center total — same visual language as
 * the design mockup's "Computers by OS" card. Every OTHER donut on the
 * dashboard uses the app's own lightweight PieChart component; this one
 * exists because ApexCharts' donut rendering (rounded slice caps, spacing,
 * built-in center-total formatter) is what the mockup specifically calls
 * for, and duplicating that by hand in the home-grown chart wasn't worth it
 * for a single card.
 *
 * Colors are read from the SAME `--chart-N` custom properties (cycled the
 * identical `i % 8` way) that every other chart on the page uses, so this
 * card's palette stays in step with the rest of the app's active theme and
 * chart-palette preference instead of hardcoding its own hex values.
 */
export default function ApexDonut({ items = [], centerLabel = 'Total', height = 300 }) {
  const isDark = useIsDark();
  const chartPalette = useThemeStore((s) => s.chartPalette);

  const labels = items.map((i) => i.label);
  const series = items.map((i) => i.value);
  const total = series.reduce((a, b) => a + b, 0);

  const colors = useMemo(
    () => items.map((it, i) => it.color || cssVar(`--chart-${(i % 8) + 1}`)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, isDark, chartPalette],
  );
  const fg = useMemo(() => cssVar('--fg'), [isDark]);
  const muted = useMemo(() => cssVar('--fg-muted'), [isDark]);
  const track = useMemo(() => cssVar('--border'), [isDark]);

  if (!total) {
    return (
      <div className="grid place-items-center py-10 text-[12px] text-subtle" style={{ height }}>
        No data yet
      </div>
    );
  }

  const options = {
    chart: {
      type: 'donut',
      fontFamily: 'inherit',
      animations: { enabled: true, speed: 500 },
      background: 'transparent',
    },
    labels,
    colors,
    stroke: { width: 2, colors: [track] },
    plotOptions: {
      pie: {
        borderRadius: 8,
        donut: {
          size: '68%',
          labels: {
            show: true,
            name: { show: false },
            value: { fontSize: '28px', fontWeight: 700, color: fg, offsetY: 6 },
            total: {
              show: true, showAlways: true, label: centerLabel,
              fontSize: '13px', fontWeight: 500, color: muted,
              formatter: () => String(total),
            },
          },
        },
      },
    },
    dataLabels: { enabled: false },
    legend: {
      show: true, position: 'bottom', fontSize: '12px', fontFamily: 'inherit',
      labels: { colors: muted }, markers: { size: 6 }, itemMargin: { horizontal: 8, vertical: 4 },
    },
    tooltip: { y: { formatter: (val) => `${val} hosts` } },
  };

  return <Chart type="donut" options={options} series={series} height={height} />;
}
