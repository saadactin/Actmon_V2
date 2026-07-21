import React from 'react';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts';

export const MetricLineChart = ({
  data,
  metrics,
  xAxisKey = 'timestamp',
  height = 300,
}) => {
  // Check if we need a right y-axis
  const hasRightAxis = metrics.some((m) => m.yAxisId === 'right');

  return (
    <div style={{ width: '100%', height }}>
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#F3F2F1" />
          <XAxis
            dataKey={xAxisKey}
            stroke="#605E5C"
            fontSize={11}
            tickLine={false}
            dy={8}
          />
          <YAxis
            yAxisId="left"
            stroke="#605E5C"
            fontSize={11}
            tickLine={false}
            domain={[0, 100]}
            dx={-8}
          />
          {hasRightAxis && (
            <YAxis
              yAxisId="right"
              orientation="right"
              stroke="#605E5C"
              fontSize={11}
              tickLine={false}
              dx={8}
            />
          )}
          <Tooltip
            contentStyle={{
              backgroundColor: '#FFFFFF',
              border: '1px solid #EDEBE9',
              borderRadius: '6px',
              fontSize: '12px',
              boxShadow: 'var(--shadow-card)',
            }}
          />
          <Legend
            verticalAlign="top"
            height={36}
            iconType="circle"
            iconSize={8}
            wrapperStyle={{ fontSize: '12px' }}
          />
          {metrics.map((metric) => (
            <Line
              key={metric.key}
              type="monotone"
              dataKey={metric.key}
              name={metric.name}
              stroke={metric.color}
              yAxisId={metric.yAxisId || 'left'}
              activeDot={{ r: 6 }}
              strokeWidth={2}
              dot={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
};
