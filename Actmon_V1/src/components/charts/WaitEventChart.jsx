import React from 'react';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Cell,
} from 'recharts';

const COLORS = [
  '#0078D4', // Primary Blue
  '#107C10', // Success Green
  '#D83B01', // Warning Orange
  '#A4262C', // Error Red
  '#8764B8', // Purple
  '#00B7C3', // Teal
  '#F5222D', // Light Red
  '#FA8C16', // Orange
  '#52C41A', // Light Green
  '#13C2C2', // Cyan
];

export const WaitEventChart = ({ data, height = 300 }) => {
  // Sort descending
  const sortedData = [...data].sort((a, b) => b.time_ms - a.time_ms).slice(0, 10);

  return (
    <div style={{ width: '100%', height }}>
      <ResponsiveContainer>
        <BarChart
          data={sortedData}
          layout="vertical"
          margin={{ top: 10, right: 30, left: 10, bottom: 5 }}
        >
          <CartesianGrid strokeDasharray="3 3" horizontal={true} vertical={false} stroke="#F3F2F1" />
          <XAxis
            type="number"
            stroke="#605E5C"
            fontSize={11}
            tickLine={false}
            label={{ value: 'Wait Time (ms)', position: 'bottom', offset: 0, fontSize: 10 }}
          />
          <YAxis
            type="category"
            dataKey="event"
            stroke="#605E5C"
            fontSize={11}
            tickLine={false}
            width={120}
            dx={-5}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: '#FFFFFF',
              border: '1px solid #EDEBE9',
              borderRadius: '6px',
              fontSize: '12px',
              boxShadow: 'var(--shadow-card)',
            }}
            formatter={(value, _name, props) => {
              const row = props.payload;
              const formattedVal = `${value} ms`;
              if (row.percentage !== undefined) {
                return [ `${formattedVal} (${row.percentage}%)`, 'Wait Time' ];
              }
              return [ formattedVal, 'Wait Time' ];
            }}
          />
          <Bar dataKey="time_ms" radius={[0, 4, 4, 0]} barSize={16}>
            {sortedData.map((_, index) => (
              <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
};
