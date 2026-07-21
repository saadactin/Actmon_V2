import React from 'react';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts';

export const RiskTrendChart = ({ data, height = 300 }) => {
  return (
    <div style={{ width: '100%', height }}>
      <ResponsiveContainer>
        <AreaChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 5 }}>
          <defs>
            {/* Custom linear gradient to transition from Green (Low) to Yellow/Orange (Medium) to Red (High) */}
            <linearGradient id="riskGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#A4262C" stopOpacity={0.8} />  {/* High Risk Red */}
              <stop offset="50%" stopColor="#D83B01" stopOpacity={0.6} /> {/* Medium Risk Orange */}
              <stop offset="95%" stopColor="#107C10" stopOpacity={0.2} /> {/* Low Risk Green */}
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#F3F2F1" />
          <XAxis
            dataKey="timestamp"
            stroke="#605E5C"
            fontSize={11}
            tickLine={false}
            dy={8}
          />
          <YAxis
            stroke="#605E5C"
            fontSize={11}
            tickLine={false}
            domain={[0, 100]}
            dx={-8}
            label={{ value: 'Risk Score', angle: -90, position: 'insideLeft', offset: 10, fontSize: 10, fill: '#605E5C' }}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: '#FFFFFF',
              border: '1px solid #EDEBE9',
              borderRadius: '6px',
              fontSize: '12px',
              boxShadow: 'var(--shadow-card)',
            }}
            formatter={(value) => [`${value} / 100`, 'Risk Score']}
          />
          <Area
            type="monotone"
            dataKey="score"
            stroke="#D83B01"
            strokeWidth={2}
            fill="url(#riskGradient)"
            activeDot={{ r: 6 }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
};
